# Untagged Vector Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `UntaggedContent` report untagged vector content, and give `AddBarcode` and `AddSVGObject` a way to declare their drawing tagged or decorative.

**Architecture:** `PathEvent` gains the `mcid`/`artifact` fields that `GlyphEvent` and `ImageEvent` already carry, populated from state already in `flushPath`'s closure scope; the rule then subscribes a third callback. Barcode and SVG share one marking helper in `structwrite.ts`, which already owns `allocContentMcid`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-05-untagged-vector-content-design.md`
**Issue:** `aspose-pdf-foss-for-ts-hdsx` (already claimed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, strict TypeScript.** Every import specifier carries the `.js` extension.
- **Task tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **A caller who passes no marking option gets byte-identical output.** The default is deliberately "emit nothing extra" — the whole point is that the validator becomes accurate, not that documents silently change.
- **Validate before allocating.** `validateMarkOptions` runs at the top of each producer, before anything is drawn or allocated, so a rejected call leaves the document byte-identical. This is the rule the whole `Add*` family follows.
- **Check typecheck's exit code directly** (`npm run typecheck; echo "EXIT=$?"`). Piping it through `tail` masks failures — that has already happened once in this repo.
- **Expect the full suite to surface producers this plan did not enumerate.** The spec's blast-radius table sampled eight; the suite covers far more fixtures. A newly-failing test elsewhere is a finding, not necessarily a bug in this change — read it before "fixing" it.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- Commit after every task. Do not push until the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/text.ts` (modify) | `PathEvent.mcid` / `.artifact`, populated in `flushPath` |
| `src/structvalidate.ts` (modify) | `UntaggedContent` subscribes `path`; message mentions vector |
| `src/structwrite.ts` (modify) | `MarkOptions`, `validateMarkOptions`, `markDrawing` — shared by both producers |
| `src/barcodeplace.ts` (modify) | `AddBarcodeOptions` gains `alt`/`artifact`; routes through `markDrawing` |
| `src/svgembed.ts` (modify) | `AddSVGOptions` gains `tag`/`alt`/`artifact`; routes through `markDrawing` |
| `test/untagged-vector.test.ts` (**create**) | `PathEvent` marking and the rule |
| `test/barcode.test.ts`, `test/svg-embed.test.ts` (modify) | the new options, per producer |
| `README.md`, `CLAUDE.md` (modify) | user-facing docs, architecture note |

**On the helper's home.** `structwrite.ts` already owns `allocContentMcid` and `tagAnnotation` — marking content against the structure tree is precisely its job. It does not import `pagecontent.ts` today and `pagecontent.ts` does not import it, so taking `wrapMarkedContent`/`wrapArtifact` from there adds no cycle.

---

### Task 1: `PathEvent` carries its marking, and the rule reads it

**Files:**
- Modify: `src/text.ts`, `src/structvalidate.ts`
- Create: `test/untagged-vector.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PathEvent.mcid?: number` and `PathEvent.artifact?: boolean` on the interface exported from `src/text.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/untagged-vector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

/** A tagged page with text to hang a structure tree off. */
function taggedDoc(): Document {
  const doc = Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 700 Td (Hello) Tj ET',
  ]));
  doc.Lang = 'en-US';
  doc.AutoTag();
  return doc;
}

/** Marking counts over every path paint on page 1. */
function paths(doc: Document) {
  let untagged = 0, tagged = 0, artifact = 0;
  visitContent(doc, doc.Pages[0], {
    path: (e) => {
      if (e.artifact) artifact++;
      else if (e.mcid !== undefined) tagged++;
      else untagged++;
    },
  });
  return { untagged, tagged, artifact };
}

const fires = (doc: Document) =>
  doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

describe('PathEvent carries its marked-content state', () => {
  it('reports a bare fill as untagged', () => {
    const doc = taggedDoc();
    doc.Pages[0].Graphics().setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill().apply();
    expect(paths(doc)).toEqual({ untagged: 1, tagged: 0, artifact: 0 });
  });

  it('reports a fill inside BeginArtifact as an artifact', () => {
    const doc = taggedDoc();
    const g = doc.Pages[0].Graphics();
    g.BeginArtifact();
    g.setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill();
    g.EndMarkedContent();
    g.apply();
    expect(paths(doc)).toEqual({ untagged: 0, tagged: 0, artifact: 1 });
  });

  it('reports a fill inside a BDC sequence as tagged, carrying its MCID', () => {
    const doc = taggedDoc();
    const root = doc.GetStructTree()!;
    const elem = root.Children[0].Append('Figure', { alt: 'a red square' });
    const g = doc.Pages[0].Graphics();
    g.BeginMarkedContent(elem.Type, elem.NextMcid(doc.Pages[0]));
    g.setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill();
    g.EndMarkedContent();
    g.apply();
    expect(paths(doc)).toEqual({ untagged: 0, tagged: 1, artifact: 0 });
  });
});

describe('UntaggedContent covers vector content', () => {
  it('fires for a bare fill on an otherwise clean tagged page', () => {
    const clean = taggedDoc();
    expect(fires(clean)).toBe(false); // baseline

    const doc = taggedDoc();
    doc.Pages[0].Graphics().setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill().apply();
    expect(fires(doc)).toBe(true);
  });

  it('stays silent when the same fill is an artifact', () => {
    const doc = taggedDoc();
    const g = doc.Pages[0].Graphics();
    g.BeginArtifact();
    g.setFillColor([1, 0, 0]).rect(10, 10, 50, 50).fill();
    g.EndMarkedContent();
    g.apply();
    expect(fires(doc)).toBe(false);
  });

  it('still reads the redaction marker box as an artifact', () => {
    // Regression guard on nmjf: the one producer already doing this correctly.
    const doc = taggedDoc();
    doc.Pages[0].Redact([[40, 690, 200, 720]]);
    expect(paths(doc).artifact).toBe(1);
    expect(fires(doc)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/untagged-vector.test.ts`
Expected: FAIL — every `paths()` assertion reports `{untagged: 0, tagged: 0, artifact: 0}` because `PathEvent` has no `mcid`/`artifact` (TypeScript will also reject `e.artifact`), and the rule does not fire for a bare fill.

- [ ] **Step 3: Add the fields to `PathEvent`**

In `src/text.ts`, extend the interface:

```ts
export interface PathEvent {
  addr: ContentAddr;
  segments: [number, number, number, number][];
  stroke: boolean;
  fill: boolean;
  lineWidth: number;
  /** The innermost active marked-content MCID when this path was painted,
   *  or undefined outside any MCID-bearing marked-content sequence. */
  mcid?: number;
  /** True when this path was painted inside an /Artifact marked-content scope. */
  artifact?: boolean;
}
```

- [ ] **Step 4: Populate them in `flushPath`**

`flushPath` is a closure inside `walkScope`, so `activeMcid` and `inArtifact` are already in scope — the same values `emitGlyphs` and `emitImage` receive. Extend the emit:

```ts
    if (segs.length && ctx.visitor.path)
      ctx.visitor.path({
        addr, segments: segs, stroke, fill,
        lineWidth: stroke ? lineWidth * vscale(curCtm) : 0,
        mcid: activeMcid, artifact: inArtifact || undefined,
      });
```

`inArtifact || undefined` rather than the raw boolean, matching `emitImage`'s
existing convention so an unmarked event omits the key entirely.

- [ ] **Step 5: Subscribe the rule**

In `src/structvalidate.ts`, extend the `UntaggedContent` block:

```ts
  // UntaggedContent — page content that is neither tagged (mcid) nor artifacted.
  for (const page of doc.Pages) {
    let untagged = false;
    visitContent(doc, page, {
      glyph: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
      image: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
      path: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
    });
    if (untagged) {
      issues.push({
        rule: 'UntaggedContent', severity: 'warning', clause: 'Matterhorn 01-006', page,
        message: 'Page has visible content (text, image or vector) that is neither tagged nor marked as an artifact.',
      });
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/untagged-vector.test.ts`
Expected: PASS, all six.

- [ ] **Step 7: Run the full suite — this is the blast-radius check**

Run: `npm test`

This rule now reports more, so fixtures across the suite may newly fail. **Read
each failure before changing anything.** For each, decide which it is:

- a test asserting `Passed === true` or an exact issue list on a document that
  genuinely draws untagged vector content — the assertion was relying on the
  false negative, and updating it is correct;
- a producer that should be marking its output and is not — note it, do not fix
  it here; Tasks 2 and 3 cover barcode and SVG, and anything else belongs in its
  own issue.

Record what you found in the commit message. If more than three unrelated
producers surface, stop and report rather than pressing on.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/text.ts src/structvalidate.ts test/untagged-vector.test.ts
git commit -m "fix(validate): UntaggedContent covers vector content (hdsx)"
```

---

### Task 2: The shared marking helper, and `AddBarcode`

**Files:**
- Modify: `src/structwrite.ts`, `src/barcodeplace.ts`
- Modify: `test/barcode.test.ts`

**Interfaces:**
- Consumes: `wrapMarkedContent(tag: string, mcid: number, body: Uint8Array): Uint8Array` and `wrapArtifact(body: Uint8Array): Uint8Array` from `src/pagecontent.js`; `allocContentMcid(doc, element, page): number` already in `structwrite.ts`.
- Produces, exported from `src/structwrite.ts`:
  - `interface MarkOptions { tag?: StructElement; alt?: string; artifact?: boolean }`
  - `validateMarkOptions(opts: MarkOptions): void` — throws `TypeError`, allocates nothing
  - `markDrawing(doc: Document, page: Page, body: Uint8Array, opts: MarkOptions): Uint8Array`

- [ ] **Step 1: Write the failing tests**

Append to `test/barcode.test.ts`. Check the top of that file for how it builds a
document and reads page content, and reuse those helpers rather than adding new
ones:

```ts
describe('AddBarcode structure marking', () => {
  function taggedDoc(): Document {
    const doc = Document.Open(buildBlankPage());
    doc.Lang = 'en-US';
    doc.CreateStructTree().Append('Document');
    return doc;
  }
  const body = (doc: Document) =>
    new TextDecoder('latin1').decode(doc.Pages[0].Contents);
  const fires = (doc: Document) =>
    doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

  it('emits nothing extra by default, and the validator says so', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60]);
    const s = body(doc);
    expect(s).not.toContain('BDC');
    expect(s).not.toContain('BMC');
    expect(fires(doc)).toBe(true); // accurate, not a false negative
  });

  it('wraps as an artifact when asked', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { artifact: true });
    expect(body(doc)).toContain('/Artifact BMC');
    expect(fires(doc)).toBe(false);
  });

  it('creates a /Figure carrying /Alt when given alt', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { alt: 'Order 12345' });
    expect(body(doc)).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    expect(doc.GetStructTree()!.GetText()).toBeDefined();
    expect(fires(doc)).toBe(false);
  });

  it('uses the caller\'s element when given tag, ignoring alt', () => {
    const doc = taggedDoc();
    const elem = doc.GetStructTree()!.Children[0].Append('Figure', { alt: 'mine' });
    doc.Pages[0].AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { tag: elem, alt: 'ignored' });
    expect(body(doc)).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    // Only the caller's element exists — alt did not create a second one.
    expect(doc.GetStructTree()!.Children[0].Children.filter((c) => c.Type === 'Figure'))
      .toHaveLength(1);
  });

  it('throws when artifact contradicts alt, drawing nothing', () => {
    const doc = taggedDoc();
    const before = body(doc);
    expect(() => doc.Pages[0].AddBarcode(
      { type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60],
      { artifact: true, alt: 'x' },
    )).toThrow(TypeError);
    expect(body(doc)).toBe(before);
  });

  it('ignores alt on an untagged document instead of throwing', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => doc.Pages[0].AddBarcode(
      { type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60], { alt: 'x' },
    )).not.toThrow();
    expect(body(doc)).not.toContain('BDC');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/barcode.test.ts`
Expected: FAIL — `artifact` and `alt` are not known options (a TypeScript error), and no marking is emitted.

- [ ] **Step 3: Add the helper to `structwrite.ts`**

Add the import:

```ts
import { wrapMarkedContent, wrapArtifact } from './pagecontent.js';
```

and this block (place it beside `allocContentMcid`, which it uses):

```ts
/** How a producer's drawing should be marked in a tagged document. */
export interface MarkOptions {
  /** Tag the drawing into this existing element. Wins over `alt`. */
  tag?: StructElement;
  /** Create a /Figure carrying this /Alt and tag the drawing into it. */
  alt?: string;
  /** Mark the drawing as an /Artifact — decoration that carries no meaning. */
  artifact?: boolean;
}

