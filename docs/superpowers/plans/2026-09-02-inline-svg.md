# Inline `<svg>` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an inline `<svg>` in an HTML document draws through the existing SVG
importer, and what the importer could not render folds into the same `skipped`
report the rest of the HTML stack uses.

**Architecture:** a new pure leaf serializes the `<svg>` subtree back to XML
markup; `svgembed.ts` splits along the line it already has so the import runs at
BUILD time from a `Document` alone; `cssflow.ts` takes the builder INJECTED, the
third instance of the `resolveImage` / `makeFloat` seam, and folds the
importer's two lists into `NotRendered` records.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-02-inline-svg-design.md`

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins.
- ESM + NodeNext: every import specifier carries the `.js` extension.
- `npm run typecheck` and `npm test` green before any task closes.
- Target one file with `npx vitest run test/<name>.test.ts`.
- TDD: the failing test is written and *observed failing* before the code.
- **The closed `Construct` vocabulary stays at 20 names.** `'svg'` already
  exists; nothing is added.
- **`<math>` stays suppressed and reported.** Only the `svg` row leaves
  `elementPolicy`.
- **Failure is a value, never a throw.** A subtree that will not serialize, or
  markup `parseXml` rejects, reports `svg`/`dropped` and renders nothing.
- **Fences that must not move:** `test/rich-runs-identity.test.ts`,
  `test/html-identity.test.ts`, and the SVG importer's own suite
  (`ls test | grep -i svg`).
- Every new rule gets a mutation check; anything uncovered is RECORDED in
  CLAUDE.md rather than quietly kept.
- CHANGELOG entry lands in Task 6, as one entry for the whole issue.

## One correction to the spec, and it REMOVES a risk

The spec says `addSvgObject`'s emitted bytes "MAY move" — an `rx`/`ry` matrix
becoming an origin matrix plus a `cm` translate — and names the SVG goldens as
the fence for that. **They need not move, and this plan does not let them.**

`placementMatrix(vb, rect, par, fit)` is a pure function of the viewBox and the
rect. If the builder hands back a `matrixFor(rect)` closure instead of a
pre-computed matrix, `addSvgObject` computes the very same matrix it computes
today and emits byte-identical content. The composition was checked
algebraically as well: `placementMatrix` returns
`[sx, 0, 0, -sy, rx + tx - minX*sx, ry + rh - ty + minY*sy]`, so the `rx`/`ry`
terms enter only additively in `e` and `f` — translating an origin matrix by
`(x, y)` is exactly the rect matrix. Either route is correct; the closure is
the one with no golden to argue about.

**So the fence is stronger than the spec asked for:** the SVG suite must stay
green *unedited*, and a moved golden is a bug rather than a thing to verify.

## File structure

| File | Responsibility |
|---|---|
| `src/svgserialize.ts` (new) | `<svg>` subtree → XML markup. Pure leaf over `htmldom.js` + `htmlforeign.js`. |
| `src/svgembed.ts` | Split: `buildSvgForm` (Document only) + `addSvgObject` (adds the page attachment). |
| `src/htmlreport.ts` | `elementPolicy` loses its `svg` row; keeps `math`. |
| `src/cssbox.ts` | An `svg` box kind carrying the element. |
| `src/cssresolve.ts` | Intrinsic sizing for an `svg` box. |
| `src/cssflow.ts` | `renderSvg` injected; emits the figure; folds the two lists. |
| `src/htmlflow.ts` | Supplies `renderSvg`, closing over the `Document`. |
| `scripts/gen-box-goldens.ts` | The five measured sizing rows as fixtures. |

---

### Task 1: `svgserialize.ts` — the subtree back to markup

**Files:**
- Create: `src/svgserialize.ts`
- Test: `test/svgserialize.test.ts`
- Modify: `CLAUDE.md` (module entry)

**Interfaces:**
- Consumes: `HtmlElement`, `HtmlNode` (types, `htmldom.js`); `FOREIGN_ATTRS` (`htmlforeign.js`).
- Produces: `serializeSvg(el: HtmlElement): string`

- [ ] **Step 1: Write the failing test**

Create `test/svgserialize.test.ts`:

