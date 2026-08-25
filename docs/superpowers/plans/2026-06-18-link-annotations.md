# Link Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/Link` annotation create/edit with two action forms — internal `GoTo` (page + optional view) and external `URI` — managing `/Rect`, `/Border` (default invisible), and `/A`; the read side resolves `/A` / `/Dest` into structured data, reusing `outline.ts` dest encoding/parsing.

**Architecture:** `src/annotation.ts` gains a `LinkAnnotation extends Annotation` subclass with `Action` and `Dest` getters that reuse `parseDest` from `src/outline.ts`, plus an `addLink(doc, page, opts)` builder that writes `/A` (`<< /S /GoTo /D [...] >>` via `encodeDest`, or `<< /S /URI /URI (...) >>`) and `/Border`. `wrapAnnotation` dispatches `/Link` to `LinkAnnotation`, and `Page.AddLink` delegates to `addLink`, mirroring `Page.AddStamp`. To resolve a destination's page object to a 1-based page number, `Document`'s existing private `pageNumberForObject` is promoted to an internal public method `pageNumberOf` (consumed by both `GetOutlines` and `LinkAnnotation`).

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Node built-ins only.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension.
- **Strict TypeScript** — `npm run typecheck` must stay green.
- **Public error types only** — `TypeError` for bad inputs; `RangeError` for an out-of-range page (mirrors `validateOutlineItems`); `UnsupportedFeatureError` propagates from `doc.pageRef` for a non-indirect target page.
- **Live-mutation model** — edits act directly on the live dict; never copy-and-replace the page dict.
- **Default annotation flag** — created annotations get `/F = 4` (Print), `/M` = now, `/P` → the page, appended to the page's **own** `/Annots`. All handled by `createAnnotation`.
- **Validate before mutating the page** — validate `action`/`border` and resolve the GoTo `pageRef` (which may throw) *before* `createAnnotation` allocates/attaches anything.
- **Links have no `/AP`** — a `/Border` width of 0 is intentionally invisible; viewers render the link region natively.
- **TDD** — failing test first, watch it fail, implement minimally, watch it pass, commit. Run `npm run typecheck` before any commit that changes types.
- Target a single test file with `npx vitest run test/annotation.test.ts`; full suite with `npm test`.

## Foundation already shipped (consume, do not rebuild)

From `src/annotation.ts` (on `main`):
- `class Annotation { constructor(doc, dict); readonly Dict; get Subtype; get/set Rect, Color, Contents, Name, ModDate, Flags, Print, Hidden, Opacity }`. `doc` is `protected`.
- `class TextAnnotation`, `class StampAnnotation`, `class MarkupAnnotation` — the established subclass pattern to mirror.
- `function wrapAnnotation(doc, dict): Annotation` — dispatches on `/Subtype`; currently `Text`/`Stamp`/`Highlight`/`Underline`/`StrikeOut`/`Squiggly`. This plan adds `case 'Link'`.
- `function createAnnotation(doc, page, init: BaseAnnotInit): PdfDict` where `interface BaseAnnotInit { subtype: string; rect: [number,number,number,number]; color?: [number,number,number]; contents?: string }` — sets `/Type`, `/Subtype`, `/Rect`, `/F`=4, `/M`=now, `/P`, validates `rect`/`color` before allocating, appends to the page's own `/Annots`.
- Module-private helper: `pdfText(s): PdfObject` (builds a PdfString via `encodePdfText`).
- Already-imported in `annotation.ts`: `PdfDict, PdfObject, PdfStream, isArray, isName, isString, name` from `./types.js`; `decodePdfText, encodePdfText, formatPdfDate, parsePdfDate` from `./metadata.js`. (`isDict` is **not** yet imported — Task 1 adds it.)

From `src/outline.ts`:
- `interface OutlineDest { page: number; view?: OutlineView }`.
- `type OutlineView = { type: 'XYZ'; left?; top?; zoom? } | { type: 'Fit' } | { type: 'FitH'; top? } | { type: 'FitV'; left? } | { type: 'FitR'; left; bottom; right; top } | { type: 'FitB' } | { type: 'FitBH'; top? } | { type: 'FitBV'; left? }`.
- `type PageOf = (o: PdfObject) => number | undefined`.
- `function parseDest(doc, item: PdfDict, pageOf: PageOf): OutlineDest | undefined` — resolves explicit `/Dest`, then an `/A` `GoTo` action, then named dests, into `{ page, view }`; `undefined` when unresolvable or for non-`GoTo` actions.
- `function encodeDest(pageRef: PdfRef, view?: OutlineView): PdfObject[]` — builds `[pageRef /Fit ...]`; defaults to `{ type: 'Fit' }`.

