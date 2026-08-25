# Text (Sticky Note) Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/Text` (sticky-note) annotation support: a `TextAnnotation` subclass and `Page.AddTextNote(...)`, building on the shipped annotation foundation.

**Architecture:** `src/annotation.ts` gains a `TextAnnotation extends Annotation` subclass (icon/open/author accessors) and a free `addTextNote(doc, page, opts)` builder that calls the existing `createAnnotation` helper. `wrapAnnotation` is extended to return `TextAnnotation` for the `/Text` subtype. `Page.AddTextNote` is a thin method delegating to `addTextNote`, mirroring how `Page.AddText`/`AddImage` delegate to their feature modules. Text annotations need no `/AP` stream — viewers render the icon natively.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Node built-ins only.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension.
- **Strict TypeScript** — `npm run typecheck` must stay green.
- **Public error types only** — `TypeError` for bad inputs; reuse `PdfParseError`/`UnsupportedFeatureError` where applicable.
- **Live-mutation model** — edits act directly on the live dict; never copy-and-replace the page dict.
- **Colors are DeviceRGB `0..1`** — three finite numbers in `[0,1]`; `TypeError` otherwise (enforced by the shared `createAnnotation`).
- **Default annotation flag** — created annotations get `/F = 4` (Print); created text notes default `/Name = Note` and are closed (`/Open` unset/false).
- **TDD** — failing test first, watch it fail, implement minimally, watch it pass, commit. Run `npm run typecheck` before any commit that changes types.
- Target a single test file with `npx vitest run test/annotation.test.ts`; full suite with `npm test`.

## Foundation already shipped (consume, do not rebuild)

From `src/annotation.ts` (on `main`):
- `class Annotation { constructor(doc, dict); readonly Dict; get/set Rect, Color, Contents, Name, ModDate, Flags, Print, Hidden, Opacity; get Subtype }`
- `function wrapAnnotation(doc: Document, dict: PdfDict): Annotation` — **currently returns base `Annotation` for every subtype; this plan extends it.**
- `function createAnnotation(doc: Document, page: Page, init: BaseAnnotInit): PdfDict` where `interface BaseAnnotInit { subtype: string; rect: [number,number,number,number]; color?: [number,number,number]; contents?: string }` — sets `/Type`, `/Subtype`, `/Rect`, `/F`=4, `/M`=now, `/P`, optional `/C` and `/Contents`, validates before allocating, and appends to the page's own `/Annots`.
- Module-private helpers available to same-module code: `pdfText(s): PdfObject` (builds a PdfString), `FLAG_PRINT`.
- Imports already present in `annotation.ts`: `name`, `isName`, `isString` from `./types.js`; `decodePdfText`, `encodePdfText`, `formatPdfDate`, `parsePdfDate` from `./metadata.js`; `type Page` from `./page.js`.

From `src/page.ts`: `Page` delegates feature methods to free functions (e.g. `AddText` → `stampText`, `AddImage` → `addImage`). `this.doc` and `this.Number` are available inside `Page`.

---

### Task 1: `TextAnnotation` subclass + `wrapAnnotation` dispatch

Introduces the subclass and makes the read model return it for `/Text` annotations.

**Files:**
- Modify: `src/annotation.ts` (add `TextAnnotation`, extend `wrapAnnotation`)
- Modify: `test/annotation.test.ts` (add a `TextAnnotation` describe block + import)

**Interfaces:**
- Consumes: `Annotation` (base), module-private `pdfText`, `name`/`isName`/`isString`, `decodePdfText`.
- Produces:
  - `class TextAnnotation extends Annotation { get Icon(): string | undefined; set Icon(v: string | undefined); get Open(): boolean; set Open(v: boolean); get Author(): string | undefined; set Author(v: string | undefined); }`
  - `wrapAnnotation` now returns `TextAnnotation` when `/Subtype` is `Text`.

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, extend the top import from `../src/annotation.js` to add `TextAnnotation`:

```ts
import { Annotation, createAnnotation, TextAnnotation } from '../src/annotation.js';
```

Append a new `describe` block (`Document`/`buildAnnotTarget` are already imported from earlier tasks):