/** Validate a marking choice. Throws before the caller allocates anything, so a
 *  rejected call leaves the document byte-identical. */
export function validateMarkOptions(opts: MarkOptions): void {
  if (opts.artifact !== undefined && typeof opts.artifact !== 'boolean')
    throw new TypeError('artifact must be a boolean');
  if (opts.alt !== undefined && typeof opts.alt !== 'string')
    throw new TypeError('alt must be a string');
  if (opts.artifact && (opts.tag !== undefined || opts.alt !== undefined))
    throw new TypeError('artifact cannot be combined with tag or alt');
}

/** Wrap `body` according to `opts`: the caller's element, else a fresh /Figure
 *  carrying `alt`, else an /Artifact, else unchanged.
 *
 *  `tag` wins over `alt`: the caller supplied a specific element, and quietly
 *  re-parenting their content under a fresh /Figure would be the more surprising
 *  reading. An `alt` on an untagged document is ignored rather than thrown —
 *  there is no tree to attach to, and failing the draw would be worse than
 *  ignoring the hint. `artifact` needs no tree, so it is honoured either way. */
export function markDrawing(
  doc: Document, page: Page, body: Uint8Array, opts: MarkOptions,
): Uint8Array {
  if (opts.tag !== undefined)
    return wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body);

  if (opts.alt !== undefined) {
    const root = doc.GetStructTree();
    if (root === null) return body; // untagged document: nothing to attach to
    const parent = root.Children[0];
    const elem = parent !== undefined
      ? parent.Append('Figure', { alt: opts.alt })
      : root.Append('Figure', { alt: opts.alt });
    return wrapMarkedContent(elem.Type, allocContentMcid(doc, elem, page), body);
  }

  if (opts.artifact) return wrapArtifact(body);
  return body;
}
```

`Append`'s second parameter is `ElemOpts`, which is declared in `structwrite.ts`
itself (`alt` maps to `/Alt` via `OPT_KEYS`) — so this needs no extra import.
`StructElement` is already a type-only import in this file, and calling `.Append`
on it stays type-level, so no runtime cycle with `struct.ts` is introduced.

- [ ] **Step 4: Wire `AddBarcode`**

In `src/barcodeplace.ts`, extend the options:

```ts
  /** Tag the drawing into the logical structure tree (marked content). */
  tag?: StructElement;
  /** Create a /Figure carrying this /Alt and tag the drawing into it. Ignored
   *  when `tag` is given, and on a document with no structure tree. */
  alt?: string;
  /** Mark the drawing as an /Artifact — decoration carrying no meaning. Cannot
   *  be combined with `tag` or `alt`. */
  artifact?: boolean;
