# Redaction Overlay Tagging Implementation Plan

> **Correction, 2026-08-05 (added after execution; the body below is left as
> written).** This plan states in three places — the Global Constraints bullet
> "The marker box is invisible to `ValidatePdfUa`", a test comment in Task 2, and
> the CLAUDE.md note it tells you to write — that `UntaggedContent` walks glyph
> and image events only and cannot see path fills. **That is no longer true.**
> `hdsx` gave `PathEvent` its `mcid`/`artifact` fields and subscribed a `path`
> callback in `structvalidate.ts`, so an unartifacted marker box *does* fire the
> rule. Verified by mutation: dropping the `BeginArtifact` in
> `paintRedactionBoxes` turns `redact-tagging.test.ts` and
> `untagged-vector.test.ts` red on their `UntaggedContent` assertions.
>
> The instruction "Do not write a validator-based test for the box and assume it
> proves anything" should therefore **not** be followed as written. The
> content-stream assertion the plan calls for is still worth keeping, but for a
> different reason: the validator reports only that *something* on the page is
> unmarked, so it cannot distinguish a missed marker box from a missed overlay.
> CLAUDE.md's redaction note carries the corrected wording (issue `p7se`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop redaction from adding untagged content to a tagged document: the marker box becomes an `/Artifact`, and the overlay text (and an `/RO` overlay form) become a real `/P` structure element.

**Architecture:** `doc.GetStructTree()` returning null is the single tagged/untagged switch — an untagged document's output stays byte-identical. `paintRedactOverlay` delegates its fill to `paintRedactionBoxes`, so the artifact rule lives in one place instead of two.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-05-redact-overlay-tagging-design.md`
**Issue:** `aspose-pdf-foss-for-ts-nmjf` (already claimed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext, strict TypeScript.** Every import specifier carries the `.js` extension.
- **Task tracking is `bd`.** Do NOT use TodoWrite, TaskCreate, or markdown TODO lists.
- **Untagged documents must be unaffected.** `doc.GetStructTree() === null` takes the existing code path unchanged. No `BDC`, no `BMC`, no new objects.
- **The marker box is invisible to `ValidatePdfUa`.** Its `UntaggedContent` rule walks glyph and image events only, not path fills, so the artifact wrapping must be asserted on the content stream. Do not write a validator-based test for the box and assume it proves anything.
- **Assert the full issue set, not just the absence of one rule.** A change that silenced unrelated rules would be a regression wearing a fix's clothes.
- **Check typecheck's exit code directly** (`npm run typecheck; echo "EXIT=$?"`). Piping it through `tail` masks failures — that has already happened once in this repo.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- Commit after every task. Do not push until the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/graphics.ts` (modify) | `PageGraphics.BeginArtifact()` |
| `src/redact.ts` (modify) | `paintRedactionBoxes` artifacts its fill when the document is tagged |
| `src/redactapply.ts` (modify) | fill delegated to `paintRedactionBoxes`; overlay text and the `/RO` form tagged as `/P` |
| `test/graphics.test.ts` (modify) | `BeginArtifact` emits `/Artifact BMC` |
| `test/redact-tagging.test.ts` (**create**) | the feature, via `ValidatePdfUa` and the content stream |
| `README.md`, `CLAUDE.md` (modify) | user-facing docs, architecture note |

---

### Task 1: `PageGraphics.BeginArtifact()`

`BeginMarkedContent(tag, mcid)` emits `/<tag> <</MCID n>> BDC`. An artifact is `/Artifact BMC` — no dictionary, and `BMC` rather than `BDC` — so it needs its own method.

**Files:**
- Modify: `src/graphics.ts`
- Modify: `test/graphics.test.ts`

**Interfaces:**
- Consumes: the existing `EndMarkedContent(): this`, which emits `EMC`.
- Produces: `PageGraphics.BeginArtifact(): this` emitting `/Artifact BMC`.

- [ ] **Step 1: Write the failing test**

Append to `test/graphics.test.ts`. Match the file's existing way of building a `PageGraphics` and reading back the page content — check the top of that file for its helper (it opens a fixture document and inflates `page.Contents`) and reuse it rather than inventing a second one:

```ts
describe('PageGraphics.BeginArtifact', () => {
  it('emits /Artifact BMC and pairs with EndMarkedContent', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const g = new PageGraphics(doc, page);
    g.BeginArtifact();
    g.setFillColor([0, 0, 0]).rect(10, 10, 50, 20).fill();
    g.EndMarkedContent();
    g.apply();

    const body = new TextDecoder('latin1').decode(page.Contents);
    expect(body).toContain('/Artifact BMC');
    expect(body).toContain('EMC');
    // An artifact carries no MCID — that is what distinguishes it from
    // BeginMarkedContent, whose sequence is /<tag> <</MCID n>> BDC.
    expect(body).not.toContain('/Artifact <<');
    expect(body.indexOf('/Artifact BMC')).toBeLessThan(body.indexOf(' re'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/graphics.test.ts`
Expected: FAIL — `g.BeginArtifact is not a function`.

- [ ] **Step 3: Implement**

In `src/graphics.ts`, directly after `BeginMarkedContent`:

```ts
  /** Begin an artifact sequence: `/Artifact BMC`, marking the following ops as
   *  content that belongs to no structure element. Pair with
   *  {@link EndMarkedContent}. In a tagged page every piece of content must be
   *  either tagged or an artifact, and decoration is the latter. */
  BeginArtifact(): this {
    return this.op('/Artifact BMC');
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/graphics.test.ts`
Expected: PASS, all suites in the file.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/graphics.ts test/graphics.test.ts
git commit -m "feat(graphics): PageGraphics.BeginArtifact (nmjf)"
```

---

### Task 2: The marker box is an artifact in a tagged document

**Files:**
- Modify: `src/redact.ts`, `src/redactapply.ts`
- Create: `test/redact-tagging.test.ts`

**Interfaces:**
- Consumes: `PageGraphics.BeginArtifact()` (Task 1); `doc.GetStructTree(): StructTreeRoot | null`.
- Produces: `paintRedactionBoxes(doc, page, rects, color?)` keeps its signature and gains the artifact wrapping. `paintRedactOverlay` no longer paints its own fill.

- [ ] **Step 1: Write the failing tests**

Create `test/redact-tagging.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

const REGION: [number, number, number, number] = [40, 80, 260, 140];

/** A tagged document: AutoTag builds the tree and tags the existing content. */
function taggedDoc(): Document {
  const doc = Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 100 Td (PageSecret) Tj ET',
  ]));
  doc.AutoTag();
  return doc;
}