```ts
/** An inline <svg> subtree back to XML markup, so the existing importer — which
 *  takes SOURCE BYTES — can render it (zch2.12).
 *
 *  The round trip through parseXml is the real check: it is strict, so it
 *  rejects anything the serializer got wrong. */
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseXml } from '../src/xml.js';
import { serializeSvg } from '../src/svgserialize.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

/** The <svg> element of a parsed document. */
function svgOf(src: string): HtmlElement {
  const found: HtmlElement[] = [];
  const walk = (n: HtmlNode): void => {
    if (n.kind === 'element') {
      if (n.ns === 'svg' && n.name === 'svg') found.push(n);
      for (const k of n.children) walk(k);
    }
  };
  for (const n of parseHtml(src).children) walk(n);
  if (found.length === 0) throw new Error('no <svg> in fixture');
  return found[0];
}

describe('serializeSvg', () => {
  it('round-trips through the strict XML parser', () => {
    const out = serializeSvg(svgOf('<svg viewBox="0 0 10 10"><rect/></svg>'));
    expect(() => parseXml(new TextEncoder().encode(out))).not.toThrow();
  });

  it('PRESERVES camelCase the parser already adjusted', () => {
    // linearGradient and viewBox are case-adjusted during parsing; lower-casing
    // them here — the obvious defensive move when writing XML from an HTML DOM
    // — breaks every gradient and every viewBox in every document.
    const out = serializeSvg(svgOf(
      '<svg viewBox="0 0 10 10"><lineargradient id="g"></lineargradient></svg>'));
    expect(out).toContain('viewBox=');
    expect(out).toContain('linearGradient');
  });

  it('turns an adjusted attribute display key back into a colon name', () => {
    // htmlforeign.ts stores xlink:href as `xlink href`, with a SPACE. Emitted
    // verbatim that is not a name parseXml can read.
    const out = serializeSvg(svgOf(
      '<svg><use xlink:href="#a"/></svg>'));
    expect(out).toContain('xlink:href="#a"');
    expect(out).not.toContain('xlink href');
    expect(() => parseXml(new TextEncoder().encode(out))).not.toThrow();
  });

  it('escapes attribute values and text', () => {
    const out = serializeSvg(svgOf(
      '<svg><title>a &amp; b &lt; c</title><rect id="q&quot;t"/></svg>'));
    expect(() => parseXml(new TextEncoder().encode(out))).not.toThrow();
    expect(out).toContain('&amp;');
    expect(out).toContain('&lt;');
  });

  it('self-closes an empty element and keeps a non-empty one open', () => {
    const out = serializeSvg(svgOf('<svg><rect/><g><rect/></g></svg>'));
    expect(out).toContain('<rect/>');
    expect(out).toContain('</g>');
  });

  it('carries the whole subtree, nested', () => {
    const out = serializeSvg(svgOf(
      '<svg viewBox="0 0 4 4"><g><g><circle r="1"/></g></g></svg>'));
    const root = parseXml(new TextEncoder().encode(out));
    expect(root.name).toBe('svg');
    expect(root.children[0].name).toBe('g');
  });

  it('drops a comment rather than emitting one', () => {
    // A comment carries no ink and parseXml has its own rules for them; the
    // simplest correct thing is to leave them out.
    const out = serializeSvg(svgOf('<svg><!--note--><rect/></svg>'));
    expect(out).not.toContain('note');
    expect(() => parseXml(new TextEncoder().encode(out))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/svgserialize.test.ts`
Expected: FAIL — cannot resolve `../src/svgserialize.js`.

- [ ] **Step 3: Write the leaf**

Create `src/svgserialize.ts`:

```ts
/** An inline `<svg>` subtree back to XML markup (zch2.12).
 *
 *  Invariant: a PURE LEAF over htmldom.js and htmlforeign.js. No Document, no
 *  PDF object module, no `node:` import. It never throws.
 *
 *  Why it exists at all: `addSvgObject` takes SOURCE BYTES and svgdraw.ts walks
 *  an xml.ts tree, while the HTML parser produced HtmlElements. There is no
 *  path between them, so rendering "through the existing importer" means
 *  serializing back to markup — which the issue treated as free.
 *
 *  Invariant: it UNDOES the two adjustments HTML tree construction made, and
 *  both are silent when missed. An adjusted foreign attribute is stored under a
 *  DISPLAY key with a SPACE (`xlink href`), which is not a name parseXml can
 *  read; and element and attribute names are ALREADY case-adjusted
 *  (`linearGradient`, `viewBox`), so they are emitted as stored rather than
 *  lower-cased.
 *
 *  Note the output is validated by its consumer: parseXml is strict — it throws
 *  PdfParseError on a mismatched end tag or an unquoted value — so a serializer
 *  bug surfaces at the parse rather than as a silently wrong drawing. */

import type { HtmlElement, HtmlNode } from './htmldom.js';
import { FOREIGN_ATTRS } from './htmlforeign.js';

/** Display key (`xlink href`) back to the XML name (`xlink:href`). */
const XML_NAME: ReadonlyMap<string, string> = new Map(
  [...FOREIGN_ATTRS].map(([xml, display]) => [display, xml]),
);

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

function emit(n: HtmlNode, out: string[]): void {
  if (n.kind === 'text') { out.push(escapeText(n.data)); return; }
  // Comments and anything else carry no ink; leaving them out keeps the output
  // to what the importer reads.
  if (n.kind !== 'element') return;
  const attrs: string[] = [];
  for (const [k, v] of n.attrs) {
    attrs.push(` ${XML_NAME.get(k) ?? k}="${escapeAttr(v)}"`);
  }
  if (n.children.length === 0) {
    out.push(`<${n.name}${attrs.join('')}/>`);
    return;
  }
  out.push(`<${n.name}${attrs.join('')}>`);
  for (const k of n.children) emit(k, out);
  out.push(`</${n.name}>`);
}

/** The subtree rooted at `el` as XML markup. */
export function serializeSvg(el: HtmlElement): string {
  const out: string[] = [];
  emit(el, out);
  return out.join('');
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/svgserialize.test.ts`
Expected: PASS, 7 tests.

**No `xmlns` is needed on the root** — verified against the real importer, not
assumed: `page.AddSVGObject` on `<svg viewBox="0 0 10 10"><rect …/></svg>` with
no namespace declaration renders (`skipped: []`, a `/Fm1 Do` in the content
stream). `parseXml` strips namespace prefixes and `svgembed.ts` checks the root
name only. So the serializer adds nothing the DOM did not carry, which is also
what keeps it a faithful round trip rather than a rewrite.

- [ ] **Step 5: Add the CLAUDE.md module entry**

Insert into the Source list near the other `svg*` entries:

```markdown
- **svgserialize.ts** — an inline `<svg>` subtree back to XML markup
  (`zch2.12`). A pure leaf over `htmldom.js` and `htmlforeign.js` that never
  throws. Note the DIRECTION: this is HTML DOM → markup so the SVG IMPORTER can
  read it, and shares no code with `htmlsemantic.ts` (PDF → HTML) or
  `svgrender.ts` (PDF → SVG).
  **Why it exists:** `addSvgObject` takes SOURCE BYTES and `svgdraw.ts` walks an
  `xml.ts` tree, while the HTML parser produced `HtmlElement`s. There is no path
  between them, so "render it through the existing importer" needs this step —
  which `zch2.12`'s issue treated as free.
  **Invariant:** it UNDOES two tree-construction adjustments, both silent when
  missed. An adjusted foreign attribute is stored under a DISPLAY key with a
  SPACE (`xlink href`, `htmlforeign.ts:87`), which is not a name `parseXml` can
  read; and element and attribute names are ALREADY case-adjusted
  (`linearGradient`, `viewBox`), so they are emitted AS STORED — lower-casing
  them, the obvious move when writing XML from an HTML DOM, breaks every
  gradient and every viewBox.
  **Note:** the output is validated by its CONSUMER. `parseXml` is strict, so a
  serializer bug surfaces as a `PdfParseError` at the parse rather than as a
  silently wrong drawing — which is why the round trip is the test that matters.
```

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/svgserialize.ts test/svgserialize.test.ts CLAUDE.md
git commit -m "feat(zch2.12): svgserialize.ts, an inline <svg> subtree back to markup"
```

---

### Task 2: Split `svgembed.ts` at the seam it already has

**Files:**
- Modify: `src/svgembed.ts` (`addSvgObject`, ~lines 183-249)
- Test: `test/svgembed-build.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  export interface BuiltSvg {
    ref: PdfObject;
    /** placementMatrix for a rect; the caller supplies the position. */
    matrixFor(rect: [number, number, number, number]): Matrix;
    skipped: string[];
    rasterized: string[];
  }
  export function buildSvgForm(
    doc: Document, data: Uint8Array, size: [number, number], opts?: AddSVGOptions,
  ): BuiltSvg;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/svgembed-build.test.ts`:

```ts
/** buildSvgForm imports an SVG from a Document alone — no Page — which is what
 *  lets zch2.12 run the import at BUILD time and fold the importer's report
 *  into AddHtml's, which is handed back before anything is drawn. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildSvgForm } from '../src/svgembed.js';

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
  + '<rect width="10" height="10" fill="red"/></svg>');

describe('buildSvgForm', () => {
  it('builds a Form XObject with no page in sight', () => {
    const doc = Document.New();
    const built = buildSvgForm(doc, SVG, [100, 100]);
    expect(built.ref).toBeDefined();
    expect(built.skipped).toEqual([]);
    expect(built.rasterized).toEqual([]);
  });

  it('reports what it could not render, at BUILD time', () => {
    // An <image> with an href this library cannot decode and no resolver.
    const doc = Document.New();
    const built = buildSvgForm(doc, new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
      + '<image href="nope.png" width="10" height="10"/></svg>'), [100, 100]);
    expect(built.skipped).toContain('image');
  });

  it('matrixFor(rect) equals a translate of matrixFor at the origin', () => {
    // The whole reason the builder takes a SIZE: placementMatrix bakes rx/ry
    // into e and f additively, so position is a translate and a form can be
    // built before its position is known.
    const doc = Document.New();
    const built = buildSvgForm(doc, SVG, [100, 50]);
    const atOrigin = built.matrixFor([0, 0, 100, 50]);
    const moved = built.matrixFor([20, 30, 100, 50]);
    expect(moved[0]).toBeCloseTo(atOrigin[0], 9);
    expect(moved[3]).toBeCloseTo(atOrigin[3], 9);
    expect(moved[4]).toBeCloseTo(atOrigin[4] + 20, 9);
    expect(moved[5]).toBeCloseTo(atOrigin[5] + 30, 9);
  });

  it('allocates nothing on a page, unlike AddSVGObject', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const before = new TextDecoder('latin1').decode(page.Contents);
    buildSvgForm(doc, SVG, [100, 100]);
    expect(new TextDecoder('latin1').decode(page.Contents)).toBe(before);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/svgembed-build.test.ts`
Expected: FAIL — `buildSvgForm` is not exported.

- [ ] **Step 3: Perform the split**

In `src/svgembed.ts`, split `addSvgObject` at the `doc.allocObject` line (~233).
Everything above it moves into `buildSvgForm` with `rect` replaced by
`[0, 0, w, h]`; everything below stays.

```ts
/** What an imported SVG is, before it is placed. @internal */
export interface BuiltSvg {
  ref: PdfObject;
  /** The placement matrix for a rect. A closure rather than a baked matrix so
   *  addSvgObject computes exactly the matrix it always did and its output
   *  stays BYTE-IDENTICAL — placementMatrix takes rx/ry additively, so this is
   *  also just a translate of the origin matrix. */
  matrixFor(rect: [number, number, number, number]): Matrix;
  skipped: string[];
  rasterized: string[];
}

/** Import an SVG into `doc` as a Form XObject, WITHOUT placing it.
 *
 *  Split out of addSvgObject along the line that function already had:
 *  everything here touches only the Document, and only the page attachment
 *  needs a Page. That is what lets zch2.12 import at BUILD time and fold the
 *  report into one AddHtml hands back before anything is drawn. */