```

Add `validateMarkOptions` and `markDrawing` to the `./structwrite.js` import,
call the validator at the very top of `addBarcode` — before any drawing or
allocation — and replace the tail:

```ts
  appendContent(doc, page, markDrawing(doc, page, body, opts));
```

deleting the `const tagged = opts.tag ? … : body;` it replaces. `AddBarcodeOptions`
now structurally satisfies `MarkOptions`, so `opts` passes straight through.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/barcode.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/structwrite.ts src/barcodeplace.ts test/barcode.test.ts
git commit -m "feat(barcode): tag/alt/artifact marking via a shared helper (hdsx)"
```

---

### Task 3: `AddSVGObject`

**Files:**
- Modify: `src/svgembed.ts`
- Modify: `test/svg-embed.test.ts`

**Interfaces:**
- Consumes: `MarkOptions`, `validateMarkOptions`, `markDrawing` from `src/structwrite.js` (Task 2).
- Produces: `AddSVGOptions` gains `tag?: StructElement`, `alt?: string`, `artifact?: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-embed.test.ts`, reusing that file's existing document and
content helpers:

```ts
describe('AddSVGObject structure marking', () => {
  const SVG = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    '<rect width="10" height="10" fill="red"/></svg>');

  function taggedDoc(): Document {
    const doc = Document.Open(buildBlankPage());
    doc.Lang = 'en-US';
    doc.CreateStructTree().Append('Document');
    return doc;
  }
  const body = (doc: Document) =>
    new TextDecoder('latin1').decode(doc.Pages[0].Contents);
  const fires = (doc: Document) =>
    doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

  it('emits nothing extra by default, and the validator says so', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddSVGObject(SVG, [100, 100, 80, 80]);
    const s = body(doc);
    expect(s).not.toContain('BDC');
    expect(s).not.toContain('BMC');
    expect(fires(doc)).toBe(true);
  });

  it('wraps as an artifact when asked', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddSVGObject(SVG, [100, 100, 80, 80], { artifact: true });
    expect(body(doc)).toContain('/Artifact BMC');
    expect(fires(doc)).toBe(false);
  });

  it('creates a /Figure carrying /Alt when given alt', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddSVGObject(SVG, [100, 100, 80, 80], { alt: 'a red square' });
    expect(body(doc)).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    expect(fires(doc)).toBe(false);
  });

  it('uses the caller\'s element when given tag', () => {
    const doc = taggedDoc();
    const elem = doc.GetStructTree()!.Children[0].Append('Figure', { alt: 'mine' });
    doc.Pages[0].AddSVGObject(SVG, [100, 100, 80, 80], { tag: elem });
    expect(body(doc)).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    expect(fires(doc)).toBe(false);
  });

  it('throws when artifact contradicts alt, drawing nothing', () => {
    const doc = taggedDoc();
    const before = body(doc);
    expect(() => doc.Pages[0].AddSVGObject(SVG, [100, 100, 80, 80],
      { artifact: true, alt: 'x' })).toThrow(TypeError);
    expect(body(doc)).toBe(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-embed.test.ts`