/** An untagged document with the same content. */
function plainDoc(): Document {
  return Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 100 Td (PageSecret) Tj ET',
  ]));
}

const content = (doc: Document) =>
  new TextDecoder('latin1').decode(doc.Pages[0].Contents);

describe('redaction marker box tagging', () => {
  it('wraps the marker box as an artifact in a tagged document', () => {
    // ValidatePdfUa cannot see this: its UntaggedContent rule walks glyph and
    // image events, not path fills. Assert on the stream.
    const doc = taggedDoc();
    doc.Pages[0].Redact([REGION]);
    expect(content(doc)).toContain('/Artifact BMC');
  });

  it('leaves an untagged document exactly as it was', () => {
    const doc = plainDoc();
    doc.Pages[0].Redact([REGION]);
    const body = content(doc);
    expect(body).not.toContain('BMC');
    expect(body).not.toContain('BDC');
  });

  it('artifacts the fill on the ApplyRedactions path too', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, fill: [0, 0, 1] });
    doc.Pages[0].ApplyRedactions();
    const body = content(doc);
    expect(body).toContain('/Artifact BMC');
    expect(body).toContain('0 0 1 rg'); // still the mark's own /IC colour
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-tagging.test.ts`
Expected: FAIL on the two tagged cases — no `/Artifact BMC` is emitted. The untagged case passes already, which is correct: it is a regression guard, not a new behaviour.

- [ ] **Step 3: Artifact the box in `redact.ts`**

Replace `paintRedactionBoxes`:

```ts
/** Paint an opaque filled rectangle (default black) over each region as the
 *  visible redaction marker. Appended last so it sits on top of any remaining
 *  content. Independent of the removal logic.
 *
 *  In a tagged document the fill is wrapped as an /Artifact: it is decoration,
 *  and a tagged page may carry no content that is neither tagged nor
 *  artifacted. Our own UntaggedContent rule walks glyphs and images rather than
 *  path fills, so it cannot see this either way — correctness here is asserted
 *  on the content stream, not through the validator. */
export function paintRedactionBoxes(
  doc: Document, page: Page, rects: Rect[], color: [number, number, number] = [0, 0, 0],
): void {
  if (rects.length === 0) return;
  const tagged = doc.GetStructTree() !== null;
  const g = new PageGraphics(doc, page);
  if (tagged) g.BeginArtifact();
  g.setFillColor(color);
  for (const r of rects) {
    const [x0, y0, x1, y1] = norm(r);
    g.rect(x0, y0, x1 - x0, y1 - y0).fill();
  }
  if (tagged) g.EndMarkedContent();
  g.apply();
}
```

- [ ] **Step 4: Delegate the overlay's fill in `redactapply.ts`**

`paintRedactOverlay` inlines a fill whose geometry is character-for-character what `paintRedactionBoxes` does, and that function already takes a colour. Delegating keeps the artifact rule in one place.

Add `paintRedactionBoxes` to the existing `./redact.js` import, then replace the fill block at the top of `paintRedactOverlay`:

```ts
  const fill = annot.InteriorColor ?? [0, 0, 0];
  const boxes = rects.map(normRect);
  // Delegated rather than inlined: paintRedactionBoxes draws the same geometry
  // and owns the /Artifact wrapping, so both redaction paths share one rule.
  paintRedactionBoxes(doc, page, boxes, fill);
```

Delete the `PageGraphics` fill loop it replaces. `PageGraphics` may become an unused import in this file — remove it if so; `normRect` is still used by the text placement below.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/redact-tagging.test.ts`
Expected: PASS, all three.

- [ ] **Step 6: Run the redaction suites for regressions**

Run: `npx vitest run test/redact.test.ts test/redact-box.test.ts test/redact-image.test.ts test/redact-sanitize.test.ts test/redact-search.test.ts test/redact-text.test.ts test/redact-apply.test.ts test/redact-annots.test.ts test/redact-annot.test.ts`
Expected: PASS. These are what prove the delegation did not change untagged output — every one of those fixtures is untagged.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/redact.ts src/redactapply.ts test/redact-tagging.test.ts
git commit -m "feat(redact): marker box is an /Artifact in a tagged document (nmjf)"
```

---

### Task 3: The overlay text and the `/RO` form are tagged `/P`

**Files:**
- Modify: `src/redactapply.ts`
- Modify: `test/redact-tagging.test.ts`

**Interfaces:**
- Consumes: `doc.GetStructTree(): StructTreeRoot | null`; `StructTreeRoot.Children: StructElement[]`; `StructTreeRoot.Append(type, opts?): StructElement` and the same method on `StructElement`; `stampText`'s existing `tag?: StructElement` option, which routes through `markContent` to emit `/<Type> <</MCID n>> BDC … EMC`; `wrapMarkedContent(tag: string, mcid: number, body: Uint8Array): Uint8Array` and `allocContentMcid(doc, element, page): number`.
- Produces: no new exported names.

- [ ] **Step 1: Write the failing tests**

Append to `test/redact-tagging.test.ts`:

```ts
/** Rule ids reported by ValidatePdfUa, in order. */
const rules = (doc: Document) => doc.ValidatePdfUa().Issues.map((i) => i.rule);

describe('redaction overlay text tagging', () => {
  it('no longer reports UntaggedContent, and reports nothing else new', () => {
    const before = rules(taggedDoc());
    expect(before).not.toContain('UntaggedContent'); // baseline sanity

    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();

    // Assert the whole set: silencing unrelated rules would be a regression
    // wearing a fix's clothes.
    expect(rules(doc)).toEqual(before);
  });

  it('puts the overlay text in the structure tree under /Document', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();

    const root = doc.GetStructTree()!;
    const docElem = root.Children[0];
    // A /P was added under /Document, not beside it.
    expect(docElem.Children.some((c) => c.Type === 'P')).toBe(true);
    // And the text is genuinely reachable through the tree. GetText lives on
    // StructTreeRoot, not StructElement — do not call it on an element.
    expect(root.GetText()).toContain('REDACTED');
  });

  it('emits a /P marked-content sequence around the overlay text', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();
    expect(content(doc)).toMatch(/\/P <<\/MCID \d+>> BDC/);
  });

  it('emits nothing marked in an untagged document', () => {
    const doc = plainDoc();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'REDACTED' });
    doc.Pages[0].ApplyRedactions();
    const body = content(doc);
    expect(body).toContain('(REDACTED) Tj'); // still drawn
    expect(body).not.toContain('BDC');
    expect(body).not.toContain('BMC');
  });

  it('tags an /RO overlay form as /P too', () => {
    // /RO takes precedence over /IC + /OverlayText, so it plays the overlay's
    // role and gets the overlay's treatment.
    const doc = taggedDoc();
    const mark = doc.Pages[0].AddRedact({ rect: REGION });
    const form = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 160, 20]],
      ]),
      raw: new TextEncoder().encode('0 1 0 rg 0 0 160 20 re f'),
    });
    mark.Dict.set('RO', form);

    doc.Pages[0].ApplyRedactions();
    const body = content(doc);
    expect(body).toMatch(/\/P <<\/MCID \d+>> BDC/);
    expect(body).toContain(' Do');
    expect(rules(doc)).not.toContain('UntaggedContent');
  });
});
```

Add to this file's imports: `import { name, type PdfObject } from '../src/types.js';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/redact-tagging.test.ts`
Expected: FAIL — no `/P … BDC` is emitted, the structure tree gains no `/P`, and `rules(doc)` contains an extra `UntaggedContent` that the baseline does not.

- [ ] **Step 3: Add the element helper**

In `src/redactapply.ts`, add the imports:

```ts
import { wrapMarkedContent } from './pagecontent.js';
import { allocContentMcid } from './structwrite.js';
import type { StructElement } from './struct.js';
```

and this helper above `paintOverlayForm`:

```ts
/** A fresh /P for one region's overlay, or undefined when the document is not
 *  tagged — an untagged document has no tree to attach to, and emitting an
 *  /MCID with no /StructTreeRoot would be worse than leaving the content plain.
 *
 *  /P rather than /Span: /Span is inline-level content that PDF/UA expects
 *  inside a block-level parent, so a bare /Span at the top of the tree would
 *  silence our warning while creating a subtler structural problem. The overlay
 *  is a short standalone paragraph replacing removed content.
 *
 *  Attached under the root's first child (the /Document element AutoTag and
 *  CreateStructTree produce) when there is one, so the result is
 *  /Document > /P rather than a /P sitting beside /Document. */