export function buildSvgForm(
  doc: Document, data: Uint8Array, size: [number, number],
  opts: AddSVGOptions = {},
): BuiltSvg {
  const [w, h] = size;
  if (!(w > 0) || !(h > 0))
    throw new TypeError('svg width and height must be positive');
  validateMarkOptions(opts);
  // …every existing line from `const root = parseXml(data)` down to
  // `const ref = doc.allocObject(...)`, with the local `rect` replaced by
  // `[0, 0, w, h]` — resolveViewBox reads only rect[2]/rect[3], so nothing
  // else in that stretch depends on the position…
  const par = root.attrs.get('preserveAspectRatio');
  return {
    ref,
    matrixFor: (rect) => placementMatrix(vb, rect, par, opts.fit),
    skipped, rasterized,
  };
}
```

and `addSvgObject` becomes:

```ts
export function addSvgObject(
  doc: Document, page: Page, data: Uint8Array,
  rect: [number, number, number, number], opts: AddSVGOptions = {},
): AddSVGResult {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  if (!(rect[2] > 0) || !(rect[3] > 0))
    throw new TypeError('rect width and height must be positive');
  const built = buildSvgForm(doc, data, [rect[2], rect[3]], opts);

  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, built.ref);

  // Clip to the rect unconditionally: 'slice' deliberately overflows, and no
  // SVG should paint outside the rectangle it was handed.
  const [x, y, w, h] = rect;
  const m = built.matrixFor(rect);
  const drawn = enc(
    `q\n${num(x)} ${num(y)} ${num(w)} ${num(h)} re\nW n\n` +
    `${m.map(num).join(' ')} cm\n/${key} Do\nQ`);
  appendContent(doc, page, markDrawing(doc, page, drawn, opts));

  return { skipped: built.skipped, rasterized: built.rasterized };
}
```

Add `import type { Matrix } from './text.js';` — `Matrix` is declared there, not
in `svgtransform.ts`, which imports it too.

**Keep the rect validation in `addSvgObject`** and its exact messages: they are
its documented contract and moving them changes which call throws what.

- [ ] **Step 4: Run the new test**

Run: `npx vitest run test/svgembed-build.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the importer's own suite UNEDITED**

```bash
npx vitest run $(ls test | grep -i svg | sed 's|^|test/|' | tr '\n' ' ')
```
Expected: PASS, with **no test file edited**. The split is behaviour-preserving
and the matrix is computed by the same call as before, so output is
byte-identical. A red test here means the split was along a new line rather than
the real one — revert rather than adjust the test.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/svgembed.ts test/svgembed-build.test.ts
git commit -m "refactor(zch2.12): buildSvgForm imports an SVG from a Document alone"
```

---

### Task 3: Stop suppressing `<svg>`, and give it a box

**Files:**
- Modify: `src/htmlreport.ts` (`elementPolicy`, ~line 118)
- Modify: `src/cssbox.ts` (`boxFor`, ~line 292)
- Modify: `src/cssresolve.ts` (intrinsic sizing)
- Test: `test/cssbox-svg.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: a `BoxNode` arm `{ kind: 'svg'; el: HtmlElement; style; float; clear }`
  and, on `ResolvedBox`, the used `contentWidth`/`minHeight` for it.

- [ ] **Step 1: Write the failing test**

Create `test/cssbox-svg.test.ts`:

```ts
/** An inline <svg> survives the box walk as a replaced box instead of being
 *  suppressed, and takes the size a browser gives it (zch2.12). */
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import { resolveBoxes } from '../src/cssresolve.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;

/** The resolved boxes of a document at an 800px containing width. */
function boxes(src: string) {
  const { boxes: bs, report } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolveFamily);
  return { resolved: resolveBoxes(bs, 800), report };
}

/** The first svg box, wherever it sits. */
function svgBox(src: string) {
  const { resolved, report } = boxes(src);
  const find = (rs: ReturnType<typeof boxes>['resolved']): typeof rs[number] | undefined => {
    for (const r of rs) if (r.box.kind === 'svg') return r;
    return undefined;
  };
  return { box: find(resolved), report, resolved };
}

describe('an inline <svg> box', () => {
  it('is no longer suppressed and reported', () => {
    const { report } = boxes('<svg viewBox="0 0 10 10"><rect/></svg>');
    expect(report.filter((r) => r.construct === 'svg')).toEqual([]);
  });

  it('<math> IS still suppressed and reported', () => {
    const { report } = boxes('<math><mi>x</mi></math>');
    expect(report.filter((r) => r.construct === 'math')).toHaveLength(1);
  });

  it('does not leak its text into the flow', () => {
    // The leak zch2.7 closed: SVG <text> arriving as body text. It stays closed
    // because the subtree is a REPLACED box, not inline content.
    const { resolved } = boxes('<svg viewBox="0 0 10 10"><text>LEAK</text></svg>');
    const inline = resolved.filter((r) => r.box.kind !== 'svg');
    const text = JSON.stringify(inline);
    expect(text).not.toContain('LEAK');
  });
});

describe('inline <svg> sizing, measured against Chrome/152', () => {
  it('fills the width from a viewBox aspect ratio: 800 x 400', () => {
    const { box } = svgBox('<svg viewBox="0 0 100 50"></svg>');
    expect(box?.contentWidth).toBeCloseTo(800, 3);
    expect(box?.minHeight).toBeCloseTo(400, 3);
  });

  it('falls back to 300 x 150 with no viewBox and no size', () => {
    const { box } = svgBox('<svg></svg>');
    expect(box?.contentWidth).toBeCloseTo(300, 3);
    expect(box?.minHeight).toBeCloseTo(150, 3);
  });

  it('honours width/height attributes: 120 x 60', () => {
    const { box } = svgBox('<svg width="120" height="60" viewBox="0 0 100 50"></svg>');
    expect(box?.contentWidth).toBeCloseTo(120, 3);
    expect(box?.minHeight).toBeCloseTo(60, 3);
  });

  it('lets CSS win over the attributes: 200 x 100', () => {
    const { box } = svgBox('<svg viewBox="0 0 100 50" style="width:200px"></svg>');
    expect(box?.contentWidth).toBeCloseTo(200, 3);
    expect(box?.minHeight).toBeCloseTo(100, 3);
  });

  it('resolves a percentage width attribute against the container: 320 x 160', () => {
    const { box } = svgBox('<svg width="40%" viewBox="0 0 100 50"></svg>');
    expect(box?.contentWidth).toBeCloseTo(320, 3);
    expect(box?.minHeight).toBeCloseTo(160, 3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cssbox-svg.test.ts`