Expected: FAIL — `tag`, `alt` and `artifact` are not known `AddSVGOptions` keys.

- [ ] **Step 3: Extend `AddSVGOptions`**

In `src/svgembed.ts`, add to the interface:

```ts
  /** Tag the drawing into the logical structure tree (marked content). */
  tag?: StructElement;
  /** Create a /Figure carrying this /Alt and tag the drawing into it. Ignored
   *  when `tag` is given, and on a document with no structure tree. */
  alt?: string;
  /** Mark the drawing as an /Artifact — decoration carrying no meaning. Cannot
   *  be combined with `tag` or `alt`. */
  artifact?: boolean;
```

Add the imports:

```ts
import { validateMarkOptions, markDrawing } from './structwrite.js';
import type { StructElement } from './struct.js';
```

- [ ] **Step 4: Wire `addSvgObject`**

Call the validator beside the existing `rect` validation at the top of
`addSvgObject`, so a contradictory pair is rejected before anything is parsed or
allocated — the function's own doc comment already promises that a rejected call
leaves the document byte-identical:

```ts
  validateMarkOptions(opts);
```

Then wrap the final append:

```ts
  const [x, y, w, h] = rect;
  const drawn = enc(
    `q\n${num(x)} ${num(y)} ${num(w)} ${num(h)} re\nW n\n` +
    `${m.map(num).join(' ')} cm\n/${key} Do\nQ`);
  appendContent(doc, page, markDrawing(doc, page, drawn, opts));
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/svg-embed.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 6: Run the SVG suites for regressions**

Run: `npx vitest run test/svg-embed.test.ts test/svg-embed-image.test.ts test/svg-filter-fast.test.ts test/svg-draw.test.ts test/svg-bbox.test.ts test/svg-css.test.ts`
Expected: PASS. No default behaviour changed, so any failure here means the wrap
is being applied when no option was given.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/svgembed.ts test/svg-embed.test.ts
git commit -m "feat(svg): tag/alt/artifact marking for AddSVGObject (hdsx)"
```