function overlayElement(doc: Document): StructElement | undefined {
  const root = doc.GetStructTree();
  if (root === null) return undefined;
  const parent = root.Children[0];
  return parent !== undefined ? parent.Append('P') : root.Append('P');
}
```

- [ ] **Step 4: Tag the overlay text**

In `paintRedactOverlay`, after the `const opts = { … }` line that builds the `stampText` options, attach the element:

```ts
  const elem = overlayElement(doc);
  const opts = {
    font: 'Helvetica' as const, fontSize: size, color, align,
    ...(elem !== undefined ? { tag: elem } : {}),
  };
```

`markContent` inside `stampText` does the rest: with `tag` set it emits
`/P <</MCID n>> BDC … EMC` and registers the MCID against the element.

Leave the `{ ...opts, align: 'left' }` spread in the `/Repeat` tiling branch as it
is — it inherits `tag`, so every tiled draw is tagged under the same element.

- [ ] **Step 5: Tag the `/RO` draw**

In `paintOverlayForm`, replace the `appendContent` call:

```ts
  const body = new TextEncoder().encode(
    `q ${place.map(num).join(' ')} cm /${key} Do Q\n`);
  const elem = overlayElement(doc);
  // /RO is the overlay — §12.5.6.23 gives it precedence over /IC and
  // /OverlayText — so it gets the overlay's treatment. We cannot inspect
  // foreign artwork, and over-describing it as a paragraph beats hiding it
  // from assistive technology behind an /Artifact.
  appendContent(doc, page, elem !== undefined
    ? wrapMarkedContent(elem.Type, allocContentMcid(doc, elem, page), body)
    : body);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/redact-tagging.test.ts`
Expected: PASS, all eight in the file.

- [ ] **Step 7: Run the redaction and structure suites for regressions**

Run: `npx vitest run test/redact.test.ts test/redact-apply.test.ts test/redact-annots.test.ts test/struct-write.test.ts test/struct-mark-content.test.ts test/structvalidate.test.ts`
Expected: PASS. If `test/structvalidate.test.ts` does not exist under that name, run whichever test file covers `ValidatePdfUa` — find it with `grep -rl ValidatePdfUa test/`.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
git add src/redactapply.ts test/redact-tagging.test.ts
git commit -m "feat(redact): overlay text and /RO form are tagged /P (nmjf)"
```