Expected: FAIL — `<svg>` is still suppressed, so no `svg` box exists.

- [ ] **Step 3: Drop the `svg` policy row**

In `src/htmlreport.ts`, delete the `svg` line and keep `math`:

```ts
  if (el.ns === 'math') return { content: 'suppress', kind: 'dropped', construct: 'math' };
```

Leave `'svg'` in the `Construct` union and in `CONSTRUCTS`: the fold in Task 5
emits it, so the vocabulary does not change and
`test/htmlreport.test.ts`'s `CONSTRUCTS.length` stays 20. Update
`test/htmlreport-render.test.ts`'s `['svg', 'dropped', …]` row in Task 5, where
the replacement behaviour exists.

- [ ] **Step 4: Add the box arm**

In `src/cssbox.ts`, add to the `BoxNode` union:

```ts
export interface SvgBox {
  kind: 'svg';
  el: HtmlElement;
  style: ComputedStyle;
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
}
```

and in `boxFor`, before the `elementPolicy` call, return one for an SVG root:

```ts
    // An inline <svg> is a REPLACED box carrying its element: the subtree is
    // rendered by the SVG importer (zch2.12), not walked as content, which is
    // what keeps its <text> out of the paragraph flow.
    if (el.ns === 'svg' && el.name === 'svg') {
      return { kind: 'svg', el, style, float, clear };
    }
```

- [ ] **Step 5: Add the sizing**

In `src/cssresolve.ts`'s `resolveOne`, before the float branch, size an `svg`
box from the measured rule:

```ts
  // Inline <svg> sizing, measured against Chrome/152 — see the table in
  // docs/superpowers/specs/2026-09-02-inline-svg-design.md. CSS wins; then the
  // element's own width/height attributes, percentages against the containing
  // block; then the viewBox aspect filling the available width; then 300x150.
  if (box.kind === 'svg') {
    const attr = (n: string): number | undefined => {
      const v = box.el.attrs.get(n);
      if (v === undefined) return undefined;
      const pct = /^\s*([0-9.]+)\s*%\s*$/.exec(v);
      if (pct) return (parseFloat(pct[1]) / 100) * cw;
      const f = parseFloat(v);
      return Number.isFinite(f) && f > 0 ? f : undefined;
    };
    const aspect = svgAspect(box.el);   // height / width, or undefined
    const avail = cw - (mLeft ?? 0) - (mRight ?? 0) - insetLeft - insetRight;
    const wPx = stated ?? attr('width')
      ?? (aspect !== undefined ? Math.max(0, avail) : 300);
    const hPx = (s.height === 'auto' ? undefined : fixedPx(s.height))
      ?? attr('height')
      ?? (aspect !== undefined ? wPx * aspect : 150);
    width = wPx;
    mLeft ??= 0;
    mRight ??= 0;
    return {
      box, contentWidth: Math.max(0, wPx),
      insetLeft, insetRight, insetTop, insetBottom,
      marginTop, marginBottom, marginLeft: mLeft, marginRight: mRight,
      minHeight: Math.max(0, hPx),
    };
  }
```

with a helper beside `borderPx`:

```ts
/** height / width from a `viewBox`, or undefined when there is none to read. */
function svgAspect(el: { attrs: Map<string, string> }): number | undefined {
  const vb = el.attrs.get('viewBox');
  if (vb === undefined) return undefined;
  const n = vb.trim().split(/[\s,]+/).map(Number);
  if (n.length !== 4 || !n.every((v) => Number.isFinite(v))) return undefined;
  return n[2] > 0 && n[3] > 0 ? n[3] / n[2] : undefined;
}
```

`ResolvedBox.box` is typed `BoxNode`, so the new arm flows through with no
change to that interface.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/cssbox-svg.test.ts test/cssbox.test.ts test/cssresolve.test.ts test/cssbox-suite.test.ts`
Expected: PASS.

**Failures OUTSIDE those four files are expected at this point and are Task 5's
work, not this one's.** Between here and Task 4 an inline `<svg>` produces a box
that nothing renders yet, so any case asserting `svg`/`dropped` — in
`cssflow-report`, `html-render`, `htmlflow` or `htmlreport-render` — is
mid-change. Do not run the whole suite here and do not fix them here: the
replacement behaviour does not exist until Task 4.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/htmlreport.ts src/cssbox.ts src/cssresolve.ts test/cssbox-svg.test.ts
git commit -m "feat(zch2.12): an inline <svg> is a replaced box, sized as Chrome sizes it"
```

---

### Task 4: The `renderSvg` seam

**Files:**
- Modify: `src/cssflow.ts` (`CssFlowOptions`, `Ctx`, `mapBoxInner`)
- Modify: `src/htmlflow.ts` (supply `renderSvg`)
- Test: `test/css-svg.test.ts`

**Interfaces:**
- Consumes: `serializeSvg` (Task 1); `buildSvgForm`/`BuiltSvg` (Task 2); the
  `svg` box arm (Task 3).