```ts
describe('TextAnnotation', () => {
  it('wraps /Text annotations and exposes icon/open/author accessors', () => {
    const doc = Document.Open(buildAnnotTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(TextAnnotation);

    const note = a as TextAnnotation;
    expect(note.Subtype).toBe('Text');
    expect(note.Icon).toBeUndefined();  // fixture has no /Name
    expect(note.Open).toBe(false);      // fixture has no /Open
    expect(note.Author).toBeUndefined();

    note.Icon = 'Comment';
    expect(note.Icon).toBe('Comment');
    note.Open = true;
    expect(note.Open).toBe(true);
    note.Author = 'Reviewer';
    expect(note.Author).toBe('Reviewer');

    note.Icon = undefined;
    expect(note.Icon).toBeUndefined();
  });

  it('rejects invalid icon/open/author types', () => {
    const doc = Document.Open(buildAnnotTarget());
    const note = doc.Pages[0].Annotations[0] as TextAnnotation;
    expect(() => { (note as any).Icon = 5; }).toThrow(TypeError);
    expect(() => { (note as any).Open = 'yes'; }).toThrow(TypeError);
    expect(() => { (note as any).Author = 7; }).toThrow(TypeError);
  });

  it('still returns a base Annotation for non-Text subtypes', () => {
    const doc = Document.Open(buildAnnotTarget());
    const link = doc.Pages[0].Annotations[1];
    expect(link).toBeInstanceOf(Annotation);
    expect(link).not.toBeInstanceOf(TextAnnotation);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `TextAnnotation` is not exported / `instanceof TextAnnotation` is false.

- [ ] **Step 3: Add the `TextAnnotation` subclass**

In `src/annotation.ts`, insert this class immediately after the `Annotation` class definition (and before `wrapAnnotation`):

```ts
/** A /Text (sticky-note) annotation: an icon-and-popup markup with no appearance
 *  stream. Adds the note-specific entries to the base Annotation handle. */
export class TextAnnotation extends Annotation {
  /** /Name icon (e.g. Note, Comment, Help, Insert, Key, NewParagraph, Paragraph);
   *  undefined when absent. */
  get Icon(): string | undefined {
    const n = this.Dict.get('Name');
    return isName(n) ? n.name : undefined;
  }

  set Icon(v: string | undefined) {
    if (v === undefined) { this.Dict.delete('Name'); return; }
    if (typeof v !== 'string') throw new TypeError('Icon must be a string');
    this.Dict.set('Name', name(v));
  }

  /** /Open: whether the note's popup is initially displayed open. false when absent. */
  get Open(): boolean {
    return this.doc.resolve(this.Dict.get('Open')) === true;
  }

  set Open(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('Open must be a boolean');
    this.Dict.set('Open', v);
  }

  /** /T text label (the note's author); undefined when absent. */
  get Author(): string | undefined {
    const s = this.doc.resolve(this.Dict.get('T'));
    return isString(s) ? decodePdfText(s.bytes) : undefined;
  }

  set Author(v: string | undefined) {
    if (v === undefined) { this.Dict.delete('T'); return; }
    if (typeof v !== 'string') throw new TypeError('Author must be a string');
    this.Dict.set('T', pdfText(v));
  }
}
```

(`this.doc` is `protected` on the base class, so the subclass can use it.)

- [ ] **Step 4: Extend `wrapAnnotation` to dispatch on `/Subtype`**

In `src/annotation.ts`, replace the existing factory:

```ts
/** Wrap an annotation dict in its typed handle. Subtype-specific subclasses are
 *  introduced by later plans; today every subtype yields the base `Annotation`. */
export function wrapAnnotation(doc: Document, dict: PdfDict): Annotation {
  return new Annotation(doc, dict);
}
```

with:

```ts
/** Wrap an annotation dict in its typed handle, dispatching on /Subtype. Unknown
 *  subtypes fall back to the base `Annotation`. */
export function wrapAnnotation(doc: Document, dict: PdfDict): Annotation {
  const st = dict.get('Subtype');
  const subtype = isName(st) ? st.name : '';
  switch (subtype) {
    case 'Text': return new TextAnnotation(doc, dict);
    default: return new Annotation(doc, dict);
  }
}
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/annotation.ts test/annotation.test.ts
git commit -m "feat: TextAnnotation subtype with icon/open/author accessors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Page.AddTextNote` + exports + README + round-trip

Adds the public creation method, its options type, the package exports, and the docs, proving the whole path survives Save/Open.

**Files:**
- Modify: `src/annotation.ts` (add `TextNoteOptions` + `addTextNote`)
- Modify: `src/page.ts` (add `AddTextNote` method + imports)
- Modify: `src/index.ts` (export `TextAnnotation` + `TextNoteOptions`)
- Modify: `README.md` (API row)
- Modify: `test/annotation.test.ts` (create + round-trip tests)

**Interfaces:**
- Consumes: `createAnnotation`, `TextAnnotation` (Task 1), `Page.AddTextNote`'s `this.doc`/`this`.
- Produces:
  - `interface TextNoteOptions { rect: [number,number,number,number]; contents?: string; icon?: string; open?: boolean; color?: [number,number,number]; author?: string }`
  - `function addTextNote(doc: Document, page: Page, opts: TextNoteOptions): TextAnnotation`
  - `Page.AddTextNote(opts: TextNoteOptions): TextAnnotation`

- [ ] **Step 1: Write the failing test**

In `test/annotation.test.ts`, append:

```ts
describe('Page.AddTextNote', () => {
  it('creates a /Text annotation with defaults and provided fields', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];

    const note = page.AddTextNote({
      rect: [10, 20, 30, 40],
      contents: 'please review',
      icon: 'Comment',
      open: true,
      color: [1, 1, 0],
      author: 'QA',
    });

    expect(note).toBeInstanceOf(TextAnnotation);
    expect(note.Subtype).toBe('Text');
    expect(note.Rect).toEqual([10, 20, 30, 40]);
    expect(note.Contents).toBe('please review');
    expect(note.Icon).toBe('Comment');
    expect(note.Open).toBe(true);
    expect(note.Color).toEqual([1, 1, 0]);
    expect(note.Author).toBe('QA');
    expect(note.Print).toBe(true);            // default /F = 4
    expect(page.Annotations).toHaveLength(1);
  });

  it('defaults icon to Note and open to false', () => {
    const doc = Document.Open(buildBlankPage());
    const note = doc.Pages[0].AddTextNote({ rect: [0, 0, 10, 10] });
    expect(note.Icon).toBe('Note');
    expect(note.Open).toBe(false);
    expect(note.Author).toBeUndefined();
  });

  it('validates rect via the shared create path', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => doc.Pages[0].AddTextNote({ rect: [0, 0, 10] as any })).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('round-trips through Save/Open as a TextAnnotation', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddTextNote({ rect: [5, 5, 25, 25], contents: 'hi', icon: 'Help', author: 'Me' });

    const reopened = Document.Open(doc.Save());
    const annots = reopened.Pages[0].Annotations;
    expect(annots).toHaveLength(1);
    expect(annots[0]).toBeInstanceOf(TextAnnotation);
    const note = annots[0] as TextAnnotation;
    expect(note.Icon).toBe('Help');
    expect(note.Contents).toBe('hi');
    expect(note.Author).toBe('Me');
  });
});
```

(`buildBlankPage` is already imported from the foundation tasks.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/annotation.test.ts`
Expected: FAIL — `page.AddTextNote is not a function`.

- [ ] **Step 3: Add `TextNoteOptions` + `addTextNote` to `src/annotation.ts`**

Append at the end of `src/annotation.ts`:

```ts
/** Options for Page.AddTextNote. */
export interface TextNoteOptions {
  rect: [number, number, number, number];
  /** /Contents body text. */
  contents?: string;
  /** /Name icon. Default 'Note'. */
  icon?: string;
  /** /Open popup state. Default false. */
  open?: boolean;
  /** /C colour, RGB 0..1. */
  color?: [number, number, number];
  /** /T author label. */
  author?: string;
}

/** Build and attach a /Text (sticky-note) annotation to `page`; returns its
 *  TextAnnotation handle. Icon defaults to 'Note'. */
export function addTextNote(doc: Document, page: Page, opts: TextNoteOptions): TextAnnotation {
  const dict = createAnnotation(doc, page, {
    subtype: 'Text',
    rect: opts.rect,
    color: opts.color,
    contents: opts.contents,
  });
  const note = new TextAnnotation(doc, dict);
  note.Icon = opts.icon ?? 'Note';
  if (opts.open !== undefined) note.Open = opts.open;
  if (opts.author !== undefined) note.Author = opts.author;
  return note;
}
```

Note: `createAnnotation` validates `rect`/`color` and allocates the object before `addTextNote` sets the note-specific entries, so an invalid `rect` throws before anything is attached.

- [ ] **Step 4: Add `Page.AddTextNote`**

In `src/page.ts`, extend the existing import from `./annotation.js`:

```ts
import { Annotation, wrapAnnotation, addTextNote, TextAnnotation, TextNoteOptions } from './annotation.js';
```

Add the method immediately after `RemoveAnnotation`:

```ts
  /** Add a /Text (sticky-note) annotation to this page. */
  AddTextNote(opts: TextNoteOptions): TextAnnotation {
    return addTextNote(this.doc, this, opts);
  }
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/annotation.test.ts` — Expected: PASS.

- [ ] **Step 6: Export from `index.ts`**

In `src/index.ts`, replace:

```ts
export { Annotation } from './annotation.js';
```

with:

```ts
export { Annotation, TextAnnotation } from './annotation.js';
export type { TextNoteOptions } from './annotation.js';
```

- [ ] **Step 7: Update the README**

In `README.md`, the annotation rows currently read:

```
| `page.Annotations` | Typed `Annotation[]` handles (`.Dict` for the raw dict) |
| `page.RemoveAnnotation(a)` | Remove an annotation from the page |
```

Add a row after them:

```
| `page.AddTextNote(opts)` | Add a `/Text` sticky-note annotation (icon/open/color/author) |
```

- [ ] **Step 8: Run typecheck, full suite, and build**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean build (emits `TextAnnotation`/`TextNoteOptions` to `.d.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/annotation.ts src/page.ts src/index.ts README.md test/annotation.test.ts
git commit -m "feat: Page.AddTextNote for sticky-note annotations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the next plans

- `c9p` (links), `vpm` (markup), `82t` (stamps) follow the same shape: a subclass
  + a `wrapAnnotation` switch case + an `add*` builder + a `Page.Add*` method.
  `vpm`/`82t` additionally build an `/AP` Form XObject via
  `buildAppearanceXObject`/`installAP` from `appearance.ts`.
- `Author` (`/T`) lives on `TextAnnotation` for now; when `vpm`/`82t` need it too,
  consider lifting it to a shared markup base — defer until a second consumer exists.