---

### Task 4: Documentation and wrap-up

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Produces no new names.

- [ ] **Step 1: Replace the README limitation**

The mark-and-apply section ends with a line reading "The remaining limitation: the painted overlay is untagged content." That is now false. Replace it with:

```markdown
In a tagged document the overlay is tagged too: the marker box is wrapped as an
`/Artifact` (it is decoration) and the overlay text becomes a `/P` element, so a
screen-reader user is told the region was redacted rather than meeting a silent
gap. An untagged document is unaffected.
```

- [ ] **Step 2: Update CLAUDE.md**

Add to the redaction bullet, beside the invariants already there:

```
  **Invariant:** redaction's own ink is tagged in a tagged document — the marker
  box as an `/Artifact`, the overlay text and any `/RO` form as a `/P`. The text
  is *tagged, not artifacted*: `/Artifact` would silence the `UntaggedContent`
  warning by declaring "REDACTED" decorative, so assistive technology would skip
  it and a screen-reader user would never learn the region was redacted.
  `doc.GetStructTree() === null` is the whole switch; untagged output is
  byte-identical.
  **Note:** the `UntaggedContent` rule walks glyph and image events, not path
  fills, so it cannot see the marker box either way. The box's artifact wrapping
  is asserted on the content stream.
```

- [ ] **Step 3: Run the full suite and typecheck**