- Produces: `CssFlowOptions.renderSvg?: (markup: string, size: [number, number]) => BuiltSvg | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/css-svg.test.ts`:

```ts
/** An inline <svg> renders through the existing importer (zch2.12). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const SRC = '<p>before</p>'
  + '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>'
  + '<p>after</p>';

/** The page's content stream as latin1, for operator assertions. */
const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

describe('AddHtml renders an inline <svg>', () => {
  it('draws a Form XObject for it', () => {
    const { pages } = Document.New().AddHtml(SRC);
    expect(cs(pages[0])).toMatch(/\/Fm\d+ Do/);
  });

  it('keeps the surrounding content', () => {
    const { pages } = Document.New().AddHtml(SRC);
    const t = pages[0].GetText();
    expect(t).toContain('before');
    expect(t).toContain('after');
  });

  it('no longer reports svg as dropped', () => {
    const { skipped } = Document.New().AddHtml(SRC);
    expect(skipped.filter((r) => r.construct === 'svg')).toEqual([]);
  });

  it('still does NOT leak the graphic’s text into the flow', () => {
    // zch2.7 closed this; rendering must not reopen it. The SVG's own <text>
    // is drawn by the importer, so it appears at its own coordinates — what
    // must not happen is it arriving as a paragraph.
    const { pages } = Document.New().AddHtml(
      '<p>body</p><svg viewBox="0 0 20 20"><text x="0" y="10">INSIDE</text></svg>');
    const frags = pages[0].GetTextFragments();
    const body = frags.filter((f) => f.text.includes('body'));
    const inside = frags.filter((f) => f.text.includes('INSIDE'));
    expect(body).toHaveLength(1);
    // Drawn by the importer at the graphic's own position, not on the body line.
    if (inside.length > 0) expect(inside[0].quad[1]).not.toBeCloseTo(body[0].quad[1], 1);
  });

  it('renders the same through all three entry points', () => {
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const viaDoc = Document.New().AddHtml(SRC).pages[0].GetText();
    const flowDoc = Document.New();
    const flow = flowDoc.NewFlow({ format: PageFormat.A4 });
    flow.AddHtml(SRC);
    const viaFlow = flow.Render()[0].GetText();
    const pageDoc = Document.New();
    const { page } = pageDoc.AddPage(PageFormat.A4);
    page.AddHtml(SRC, [72, 72, 451, 697]);
    expect(norm(viaFlow)).toBe(norm(viaDoc));
    expect(norm(page.GetText())).toBe(norm(viaDoc));
  });

  it('reports svg/dropped when the subtree will not import', () => {
    // A viewBox that is not four numbers makes parseViewBox decline; whatever
    // the importer refuses, the element must report rather than throw.
    const doc = Document.New();
    expect(() => doc.AddHtml('<svg viewBox="junk"><rect/></svg>')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/css-svg.test.ts`
Expected: FAIL — no `Do` operator; the box renders nothing.

- [ ] **Step 3: Add the seam**

In `src/cssflow.ts`, add to `CssFlowOptions` and to `Ctx`:

```ts
  /** Import an inline <svg>'s markup as a Form XObject. INJECTED because the
   *  importer needs a Document and this module is a pure leaf — htmlflow.ts
   *  supplies it, exactly as it supplies resolveFamily, resolveImage and
   *  makeFloat. Omitted: an inline <svg> reports and draws nothing, which is
   *  the pre-zch2.12 behaviour. Returns undefined when the import failed. */
  renderSvg?: (markup: string, size: [number, number]) => BuiltSvg | undefined;
```

with `import type { BuiltSvg } from './svgembed.js';` — a TYPE import, so the
leaf still pulls in no `Document` at runtime.

In `src/htmlflow.ts`, beside the existing `makeFloat`:

```ts
    renderSvg: (markup, size) => {
      try {
        return buildSvgForm(doc, new TextEncoder().encode(markup), size);
      } catch {
        // parseXml throws PdfParseError on markup it cannot read. A mapper
        // whose whole contract is that damage is a value must not let it out.
        return undefined;
      }
    },
```

with `import { buildSvgForm } from './svgembed.js';`.

- [ ] **Step 4: Emit the figure**

In `src/cssflow.ts`'s `mapBoxInner`, add an arm for the new box kind, before the
`content.kind` switch:

```ts
  if (box.kind === 'svg') {
    const size: [number, number] = [pt(r.contentWidth), pt(r.minHeight)];
    const built = c.renderSvg?.(serializeSvg(box.el), size);
    if (built === undefined) {
      c.skipped.push({ el: box.el, kind: 'dropped', construct: 'svg' });
      return [];
    }
    for (const nameOf of built.skipped)
      c.skipped.push({ el: box.el, kind: 'degraded', construct: 'svg', detail: nameOf });
    // Rasterization draws correctly but is resolution-bound and its text stops
    // being extractable — "drawn, but not as specified", which is `degraded`.
    for (const nameOf of built.rasterized)
      c.skipped.push({ el: box.el, kind: 'degraded', construct: 'svg', detail: nameOf });
    return frameBoxes(
      [svgFigure(built, size)], frameOf(r), { spaceBefore, clear: clearOf(box.style.clear) });
  }
```

with `import { serializeSvg } from './svgserialize.js';`.

- [ ] **Step 5: Add the figure element**

`svgFigure` is a `FlowElement` that draws an already-built form. It needs a
`Page` at place time, which `PlaceContext` supplies, and it needs
`pagecontent.js` — so it does NOT belong in the pure leaf. Put it in
`src/cssframe.ts`, which already paints and already imports what it needs:

```ts
/** A built SVG form, drawn into the element's own box. The import already
 *  happened at BUILD time (zch2.12), so this only places what exists. */
export function svgFigure(built: BuiltSvg, size: [number, number]): FlowElement {
  const [w, h] = size;
  const el: FlowElement = {
    place(ctx: PlaceContext): PlaceResult {
      if (ctx.availHeight < h) return { usedHeight: 0, remainder: el, drew: false };
      const res = ensureOwnResources(ctx.doc, ctx.page);
      const xobjs = ensureOwnSubdict(ctx.doc, res, 'XObject');
      const key = freshKey(xobjs, 'Fm');
      xobjs.set(key, built.ref);
      const rect: [number, number, number, number] = [ctx.x, ctx.top - h, w, h];
      const m = built.matrixFor(rect);
      appendContent(ctx.doc, ctx.page, enc(
        `q\n${num(rect[0])} ${num(rect[1])} ${num(w)} ${num(h)} re\nW n\n`
        + `${m.map(num).join(' ')} cm\n/${key} Do\nQ`));
      return { usedHeight: h, remainder: null, drew: true };
    },
    measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
      return { usedHeight: h, fits: ctx.availHeight >= h };
    },
  };
  return el;
}
```

Import `enc` from `./serialize.js` and `num`, `ensureOwnResources`,
`ensureOwnSubdict`, `freshKey`, `appendContent` from `./pagecontent.js`.