---

### Task 4: Documentation and wrap-up

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Produces no new names.

- [ ] **Step 1: Document the two new option sets in the README**

Wherever `AddBarcode`'s and `AddSVGObject`'s options are described, add the
marking vocabulary. Use this wording once, adapted to each:

```markdown
In a tagged document, pass `alt` to have the drawing tagged as a `/Figure`
carrying that alternate text, `tag` to place it under a structure element you
already hold, or `artifact: true` to declare it decoration. With none of them the
drawing is emitted unmarked and `ValidatePdfUa` reports `UntaggedContent` — only
you know whether a given graphic carries meaning, so the library does not guess.
`artifact` cannot be combined with `tag` or `alt`.
```

- [ ] **Step 2: Note the PageGraphics position in the README**

Where `PageGraphics` is documented, add:

```markdown
`PageGraphics` draws unmarked content. In a tagged document that is reported by
`ValidatePdfUa` as `UntaggedContent`, which is correct: wrap decoration in
`BeginArtifact()` … `EndMarkedContent()`, and meaningful content in
`BeginMarkedContent(type, element.NextMcid(page))`.
```

- [ ] **Step 3: Update CLAUDE.md**

In the validators bullet, record what the rule now covers and why the default is
what it is:

```
  **Invariant:** `UntaggedContent` covers text, images *and* vector paths.
  `PathEvent` carries `mcid`/`artifact` for exactly this; before it did, the rule
  could not subscribe and silently under-reported every untagged fill and stroke.
  **Invariant:** a producer that draws vector content never guesses its own
  marking. `AddBarcode`/`AddSVGObject` take `tag`/`alt`/`artifact` and default to
  none, leaving output byte-identical and letting the validator report honestly.
  Artifacting by default would declare a barcode decorative and hide the data it
  encodes; auto-tagging a `/Figure` without an `/Alt` merely trades
  `UntaggedContent` for `IllustrationAlt`.
```