From `src/document.ts`:
- `private pageNumberForObject(o: PdfObject): number | undefined` — resolves a page object to its 1-based number via `this.Pages`. **Task 1 promotes this to internal public `pageNumberOf`.**
- `pageRef(page: number): PdfRef` — the indirect ref for a 1-based page number; throws `UnsupportedFeatureError` when that page is not an indirect object.
- `get Pages(): Page[]`, `resolve(o)`, `allocObject(obj)`.

From `src/page.ts`: `Page` delegates feature methods to free functions (`AddStamp` → `addStamp`); `this.doc` and `this` available in methods.

From `test/helpers/build-annot-target.ts`: `buildAnnotTarget()`, `buildBlankPage()`, and the private `assemble(objects, maxObj, rootNum)`.

From `src/index.ts`: already re-exports `OutlineDest`/`OutlineView` (`export type { OutlineItem, OutlineDest, OutlineView } from './outline.js';`).

---

### Task 1: `LinkAnnotation` subclass + `wrapAnnotation` dispatch + `pageNumberOf`

Introduces the subclass and read getters, promotes the page-number helper, and dispatches `/Link`.

**Files:**
- Modify: `src/document.ts` (rename `pageNumberForObject` → public `pageNumberOf`, update caller)
- Modify: `test/helpers/build-annot-target.ts` (add a `buildLinkReadTarget` fixture)
- Modify: `src/annotation.ts` (add `isDict` import + outline imports + `LinkAnnotation`, extend `wrapAnnotation`)
- Modify: `test/annotation.test.ts` (add a `LinkAnnotation` describe block + imports)

**Interfaces:**
- Consumes: `Annotation` (base), `parseDest`/`OutlineDest`/`OutlineView` (outline.ts), `Document.pageNumberOf`, `isDict`/`isName`/`isString`/`decodePdfText`.
- Produces:
  - `Document.pageNumberOf(o: PdfObject): number | undefined` (internal public).
  - `export function buildLinkReadTarget(): Uint8Array` — two pages; page 1 carries a URI link and a GoTo-to-page-2 link.
  - `type GoToAction = { type: 'goto'; page: number; view?: OutlineView }`
  - `type UriAction = { type: 'uri'; uri: string }`
  - `type LinkAction = GoToAction | UriAction`
  - `class LinkAnnotation extends Annotation { get Action(): LinkAction | undefined; get Dest(): OutlineDest | undefined }`
  - `wrapAnnotation` returns `LinkAnnotation` for `/Link`.

- [ ] **Step 1: Promote `pageNumberForObject` to `pageNumberOf`**

In `src/document.ts`, replace:

```ts
  /** Resolve a destination's page object to its 1-based page number, or undefined. */
  private pageNumberForObject(o: PdfObject): number | undefined {
    const d = this.resolve(o);
    if (!isDict(d)) return undefined;
    const i = this.Pages.findIndex((p) => p.Dict === d);
    return i === -1 ? undefined : i + 1;
  }
```

with:

```ts
  /** @internal Resolve a destination's page object to its 1-based page number,
   *  or undefined. Consumed by GetOutlines and LinkAnnotation. */
  pageNumberOf(o: PdfObject): number | undefined {
    const d = this.resolve(o);
    if (!isDict(d)) return undefined;
    const i = this.Pages.findIndex((p) => p.Dict === d);
    return i === -1 ? undefined : i + 1;
  }
```

Then update the one caller in `GetOutlines`:

```ts
    return readOutlineTree(this, outlines, (o) => this.pageNumberOf(o));
```

- [ ] **Step 2: Add the read fixture**

In `test/helpers/build-annot-target.ts`, append:

```ts
/** Two pages; page 1 carries a URI link and a GoTo-to-page-2 link. */
export function buildLinkReadTarget(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 2 /Kids [3 0 R 6 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Annots [4 0 R 5 0 R] >>`;
  objects[4] = `<< /Type /Annot /Subtype /Link /Rect [10 10 100 30] ` +
    `/A << /S /URI /URI (https://example.com) >> >>`;
  objects[5] = `<< /Type /Annot /Subtype /Link /Rect [10 40 100 60] ` +
    `/A << /S /GoTo /D [6 0 R /Fit] >> >>`;
  objects[6] = `<< /Type /Page /Parent 2 0 R >>`;
  return assemble(objects, 6, 1);
}
```

- [ ] **Step 3: Write the failing test**

In `test/annotation.test.ts`, extend the import from `../src/annotation.js` to add `LinkAnnotation`, and the helper import to add `buildLinkReadTarget`:

```ts
import {
  Annotation, createAnnotation, TextAnnotation, StampAnnotation, MarkupAnnotation, LinkAnnotation,
} from '../src/annotation.js';
import {
  buildAnnotTarget, buildBlankPage, buildStampReadTarget, buildMarkupReadTarget, buildLinkReadTarget,
} from './helpers/build-annot-target.js';
```

Append a new describe block:

```ts
describe('LinkAnnotation', () => {
  it('wraps /Link and parses a URI action (no GoTo dest)', () => {
    const doc = Document.Open(buildLinkReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(LinkAnnotation);

    const link = a as LinkAnnotation;
    expect(link.Subtype).toBe('Link');
    expect(link.Action).toEqual({ type: 'uri', uri: 'https://example.com' });
    expect(link.Dest).toBeUndefined();
  });

  it('parses a GoTo action and the resolved destination', () => {
    const doc = Document.Open(buildLinkReadTarget());
    const link = doc.Pages[0].Annotations[1] as LinkAnnotation;
    expect(link.Action).toEqual({ type: 'goto', page: 2, view: { type: 'Fit' } });
    expect(link.Dest).toEqual({ page: 2, view: { type: 'Fit' } });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `LinkAnnotation` is not exported / `instanceof LinkAnnotation` is false.

- [ ] **Step 5: Add imports + the `LinkAnnotation` subclass**

In `src/annotation.ts`, add `isDict` to the `./types.js` import:

```ts
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isString, name } from './types.js';
```

and add the outline imports (next to the other appearance imports):

```ts
import { parseDest, encodeDest, type OutlineDest, type OutlineView } from './outline.js';
```

Insert this immediately after the `MarkupAnnotation` class (and before `wrapAnnotation`):

```ts
/** A GoTo action: jump to a 1-based page with an optional view. */
export type GoToAction = { type: 'goto'; page: number; view?: OutlineView };
/** A URI action: open an external URL. */
export type UriAction = { type: 'uri'; uri: string };
/** The parsed/created action of a link annotation. */
export type LinkAction = GoToAction | UriAction;

/** A /Link annotation. Exposes the parsed /A action (GoTo / URI) and, for GoTo
 *  links, the resolved destination (also covering an explicit /Dest). */
export class LinkAnnotation extends Annotation {
  /** The link's /A action as structured data; undefined when absent or of an
   *  unmodeled action type. */
  get Action(): LinkAction | undefined {
    const a = this.doc.resolve(this.Dict.get('A'));
    if (!isDict(a)) return undefined;
    const s = this.doc.resolve(a.get('S'));
    if (!isName(s)) return undefined;
    if (s.name === 'URI') {
      const u = this.doc.resolve(a.get('URI'));
      return isString(u) ? { type: 'uri', uri: decodePdfText(u.bytes) } : undefined;
    }
    if (s.name === 'GoTo') {
      const d = parseDest(this.doc, this.Dict, (o) => this.doc.pageNumberOf(o));
      return d ? { type: 'goto', page: d.page, view: d.view } : undefined;
    }
    return undefined;
  }

  /** The resolved GoTo destination from /Dest or an /A GoTo action; undefined
   *  for URI links or unresolvable dests. */
  get Dest(): OutlineDest | undefined {
    return parseDest(this.doc, this.Dict, (o) => this.doc.pageNumberOf(o));
  }
}
```

- [ ] **Step 6: Extend `wrapAnnotation`**

In `src/annotation.ts`, add a `Link` case to the `wrapAnnotation` switch (alongside the existing cases):

```ts
    case 'Squiggly': return new MarkupAnnotation(doc, dict);
    case 'Link': return new LinkAnnotation(doc, dict);
    default: return new Annotation(doc, dict);
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS (including the pre-existing "still returns a base Annotation for non-Text subtypes" test, which only asserts the `buildAnnotTarget` link is an `Annotation` and not a `TextAnnotation` — both still hold for `LinkAnnotation`).

- [ ] **Step 8: Commit**

```bash
git add src/document.ts src/annotation.ts test/annotation.test.ts test/helpers/build-annot-target.ts
git commit -m "feat: LinkAnnotation with parsed GoTo/URI Action + Dest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Page.AddLink` + options + exports + docs

Adds the public creation method, its option types, validation, exports, docs, and a Save/Open round-trip.

**Files:**
- Modify: `src/annotation.ts` (add `LinkOptions` + `addLink`)
- Modify: `src/page.ts` (add `AddLink` method + imports)
- Modify: `src/index.ts` (export `LinkAnnotation` + the option/action types)
- Modify: `README.md` (API row)
- Modify: `test/annotation.test.ts` (create + validation + round-trip tests)

**Interfaces:**
- Consumes: `createAnnotation`, `LinkAnnotation`/`GoToAction`/`UriAction` (Task 1), `encodeDest` (outline.ts), `name`, module-private `pdfText`, `Document.pageRef`/`Document.Pages`.
- Produces:
  - `interface LinkOptions { rect: [number,number,number,number]; action: GoToAction | UriAction; border?: number }`
  - `function addLink(doc: Document, page: Page, opts: LinkOptions): LinkAnnotation`
  - `Page.AddLink(opts: LinkOptions): LinkAnnotation`

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, append (the `isStream` import already exists from earlier tasks; add `isName` to the `../src/types.js` import if not already present — change `import { isStream } from '../src/types.js';` to `import { isStream, isName } from '../src/types.js';`):

```ts
describe('Page.AddLink', () => {
  it('creates a URI link with an invisible default border', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const link = page.AddLink({ rect: [10, 10, 100, 30], action: { type: 'uri', uri: 'https://aspose.com' } });

    expect(link).toBeInstanceOf(LinkAnnotation);
    expect(link.Subtype).toBe('Link');
    expect(link.Rect).toEqual([10, 10, 100, 30]);
    expect(link.Action).toEqual({ type: 'uri', uri: 'https://aspose.com' });
    expect(link.Dict.get('Border')).toEqual([0, 0, 0]);   // invisible
    expect(page.Annotations).toHaveLength(1);
  });

  it('creates a GoTo link with a page+view and a visible border', () => {
    const doc = Document.Open(buildBlankPage());             // single indirect page, no annots
    const page = doc.Pages[0];
    const link = page.AddLink({
      rect: [0, 0, 50, 20],
      action: { type: 'goto', page: 1, view: { type: 'XYZ', left: 0, top: 100, zoom: null } },
      border: 2,
    });
    expect(link.Action).toEqual({ type: 'goto', page: 1, view: { type: 'XYZ', left: 0, top: 100, zoom: null } });
    expect(link.Dict.get('Border')).toEqual([0, 0, 2]);
    const a = doc.resolve(link.Dict.get('A')) as Map<string, any>;
    const s = doc.resolve(a.get('S'));
    expect(isName(s) && s.name).toBe('GoTo');
  });

  it('validates the action and rejects an out-of-range GoTo page without mutating the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(() => page.AddLink({ rect: [0, 0, 10, 10], action: { type: 'goto', page: 99 } })).toThrow(RangeError);
    expect(() => page.AddLink({ rect: [0, 0, 10, 10], action: { type: 'uri', uri: '' } })).toThrow(TypeError);
    expect(() => page.AddLink({ rect: [0, 0, 10, 10], action: { type: 'x' } as any })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
  });

  it('round-trips a GoTo link through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddLink({ rect: [5, 5, 55, 25], action: { type: 'goto', page: 1 } });

    const reopened = Document.Open(doc.Save());
    const link = reopened.Pages[0].Annotations.find((x) => x.Subtype === 'Link') as LinkAnnotation;
    expect(link).toBeInstanceOf(LinkAnnotation);
    expect(link.Action).toEqual({ type: 'goto', page: 1, view: { type: 'Fit' } });
    expect(link.Dest).toEqual({ page: 1, view: { type: 'Fit' } });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `page.AddLink is not a function`.

- [ ] **Step 3: Add `LinkOptions` + `addLink` to `src/annotation.ts`**

Append at the end of `src/annotation.ts`:

```ts
/** Options for Page.AddLink. */
export interface LinkOptions {
  rect: [number, number, number, number];
  /** The link target: an internal GoTo or an external URI. */
  action: GoToAction | UriAction;
  /** /Border width in points; default 0 (invisible). */
  border?: number;
}

/** Build and attach a /Link annotation to `page`; returns its LinkAnnotation
 *  handle. Validates the action/border and (for GoTo) resolves the target page
 *  ref before mutating the page. */
export function addLink(doc: Document, page: Page, opts: LinkOptions): LinkAnnotation {
  const action = opts.action;
  const border = opts.border ?? 0;
  if (typeof border !== 'number' || !Number.isFinite(border) || border < 0)
    throw new TypeError('border must be a non-negative finite number');

  let aDict: PdfDict;
  if (action.type === 'goto') {
    const p = action.page;
    if (!Number.isInteger(p) || p < 1 || p > doc.Pages.length)
      throw new RangeError(`link destination page ${p} out of range 1..${doc.Pages.length}`);
    const pageRef = doc.pageRef(p); // throws UnsupportedFeatureError for a non-indirect page
    aDict = new Map<string, PdfObject>([['S', name('GoTo')], ['D', encodeDest(pageRef, action.view)]]);
  } else if (action.type === 'uri') {
    if (typeof action.uri !== 'string' || action.uri.length === 0)
      throw new TypeError('action.uri must be a non-empty string');
    aDict = new Map<string, PdfObject>([['S', name('URI')], ['URI', pdfText(action.uri)]]);
  } else {
    throw new TypeError('action.type must be "goto" or "uri"');
  }

  const dict = createAnnotation(doc, page, { subtype: 'Link', rect: opts.rect });
  dict.set('A', aDict);
  dict.set('Border', [0, 0, border]);
  return new LinkAnnotation(doc, dict);
}
```

- [ ] **Step 4: Add `Page.AddLink`**

In `src/page.ts`, extend the existing import from `./annotation.js` to add `addLink, LinkAnnotation, LinkOptions`:

```ts
import {
  Annotation, wrapAnnotation, addTextNote, TextAnnotation, TextNoteOptions,
  addStamp, StampAnnotation, StampAnnotationOptions,
  addHighlight, addUnderline, addStrikeOut, addSquiggly, MarkupAnnotation, MarkupOptions,
  addLink, LinkAnnotation, LinkOptions,
} from './annotation.js';
```

Add the method immediately after `AddSquiggly`:

```ts
  /** Add a /Link annotation with an internal GoTo or external URI action. */
  AddLink(opts: LinkOptions): LinkAnnotation {
    return addLink(this.doc, this, opts);
  }
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 6: Export from `index.ts`**

In `src/index.ts`, replace:

```ts
export { Annotation, TextAnnotation, StampAnnotation, MarkupAnnotation } from './annotation.js';
export type { TextNoteOptions, StampAnnotationOptions, MarkupOptions, MarkupType } from './annotation.js';
```

with:

```ts
export { Annotation, TextAnnotation, StampAnnotation, MarkupAnnotation, LinkAnnotation } from './annotation.js';
export type {
  TextNoteOptions, StampAnnotationOptions, MarkupOptions, MarkupType,
  LinkOptions, LinkAction, GoToAction, UriAction,
} from './annotation.js';
```

- [ ] **Step 7: Update the README**

In `README.md`, after the `page.AddSquiggly(opts)` row, add:

```
| `page.AddLink(opts)` | Add a `/Link` annotation (internal GoTo or external URI) |
```

- [ ] **Step 8: Run typecheck, full suite, and build**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean build (emits `LinkAnnotation`/`LinkOptions`/action types to `.d.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/annotation.ts src/page.ts src/index.ts README.md test/annotation.test.ts
git commit -m "feat: Page.AddLink for GoTo and URI link annotations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes / follow-ups

- `Action` and `Dest` overlap for GoTo links (both expose the page/view); `Dest` is the convenience accessor reused from the outline machinery, `Action` the discriminated-union view that also covers URIs.
- Only `GoTo` and `URI` actions are modeled; other `/A` action types (`GoToR`, `Launch`, `Named`, …) read back as `Action === undefined` (unchanged dict, escape via `.Dict`). Out of scope for Phase 3.
- Named destinations resolve on read (via `parseDest` → `resolveNamedDest`), but `AddLink` only writes explicit page+view dests; writing named dests is out of scope.
- Remaining Phase 3 leaves after this: `rwn`/`82q` (XMP read/write).