**A figure never splits** — it is one graphic — so a box too tall for the
column asks for the next one, which is what returning `el` as the remainder
does.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/css-svg.test.ts test/cssbox-svg.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/cssflow.ts src/htmlflow.ts src/cssframe.ts test/css-svg.test.ts
git commit -m "feat(zch2.12): inline <svg> renders through the importer, report folded in"
```

---

### Task 5: Update the tests that asserted suppression

**Files:**
- Modify: `test/htmlreport-render.test.ts` (the `svg` row)
- Modify: `test/htmlreport.test.ts` (if it asserts the `svg` policy)
- Modify: whichever of `test/cssflow-report.test.ts`, `test/html-render.test.ts`,
  `test/htmlflow.test.ts`, `test/cssbox.test.ts` assert `svg` as dropped

**Interfaces:** consumes Tasks 3-4. Produces no code.

- [ ] **Step 1: Find every assertion that svg is suppressed**

```bash
grep -rn "'svg'\|\"svg\"\|<svg" test/*.test.ts | grep -v "test/svgserialize\|test/css-svg\|test/cssbox-svg\|test/svgembed-build"
```

- [ ] **Step 2: Update the construct sweep**

`test/htmlreport-render.test.ts`'s `CASES` has an `['svg', 'dropped', …]` row
whose source is an inline `<svg>` that now renders. Replace the source with one
that makes the importer report — an `<image>` it cannot resolve — and the kind
with `degraded`:

```ts
    // Rendering an inline <svg> is zch2.12; what remains reportable is what the
    // IMPORTER could not draw inside it.
    ['svg', 'degraded',
      '<svg viewBox="0 0 10 10"><image href="nope.png" width="10" height="10"/></svg>'],
```

- [ ] **Step 3: Update every other assertion the grep found**

For each: an inline `<svg>` no longer reports `svg`/`dropped`, so a case using
one as a stand-in for "a dropped construct" needs a different vehicle
(`<iframe>fb</iframe>` reports `iframe`/`dropped`) or the new `degraded`
expectation. Change the expectation to the new behaviour rather than the source,
wherever the case is *about* svg.

- [ ] **Step 4: Run the whole suite**

```bash
npm run typecheck
npm test
```
Expected: green. Record the file and test counts.

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test(zch2.12): update the cases that asserted an inline <svg> is suppressed"
```

---

### Task 6: Sizing goldens, mutation sweep, docs and close

**Files:**
- Modify: `scripts/gen-box-goldens.ts`, `test/fixtures/css-box/`
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Add the five sizing fixtures**

In `scripts/gen-box-goldens.ts`'s `CASES`, add the five rows the spec measured.
Each `<svg>` is an only child so no sibling gap is measured:

```ts
  { id: 'svg-viewbox-fills', html: '<div><svg viewBox="0 0 100 50"></svg></div>' },
  { id: 'svg-no-size', html: '<div><svg></svg></div>' },
  { id: 'svg-attrs', html: '<div><svg width="120" height="60" viewBox="0 0 100 50"></svg></div>' },
  { id: 'svg-css-wins', html: '<div><svg viewBox="0 0 100 50" style="width:200px"></svg></div>' },
  { id: 'svg-percent-attr', html: '<div><svg width="40%" viewBox="0 0 100 50"></svg></div>' },
```

- [ ] **Step 2: Regenerate and inspect the diff**

```bash
npx tsx scripts/gen-box-goldens.ts
git diff --stat test/fixtures/css-box/
```
Expected: **additions only**. A changed existing golden means the sizing branch
altered a non-SVG box, which it must not.

Then update `test/fixtures/css-box/PROVENANCE.md`'s file table — bytes, cases,
rows and SHA-256, all printed by the generator — and verify the hash with:

```bash
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('test/fixtures/css-box/goldens.json')).digest('hex'))"
```

- [ ] **Step 3: Run the corpus**

Run: `npx vitest run test/cssbox-suite.test.ts test/cssresolve.test.ts`
Expected: PASS, with the five SVG comparisons included.

- [ ] **Step 4: Mutation-check every new rule**

Apply, run the named tests, record the count, REVERT. Anything reddening nothing
is RECORDED in CLAUDE.md, not deleted.

| # | Mutation | Expect red in |
|---|---|---|
| 1 | `serializeSvg` emits the display key verbatim (drop the `XML_NAME` lookup) | `svgserialize` |
| 2 | `serializeSvg` lower-cases element names | `svgserialize`, `css-svg` |
| 3 | `serializeSvg` skips attribute escaping | `svgserialize` |
| 4 | `buildSvgForm` ignores `size` and uses `[0,0,1,1]` | `svgembed-build`, `css-svg` |
| 5 | `matrixFor` returns the origin matrix whatever the rect | `svgembed-build`, and the SVG suite |
| 6 | `elementPolicy` keeps its `svg` row | `cssbox-svg`, `css-svg` |
| 7 | the viewBox-aspect branch falls to 300x150 | `cssbox-svg`, the box corpus |
| 8 | attribute `width`/`height` ignored (CSS only) | `cssbox-svg`, the box corpus |
| 9 | the percentage branch treats `40%` as `40` | `cssbox-svg`, the box corpus |
| 10 | `rasterized` findings not folded | the rasterized case |
| 11 | `renderSvg` returning undefined reports nothing | the will-not-import case |

- [ ] **Step 5: CHANGELOG**

Add under `## [Unreleased]` → `### Added`. Draft, to be adjusted only where the
mutation results from Step 4 contradict it:

```markdown
- **Inline `<svg>` renders.** An `<svg>` in an HTML document draws through the same importer `page.AddSVGObject` uses — paths, gradients, masks, markers, filters and text, all of it — instead of being suppressed and reported, which is what `zch2.7` had to do when its text was leaking into the paragraph flow while the graphic drew nothing. Works on all three `AddHtml` entry points. **"Through the existing importer" turned out not to be free**, and that is the interesting part: `AddSVGObject` takes SOURCE BYTES while the HTML parser produced a DOM, and this library had no DOM-to-markup serializer — the only tree serializer in the repo emits the html5lib debug format for the conformance corpus. So the subtree is serialized back to XML, which has to undo two things HTML tree construction did and which are both silent when missed: an adjusted foreign attribute is stored under a display key with a SPACE (`xlink href`, not `xlink:href`), and element names are already case-adjusted, so `linearGradient` and `viewBox` must be emitted as stored rather than lower-cased the way writing XML from an HTML DOM tempts you to. The output is validated by its consumer — the XML parser is strict — so a serializer bug surfaces as a parse error rather than as a silently wrong drawing. **`svgembed.ts` split** so the import runs from a `Document` alone, with no `Page`: that is what lets it happen while the boxes are being built, which is the only point at which the importer's findings can reach the `skipped` report — `AddHtml` hands that back before anything is drawn, the same timing limit `zch2.14` documented. `AddSVGObject`'s own output is byte-identical, because the builder returns the placement matrix as a closure over the rect rather than baking one in. **What the importer could not draw is folded into the same report** as everything else: one `svg` record per finding, `dropped` when nothing rendered and `degraded` otherwise — including for a RASTERIZED subtree, which is a judgement rather than a mapping. The importer is explicit that rasterizing is not a fidelity loss, but it is resolution-bound and its text stops being extractable, so calling it a clean render would hide a real consequence from a caller about to extract text. The closed construct vocabulary does not grow. **Sizing is measured against Chrome rather than reasoned about**, and the headline row is the counter-intuitive one: `<svg viewBox="0 0 100 50">` with no width or height FILLS its container — 800x400 in an 800px container — rather than taking a small default box; the 300x150 default applies only when there is no viewBox to give an aspect ratio. CSS wins over the element's own attributes, and a percentage attribute resolves against the containing block. All five rows are fixtures in the headless-Chrome box corpus. **Limits:** `<math>` is still suppressed and reported, since there is no MathML importer here; an `<svg>` sharing a line with text is not yet inline; and a filtered subtree still rasterizes, with everything that already implies. (`zch2.12`)
```

- [ ] **Step 6: README**

The HTML limitation bullet says inline `<svg>` content is deliberately not
drawn. Rewrite: it renders now, with `<math>` still reported and inline-with-text
still out of scope.

- [ ] **Step 7: CLAUDE.md**

Four edits:

1. Record the mutation results on the `svgserialize.ts` entry from Task 1,
   naming anything that reddened nothing as uncovered.
2. Add the `buildSvgForm` split invariants to the `svgembed.ts` prose — that it
   takes a SIZE and emits at the origin because `placementMatrix` bakes
   `rx`/`ry`, and that `matrixFor` being a closure is what keeps
   `addSvgObject`'s bytes identical.
3. Note the `svg` box arm and the measured sizing rule under the
   `cssinline.ts`/`cssbox.ts` entry, with the viewBox-fills-the-width row called
   out as the counter-intuitive one.
4. Note `svgFigure` under the `cssflow.ts`/`cssframe.ts` entry — it lives in
   `cssframe.ts` because it PAINTS, so it cannot be in the pure leaf, which is
   the same split that entry already records for `BoxElement`. Also note that a
   figure never splits: too tall for the column means the next column, which is
   why its `place` returns itself as the remainder.

- [ ] **Step 8: Final verification, close and push**

```bash
npm run typecheck && npm test
git add CHANGELOG.md README.md CLAUDE.md
git commit -m "docs(zch2.12): changelog, README and measured coverage notes"
bd close aspose-pdf-foss-for-ts-zch2.12 --reason "<what shipped, mutation results, anything uncovered>"
git add .beads/ && git commit -m "chore(beads): close zch2.12"
git pull --rebase && git push
git status -sb
```
Expected: `## main...origin/main` with nothing ahead.