- [ ] **Step 4: Run the full suite and typecheck**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
npm test
```
Expected: both green. Do not proceed on a red suite.

- [ ] **Step 5: File tagged table authoring**

```bash
bd create "Tagged table authoring for page.AddTable" \
  -t feature -p 3 \
  -d "AddTable emits untagged cell text, so a tagged document containing one fails ValidatePdfUa's UntaggedContent today — before and independently of hdsx, which covered vector paths. Artifacting the borders would not silence it: the trigger is the text. What it needs is a { tagged: true } mode emitting /Table > /TR > /TD (and /TH for repeating header rows, which setRepeatingRowsCount already models), with borders and cell backgrounds as artifacts. Comparable in size to flow.ts's tagged mode; tablestruct.ts already models the same tree on the extraction side and is the reference for the shape."
```

- [ ] **Step 6: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-hdsx
git add .beads/          # .beads/ is tracked in this repo
git commit -m "chore(bd): close hdsx, file tagged table authoring"
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| `PathEvent.mcid` / `.artifact` | 1 |
| `UntaggedContent` subscribes `path`; message mentions vector | 1 |
| `tag` / `alt` / `artifact` vocabulary | 2 (helper + barcode), 3 (SVG) |
| Default is "nothing", output byte-identical | 2 and 3 (a test each) |
| `tag` wins over `alt` | 2 (helper + test) |
| `artifact` + `tag`/`alt` throws, allocates nothing | 2 and 3 (a test each) |
| `alt` on an untagged document is ignored, not thrown | 2 |
| `artifact` on an untagged document is honoured | 2 (helper: `wrapArtifact` needs no tree) |
| `/Figure` attaches under `root.Children[0]`, else root | 2 (helper) |
| SVG gains `tag` as well as `alt`/`artifact` | 3 |
| `PageGraphics` — docs only | 4 |
| Redaction marker box regression guard | 1 |
| Full-suite blast-radius check | 1 (Step 7), 4 (Step 4) |
| Tagged table authoring filed separately | 4 |

No gaps.

**Type consistency:** `MarkOptions` is defined in Task 2 and consumed in Task 3;
`AddBarcodeOptions` and `AddSVGOptions` each structurally satisfy it, which is
what lets both pass `opts` straight to `markDrawing(doc, page, body, opts)`.
`validateMarkOptions(opts): void` and `markDrawing(doc, page, body, opts): Uint8Array`
keep one signature across both tasks. `PathEvent.mcid`/`.artifact` are defined in
Task 1 and read by the Task 1 tests only.

**Two places the plan says to verify rather than assume:** Tasks 2 and 3 Step 1
both say to reuse the existing test files' document/content helpers rather than
adding new ones; Task 1 Step 7 says to read each newly-failing suite and classify
it rather than reflexively fixing it, and to stop and report if more than three
unrelated producers surface.

**The riskiest step is Task 1 Step 7**, and it is deliberately not a mechanical
instruction. Widening a validator rule changes results for fixtures nobody
enumerated, and the right response differs per failure: a test that asserted
`Passed === true` on a document genuinely drawing untagged vector content was
relying on the false negative and should be updated, whereas a producer that
ought to be marking its output is a finding for its own issue. Blanket-updating
assertions to green would discard exactly the signal this change exists to
produce.