```bash
npm run typecheck; echo "EXIT=$?"   # must print EXIT=0
npm test
```
Expected: both green. Do not proceed on a red suite.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(redact): document overlay tagging (nmjf)"
```

- [ ] **Step 5: File the validator blind spot as its own issue**

```bash
bd create "UntaggedContent rule ignores path fills" \
  -t bug -p 3 \
  -d "structvalidate.ts's UntaggedContent rule walks glyph and image events only, so vector content drawn straight into a page — a PageGraphics fill or stroke — is never flagged, however untagged it is. Found while fixing nmjf: the redaction marker box was invisible to the rule, and only the overlay TEXT was reported. Teaching the rule to walk paths is the real fix, but it would light up every feature that draws one (watermarks, tables, barcodes, SVG import, PageGraphics authoring generally), so it needs its own pass over those producers to decide artifact-vs-tag for each. Deliberately out of scope for nmjf."
```

- [ ] **Step 6: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-nmjf
git add .beads/          # .beads/ is tracked in this repo
git commit -m "chore(bd): close nmjf, file the UntaggedContent path gap"
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Overlay text tagged, not artifacted | 3 |
| Marker box artifacted | 2 |
| `doc.GetStructTree()` is the tagged/untagged switch | 2 (box), 3 (text and `/RO`) |
| Untagged output byte-identical | 2 and 3 (a dedicated test each) |
| `paintRedactOverlay` delegates its fill, removing the duplication | 2 |
| `PageGraphics.BeginArtifact()` | 1 |
| `/P` not `/Span`, attached under `/Document` | 3 |
| `/RO` branch tagged `/P` | 3 |
| Full-issue-set assertion, not just absence of one rule | 3 |
| Box asserted on the stream, not via the validator | 2 |
| Validator path blind spot filed separately | 4 |
| README + CLAUDE.md | 4 |

No gaps.

**Type consistency:** `BeginArtifact(): this` is defined in Task 1 and called in Task 2. `paintRedactionBoxes(doc, page, rects, color?)` keeps its published signature and is called from `redactapply.ts` in Task 2 with `(doc, page, boxes, fill)`. `overlayElement(doc): StructElement | undefined` is defined in Task 3 Step 3 and used in Steps 4 and 5. `elem.Type` is `StructElement.Type`, a `string`, which is what `wrapMarkedContent`'s first parameter takes.

**Three places the plan says to check rather than assume:** Task 1 Step 1 says to reuse `test/graphics.test.ts`'s existing document/content helper rather than inventing one; Task 2 Step 4 says to drop the `PageGraphics` import from `redactapply.ts` only if it actually becomes unused; Task 3 Step 7 says to locate the `ValidatePdfUa` test file by grep rather than trusting the guessed filename.
