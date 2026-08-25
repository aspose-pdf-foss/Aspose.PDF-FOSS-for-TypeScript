# Tagged Table Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `page.AddTable` a `{ tagged: true }` mode that emits `/Table > /TR > /TD` (and `/TH`) logical structure, with cell backgrounds and borders as artifacts, so a tagged document containing a table stops failing `ValidatePdfUa`'s `UntaggedContent`.

**Architecture:** A new `src/tabletag.ts` owns every structure decision — when a cell is a `/TH`, its `/Scope`, the `colSpan` attribute, `/Figure` creation, `/Table` reuse across pages. `src/tablerender.ts` gains an optional `TableTagger` that it threads onto the `Placed` records it already builds in `placeRows`, then paints into the elements it gets back. This mirrors the `toc.ts` / `tocrender.ts` / `tocstruct.ts` split the project already uses, and keeps "where the ink goes" separate from "what the ink means".

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-tagged-table-authoring-design.md`
**Issue:** `aspose-pdf-foss-for-ts-7efj` (already claimed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (e.g. `import { TableTagger } from './tabletag.js';`), even though the files are `.ts`.
- **`strict` TypeScript.** `npm run typecheck` must be green before any commit.
- **`npm test` must be green** before any commit. Target one file with `npx vitest run test/<name>.test.ts`.
- **Untagged output must stay byte-identical.** `tagged` defaults to `false`; every new marking call site must be reachable only when `tagged` is true.
- **Validation precedes allocation.** A rejected call must leave the document byte-identical — validate before anything is allocated or painted.
- **Public errors** are `TypeError` for argument validation (the convention in `tableauthor.ts` and `toc.ts`), not the PDF-specific error types.
- **Naming collision to avoid:** `src/tablestruct.ts` and `test/table-tagged.test.ts` already exist and belong to table **extraction**. The new authoring module is `src/tabletag.ts` and the new test file is `test/table-authoring-tagged.test.ts`. The two stacks must never import each other.

---

### Task 1: `header` on `CellOptions`

Lets any cell be marked as a `/TH` with the right `/Scope`, and lets a cell opt *out* of the repeating-header-row inference. Model only — nothing reads it yet.

**Files:**
- Modify: `src/tableauthor.ts` (add `CellHeader`, extend `CellOptions`, `CellBuilder`, `addCell`, add `validateHeader`)
- Modify: `src/index.ts:83` (export the `CellHeader` type)
- Test: `test/table-author.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type CellHeader = boolean | 'row' | 'column';` in `src/tableauthor.ts`
  - `CellOptions.header?: CellHeader`
  - `CellBuilder.header?: CellHeader` (readonly, 4th constructor parameter)

- [ ] **Step 1: Write the failing tests**

Append to `test/table-author.test.ts`:

```ts
describe('cell header marking', () => {
  it('records the header kind on the cell', () => {
    const t = createTable();
    const row = t.addRow();
    expect(row.addCell('plain').header).toBeUndefined();
    expect(row.addCell('h', { header: true }).header).toBe(true);
    expect(row.addCell('c', { header: 'column' }).header).toBe('column');
    expect(row.addCell('r', { header: 'row' }).header).toBe('row');
    expect(row.addCell('opt-out', { header: false }).header).toBe(false);
  });

  it('rejects a header that is not a boolean or a scope name', () => {
    const row = createTable().addRow();
    expect(() => row.addCell('x', { header: 'both' as never })).toThrow(TypeError);
    expect(() => row.addCell('x', { header: 1 as never })).toThrow(TypeError);
  });

  it('does not leak header into the cell style', () => {
    // addCell spreads its options into the style object; `header` must be
    // destructured out or validateStyleOpts sees a key it does not know.
    const cell = createTable().addRow().addCell('x', { header: 'row', fontSize: 9 });
    expect('header' in cell.options).toBe(false);
    expect(cell.options.fontSize).toBe(9);
  });

  it('carries the header kind into a continuation table', () => {
    const t = createTable();
    t.addRow().addCell('H', { header: true });
    t.addRow().addCell('body');
    const cont = t.continuationFrom(0);
    expect(cont.rows[0].cells[0].header).toBe(true);
  });
});
```

`createTable` is already imported at the top of that file; if it is not, add it to the existing `import { … } from '../src/index.js';`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-author.test.ts`
Expected: FAIL — `header` is not a property of `CellOptions` (a `strict` type error at build, and `.header` is `undefined` at runtime).

- [ ] **Step 3: Implement**

In `src/tableauthor.ts`, above `CellOptions`:

```ts
/** How a cell is marked in a tagged table: a /TH carrying the given /Scope, or a
 *  /TD. `true` is shorthand for 'column'; `false` opts the cell out of the
 *  repeating-header-row inference, so a blank corner cell in a header row stays
 *  a /TD. */
export type CellHeader = boolean | 'row' | 'column';
```

Extend `CellOptions`:

```ts
/** `addCell` options: the per-cell text style plus an optional horizontal span. */
export interface CellOptions extends CellTextOptions {
  /** Number of columns this cell spans. Integer >= 1. Default 1. */
  colSpan?: number;
  /** Emit this cell as a /TH rather than a /TD when the table is drawn with
   *  `{ tagged: true }`. Default: cells in the repeating-header rows are column
   *  headers, every other cell is a /TD. Ignored when the table is drawn
   *  untagged. */
  header?: CellHeader;
}
```

Add the validator beside `validateColSpan`:

```ts
function validateHeader(h: unknown): void {
  if (h === undefined || typeof h === 'boolean' || h === 'row' || h === 'column') return;
  throw new TypeError("header must be a boolean, 'row', or 'column'");
}
```

Extend `CellBuilder`'s constructor (the class at `src/tableauthor.ts:205`):

```ts
  constructor(
    public text: string,
    readonly options: CellTextOptions,
    readonly colSpan: number = 1,
    readonly header?: CellHeader,
  ) {}
```

And `RowBuilder.addCell`:

```ts
  /** Append a cell with `text` (default '') and optional per-cell style/span. */
  addCell(text = '', opts: CellOptions = {}): CellBuilder {
    const { colSpan = 1, header, ...style } = opts;
    validateColSpan(colSpan);
    validateHeader(header);
    validateStyleOpts(style);
    const c = new CellBuilder(text, style, colSpan, header);
    this.cells.push(c);
    return c;
  }
```

In `src/index.ts:83`, add `CellHeader` to the existing `export type { … } from './tableauthor.js';` list.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/table-author.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/tableauthor.ts src/index.ts test/table-author.test.ts
git commit -m "feat(table): per-cell header marking for tagged tables (7efj)"
```

---

### Task 2: `alt` / `artifact` on cell images, and an artifact path for `drawBuiltImage`

`drawBuiltImage` can tag its draw into an element but has no way to mark it as an artifact. A cell image in a tagged table needs both routes.

**Files:**
- Modify: `src/imageembed.ts:129-159` (`drawBuiltImage` gains `artifact`)
- Modify: `src/tableauthor.ts` (`CellImageOptions` gains `alt` / `artifact`; `setImage` validates them)
- Test: `test/image-embed.test.ts`, `test/table-author.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `drawBuiltImage(doc, page, built, rect, opts)` where `opts: { opacity?: number; tag?: StructElement; artifact?: boolean }`
  - `CellImageOptions.alt?: string`, `CellImageOptions.artifact?: boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/image-embed.test.ts`, inside the existing `describe('drawBuiltImage', …)` block:

```ts
  it('wraps the draw in an /Artifact sequence when asked', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(40, 20, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [10, 10, 80, 40], { artifact: true });
    const text = content(doc);
    expect(text).toContain('/Artifact BMC');
    expect(text).toContain('EMC');
    expect(text.indexOf('/Artifact BMC')).toBeLessThan(text.indexOf('Do'));
  });

  it('draws bare when artifact is false', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(40, 20, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [10, 10, 80, 40], { artifact: false });
    expect(content(doc)).not.toContain('/Artifact BMC');
  });
```

Append to `test/table-author.test.ts`:

```ts
describe('cell image accessibility options', () => {
  it('keeps alt and artifact on the cell image', () => {
    const png = buildPngRgbWith(2, 2, [255, 0, 0]);
    const withAlt = createTable().addRow().addCell().setImage(png, { alt: 'a chart' });
    expect(withAlt.image!.opts.alt).toBe('a chart');
    const decorative = createTable().addRow().addCell().setImage(png, { artifact: true });
    expect(decorative.image!.opts.artifact).toBe(true);
  });

  it('rejects a non-string alt, a non-boolean artifact, and the two combined', () => {
    const png = buildPngRgbWith(2, 2, [255, 0, 0]);
    const cell = () => createTable().addRow().addCell();
    expect(() => cell().setImage(png, { alt: 7 as never })).toThrow(TypeError);
    expect(() => cell().setImage(png, { artifact: 'yes' as never })).toThrow(TypeError);
    expect(() => cell().setImage(png, { alt: 'x', artifact: true })).toThrow(TypeError);
  });
});
```

`buildPngRgbWith` comes from `./helpers/build-embed-images.js`; add it to that file's imports if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/image-embed.test.ts test/table-author.test.ts`
Expected: FAIL — no `/Artifact BMC` in the content, and `alt` / `artifact` are not properties of `CellImageOptions`.

- [ ] **Step 3: Implement**

In `src/imageembed.ts`, add `wrapArtifact` to the existing import from `'./pagecontent.js'` (the multi-line import starting at line 10, which already brings in `wrapMarkedContent`).

Change `drawBuiltImage`'s signature (line 129-133) and its marking (lines 154-158):

```ts
export function drawBuiltImage(
  doc: Document, page: Page, built: BuiltImage,
  rect: [number, number, number, number],
  opts: { opacity?: number; tag?: StructElement; artifact?: boolean } = {},
): void {
```

```ts
  const body = enc(s);
  // `tag` wins over `artifact`, matching structwrite.ts's markDrawing: the
  // caller named a specific element, and silently discarding it for an artifact
  // would be the more surprising reading.
  const marked = opts.tag
    ? wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body)
    : opts.artifact ? wrapArtifact(body) : body;
  appendContent(doc, page, marked);
```

In `src/tableauthor.ts`, extend `CellImageOptions`:

```ts
  /** Override JPEG/PNG sniffing. */
  format?: 'jpeg' | 'png';
  /** Alt text for the /Figure this image gets when the table is drawn with
   *  `{ tagged: true }`. Ignored when the table is drawn untagged. */
  alt?: string;
  /** Mark this image as an /Artifact when the table is drawn with
   *  `{ tagged: true }` — decoration that carries no meaning and gets no
   *  /Figure. Cannot be combined with `alt`. Ignored when drawn untagged. */
  artifact?: boolean;
```

And validate in `CellBuilder.setImage`, after the existing `checkOpacity` line and **before** `buildImageXObject` (so a rejected call builds nothing):

```ts
    if (opts.alt !== undefined && typeof opts.alt !== 'string')
      throw new TypeError('image alt must be a string');
    if (opts.artifact !== undefined && typeof opts.artifact !== 'boolean')
      throw new TypeError('image artifact must be a boolean');
    if (opts.artifact && opts.alt !== undefined)
      throw new TypeError('image artifact cannot be combined with alt');
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/image-embed.test.ts test/table-author.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/imageembed.ts src/tableauthor.ts test/image-embed.test.ts test/table-author.test.ts
git commit -m "feat(table): alt/artifact for cell images, artifact path for drawBuiltImage (7efj)"
```

---

### Task 3: `src/tabletag.ts` — the `TableTagger`

The structure module. It builds `/Table > /TR > /TD|/TH` and decides `/Scope` and `colSpan`. No `structParent` yet — the `/Table` always goes under the structure tree root. Nothing calls it yet; it is tested directly.

**Files:**
- Create: `src/tabletag.ts`
- Test: `test/table-authoring-tagged.test.ts` (create)

**Interfaces:**
- Consumes: `CellBuilder.header` and `CellBuilder.colSpan` from Task 1.
- Produces, all from `src/tabletag.ts`:
  - `export function validateTableTagging(opts: { tagged?: boolean }): void`
  - `export function headerScope(cell: CellBuilder, rowIndex: number, repeatingRows: number): 'Row' | 'Column' | undefined`
  - `export class TableTagger`, with `constructor(doc: Document)`, `readonly table: StructElement`, `beginRow(): void`, `cell(cell: CellBuilder, rowIndex: number, repeatingRows: number): StructElement`, `figure(cellElem: StructElement, alt?: string): StructElement`

- [ ] **Step 1: Write the failing tests**

Create `test/table-authoring-tagged.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { TableTagger, headerScope, validateTableTagging } from '../src/tabletag.js';

describe('headerScope', () => {
  const cellWith = (header?: boolean | 'row' | 'column') =>
    createTable().addRow().addCell('x', header === undefined ? {} : { header });

  it('infers a column header inside the repeating-header rows', () => {
    expect(headerScope(cellWith(), 0, 1)).toBe('Column');
    expect(headerScope(cellWith(), 1, 1)).toBeUndefined();
    expect(headerScope(cellWith(), 0, 0)).toBeUndefined();
  });

  it('lets an explicit header win over the inference', () => {
    expect(headerScope(cellWith('row'), 5, 0)).toBe('Row');
    expect(headerScope(cellWith('column'), 5, 0)).toBe('Column');
    expect(headerScope(cellWith(true), 5, 0)).toBe('Column');
  });

  it('lets header:false opt a cell out of the inference', () => {
    expect(headerScope(cellWith(false), 0, 1)).toBeUndefined();
  });
});

describe('validateTableTagging', () => {
  it('accepts an absent or boolean tagged', () => {
    expect(() => validateTableTagging({})).not.toThrow();
    expect(() => validateTableTagging({ tagged: true })).not.toThrow();
  });

  it('rejects a non-boolean tagged', () => {
    expect(() => validateTableTagging({ tagged: 'yes' as never })).toThrow(TypeError);
  });
});

describe('TableTagger', () => {
  const doc = () => Document.Open(buildBlankPage());

  it('appends a /Table under the structure tree root', () => {
    const d = doc();
    const tagger = new TableTagger(d);
    expect(tagger.table.Type).toBe('Table');
    expect(d.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);
  });

  it('builds /TR > /TD in call order', () => {
    const d = doc();
    const t = createTable();
    const r0 = t.addRow(['a', 'b']);
    const tagger = new TableTagger(d);
    tagger.beginRow();
    tagger.cell(r0.cells[0], 0, 0);
    tagger.cell(r0.cells[1], 0, 0);
    const rows = tagger.table.Children;
    expect(rows.map((r) => r.Type)).toEqual(['TR']);
    expect(rows[0].Children.map((c) => c.Type)).toEqual(['TD', 'TD']);
  });

  it('emits /TH with a /Scope for a header cell', () => {
    const d = doc();
    const t = createTable();
    const row = t.addRow();
    row.addCell('H');
    row.addCell('R', { header: 'row' });
    t.setRepeatingRowsCount(1);
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const a = tagger.cell(row.cells[0], 0, 1);
    const b = tagger.cell(row.cells[1], 0, 1);
    expect(a.Type).toBe('TH');
    expect(a.TableAttributes!.scope).toBe('Column');
    expect(b.Type).toBe('TH');
    expect(b.TableAttributes!.scope).toBe('Row');
  });

  it('writes ColSpan only for a spanning cell', () => {
    const d = doc();
    const row = createTable().addRow();
    row.addCell('wide', { colSpan: 3 });
    row.addCell('narrow');
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const wide = tagger.cell(row.cells[0], 0, 0);
    const narrow = tagger.cell(row.cells[1], 0, 0);
    expect(wide.TableAttributes!.colSpan).toBe(3);
    // readTable defaults an absent ColSpan to 1, so assert on the raw dict:
    // a plain cell must carry no /A at all.
    expect(narrow.Dict.has('A')).toBe(false);
  });

  it('appends a /Figure to a cell, carrying /Alt when given', () => {
    const d = doc();
    const row = createTable().addRow();
    row.addCell('x');
    const tagger = new TableTagger(d);
    tagger.beginRow();
    const cell = tagger.cell(row.cells[0], 0, 0);
    const fig = tagger.figure(cell, 'a chart');
    expect(fig.Type).toBe('Figure');
    expect(cell.Children.map((c) => c.Type)).toEqual(['Figure']);
    expect(fig.Alt).toBe('a chart');
  });

  it('throws when a cell is added before a row is opened', () => {
    const row = createTable().addRow(['a']);
    const tagger = new TableTagger(doc());
    expect(() => tagger.cell(row.cells[0], 0, 0)).toThrow();
  });
});
```

`StructElement.Alt` is a getter returning `string | undefined` (`src/struct.ts:108`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-authoring-tagged.test.ts`
Expected: FAIL — `Cannot find module '../src/tabletag.js'`.

- [ ] **Step 3: Implement**

Create `src/tabletag.ts`:

```ts
// The /Table + /TR + /TD structure subtree behind `page.AddTable({ tagged: true })`
// (issue 7efj). Structure only: no measurement, no painting. tablerender.ts
// builds a page slice's skeleton through this and then paints into the elements
// it hands back, which is why this is its own module — mirroring tocstruct.ts,
// where threading the tree through paintRow would have blurred "where the ink
// goes".
//
// Note the direction: tablestruct.ts is table *extraction* from an existing
// tagged tree. This is authoring. The two never import each other.
import type { Document } from './document.js';
import type { StructElement } from './struct.js';
import type { CellBuilder } from './tableauthor.js';

/** Validate a table's tagging options. Throws before the caller allocates or
 *  paints anything, so a rejected call leaves the document byte-identical. */
export function validateTableTagging(opts: { tagged?: boolean }): void {
  if (opts.tagged !== undefined && typeof opts.tagged !== 'boolean')
    throw new TypeError('tagged must be a boolean');
}

/** The /Scope a cell's /TH carries, or undefined when the cell is a /TD.
 *
 *  The cell's own `header` wins over the repeating-header inference in both
 *  directions: `false` is an opt-out, so a blank corner cell in a header row
 *  stays a /TD rather than becoming a header of nothing. */
export function headerScope(
  cell: CellBuilder, rowIndex: number, repeatingRows: number,
): 'Row' | 'Column' | undefined {
  const h = cell.header;
  if (h === 'row') return 'Row';
  if (h === 'column' || h === true) return 'Column';
  if (h === false) return undefined;
  return rowIndex < repeatingRows ? 'Column' : undefined;
}

/** Builds the /Table subtree for one `AddTable` call. One tagger spans every
 *  page a table is painted onto, so an auto-paginated table is a single /Table
 *  whose /TR list runs in draw order. */
export class TableTagger {
  /** The root /Table element this tagger fills. */
  readonly table: StructElement;

  /** The /TR the next `cell` joins; undefined before the first `beginRow`. */
  private row: StructElement | undefined;

  constructor(doc: Document) {
    this.table = doc.CreateStructTree().Append('Table');
  }

  /** Open a /TR. Every following `cell` joins it until the next `beginRow`. */
  beginRow(): void {
    this.row = this.table.Append('TR');
  }

  /** Append this cell's /TD or /TH to the open /TR and return it. */
  cell(cell: CellBuilder, rowIndex: number, repeatingRows: number): StructElement {
    if (this.row === undefined) throw new Error('cell before beginRow');
    const scope = headerScope(cell, rowIndex, repeatingRows);
    const elem = this.row.Append(scope === undefined ? 'TD' : 'TH');
    // Written only when there is something to say: readTable defaults an absent
    // ColSpan to 1, so an /A on every plain cell would be pure bloat.
    const attrs: { colSpan?: number; scope?: 'Row' | 'Column' } = {};
    if (cell.colSpan > 1) attrs.colSpan = cell.colSpan;
    if (scope !== undefined) attrs.scope = scope;
    if (attrs.colSpan !== undefined || attrs.scope !== undefined)
      elem.SetTableAttributes(attrs);
    return elem;
  }

  /** Append a /Figure to `cellElem` for its image, carrying `alt` when given. */
  figure(cellElem: StructElement, alt?: string): StructElement {
    return cellElem.Append('Figure', alt !== undefined ? { alt } : undefined);
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/table-authoring-tagged.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tabletag.ts test/table-authoring-tagged.test.ts
git commit -m "feat(table): TableTagger builds the /Table > /TR > /TD subtree (7efj)"
```

---

### Task 4: Wire tagging into `page.AddTable`

The integration. `AddTableOptions` gains `tagged`, `AddTableResult` gains `struct`, and the four painting passes learn their marking.

**Files:**
- Modify: `src/tablerender.ts` (options, result, `Placed`, `placeRows`, `paintPlaced`, `drawTable`)
- Test: `test/table-authoring-tagged.test.ts`

**Interfaces:**
- Consumes: `TableTagger`, `validateTableTagging` from Task 3; `CellImageOptions.alt` / `.artifact` from Task 2.
- Produces:
  - `AddTableOptions.tagged?: boolean`
  - `AddTableResult.struct?: StructElement`

- [ ] **Step 1: Write the failing tests**

Append to `test/table-authoring-tagged.test.ts` (add `buildPngRgbWith` from `./helpers/build-embed-images.js` to the imports):

```ts
describe('page.AddTable({ tagged: true })', () => {
  const taggedTable = () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    return { doc, res };
  };

  it('returns the /Table element and builds one /TR per row', () => {
    const { doc, res } = taggedTable();
    expect(res.struct!.Type).toBe('Table');
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);
    expect(res.struct!.Children.map((r) => r.Type)).toEqual(['TR', 'TR']);
  });

  it('emits /TH for the repeating-header row and /TD below it', () => {
    const { res } = taggedTable();
    const [head, body] = res.struct!.Children;
    expect(head.Children.map((c) => c.Type)).toEqual(['TH', 'TH']);
    expect(head.Children[0].TableAttributes!.scope).toBe('Column');
    expect(body.Children.map((c) => c.Type)).toEqual(['TD', 'TD']);
  });

  it('tags each cell text into its own cell element', () => {
    const { res } = taggedTable();
    const [head, body] = res.struct!.Children;
    expect(head.Children[0].GetText()).toContain('Name');
    expect(head.Children[1].GetText()).toContain('Qty');
    expect(body.Children[0].GetText()).toContain('Bolt');
    expect(body.Children[1].GetText()).toContain('12');
  });

  it('writes ColSpan for a spanning cell', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('Summary', { colSpan: 2 });
    t.addRow(['L', 'R']);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    expect(res.struct!.Children[0].Children[0].TableAttributes!.colSpan).toBe(2);
  });

  it('marks cell backgrounds and borders as artifacts', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      background: [0.9, 0.9, 0.9],
      border: { width: 0.5, color: [0, 0, 0] },
      outerBorder: { width: 1, color: [0, 0, 0] },
    });
    t.addRow(['a', 'b']);
    doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    const text = new TextDecoder().decode(doc.Pages[0].Contents);
    // Two artifact sequences: the background pass and the border pass.
    expect(text.split('/Artifact BMC').length - 1).toBe(2);
  });

  it('opens no artifact sequence for a pass that draws nothing', () => {
    // No background and no border anywhere: an unconditional BeginArtifact
    // would emit a bare /Artifact BMC EMC with no content between.
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    expect(new TextDecoder().decode(doc.Pages[0].Contents)).not.toContain('/Artifact BMC');
  });

  it('gives a cell image a /Figure under its cell, before the text', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('caption')
      .setImage(buildPngRgbWith(2, 2, [255, 0, 0]), { height: 20, alt: 'a red square' });
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    const cell = res.struct!.Children[0].Children[0];
    expect(cell.Children.map((c) => c.Type)).toEqual(['Figure']);
    // /K = [Figure, textMcid]: the figure is appended at cell-creation time, so
    // it precedes the text MCID in reading order as well as in paint order.
    const kids = cell.Dict.get('K') as unknown[];
    expect(kids.length).toBe(2);
  });

  it('artifacts a decorative cell image instead of giving it a /Figure', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('caption')
      .setImage(buildPngRgbWith(2, 2, [255, 0, 0]), { height: 20, artifact: true });
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    expect(res.struct!.Children[0].Children[0].Children).toEqual([]);
    expect(new TextDecoder().decode(doc.Pages[0].Contents)).toContain('/Artifact BMC');
  });

  it('builds no structure tree when a tagged call draws nothing', () => {
    const doc = Document.Open(buildBlankPage());
    const res = doc.Pages[0].AddTable(createTable(), 72, 720, { width: 300, tagged: true });
    expect(res.struct).toBeUndefined();
    expect(doc.GetStructTree()).toBeNull();
  });

  it('rejects a non-boolean tagged before painting anything', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    const before = doc.Pages[0].Contents.length;
    expect(() => doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: 'yes' as never }))
      .toThrow(TypeError);
    expect(doc.Pages[0].Contents.length).toBe(before);
    expect(doc.GetStructTree()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-authoring-tagged.test.ts`
Expected: FAIL — `tagged` is not a property of `AddTableOptions`, `res.struct` is undefined.

- [ ] **Step 3: Implement**

In `src/tablerender.ts`, add the imports:

```ts
import type { StructElement } from './struct.js';
import { TableTagger, validateTableTagging } from './tabletag.js';
```

Add to `AddTableOptions` (after `topMargin`):

```ts
  /** Emit /Table + /TR + /TD logical structure into the document structure tree.
   *  Default false, in which case output is byte-identical to an untagged call.
   *  Cell text is tagged into its cell element (a /TH for the repeating-header
   *  rows and for cells marked with `header`, a /TD otherwise); cell images get
   *  a /Figure under their cell; cell backgrounds, cell borders and the outer
   *  border are marked as /Artifact. */
  tagged?: boolean;
```

Add to `AddTableResult` (after `remainder`):

```ts
  /** The /Table element, when `tagged` and at least one row was drawn. An
   *  auto-paginated table is a single /Table across all its pages. */
  struct?: StructElement;
```

Extend `Placed` (line 47-50):

```ts
interface Placed {
  x: number; bottom: number; w: number; h: number; text: string; style: ResolvedStyle;
  image?: { built: BuiltImage; width: number; height: number; opts: CellImageOptions };
  /** The /TD or /TH this cell's text is tagged into. Tagged mode only. */
  struct?: StructElement;
  /** The /Figure this cell's image is tagged into. Tagged mode only, and absent
   *  for an image the caller marked decorative. */
  figure?: StructElement;
}
```

Rewrite `placeRows` to take the tagger and build the skeleton as it walks:

```ts
function placeRows(
  table: TableBuilder, rowIndices: number[],
  rowHeights: number[], columnX: number[], widths: number[], top: number,
  tagger?: TableTagger,
): Placed[] {
  const placed: Placed[] = [];
  let rowTop = top;
  for (const r of rowIndices) {
    const rowBottom = rowTop - rowHeights[r];
    tagger?.beginRow();
    let c = 0;
    for (const cell of table.rows[r].cells) {
      let cellW = 0;
      for (let k = 0; k < cell.colSpan; k++) cellW += widths[c + k];
      const struct = tagger?.cell(cell, r, table.repeatingRowCount);
      // Appended here, not in the image pass: paintPlaced draws every image
      // before any text, so allocating the /Figure at cell-creation time is what
      // keeps a cell's /K in reading order — [Figure, textMcid].
      const figure = struct !== undefined && cell.image !== undefined && !cell.image.opts.artifact
        ? tagger!.figure(struct, cell.image.opts.alt)
        : undefined;
      placed.push({
        x: columnX[c], bottom: rowBottom, w: cellW, h: rowHeights[r],
        text: cell.text, style: resolveCellStyle(cell, table.rows[r].style, table.defaults),
        image: cell.image, struct, figure,
      });
      c += cell.colSpan;
    }
    rowTop = rowBottom;
  }
  return placed;
}
```

Rewrite `paintPlaced` to take `tagged` and mark each pass. Pass 1 and pass 3 open an artifact sequence **only when the pass draws something**:

```ts
function paintPlaced(
  doc: Document, page: Page, placed: Placed[], padding: number,
  outerBorder: BorderInfo | undefined, blockRect: BlockRect | undefined,
  tagged: boolean,
): void {
  // Pass 1: backgrounds (bottom). A cell fill is decoration, so in a tagged
  // table it is an artifact or it trips UntaggedContent. The sequence is opened
  // only when there is a fill to put in it: apply() no-ops on an empty part
  // list, but BeginArtifact pushes a part, so an unconditional call would emit a
  // bare /Artifact BMC EMC into a table that has no backgrounds at all.
  const filled = placed.filter((p) => p.style.background !== undefined);
  if (filled.length > 0) {
    const bg = new PageGraphics(doc, page);
    if (tagged) bg.BeginArtifact();
    for (const p of filled)
      bg.setFillColor(p.style.background!).drawRect(p.x, p.bottom, p.w, p.h).fill();
    if (tagged) bg.EndMarkedContent();
    bg.apply();
  }

  // Pass 1.5: cell images (above backgrounds, below text). Contained (aspect-
  // preserving) into innerWidth x imageContentHeight, then placed in the full
  // inner box by the image's align/valign (defaulting to the cell's).
  for (const p of placed) {
    if (!p.image) continue;
    const innerW = p.w - 2 * padding;
    const innerH = p.h - 2 * padding;
    if (innerW <= 0 || innerH <= 0) continue;
    const { built, width: imgW, height: imgH, opts } = p.image;
    const boxH = opts.height ?? imgH * innerW / imgW;   // measured image content height
    const scale = Math.min(innerW / imgW, boxH / imgH);
    const drawnW = imgW * scale;
    const drawnH = imgH * scale;
    const align = opts.align ?? p.style.align;
    const valign = opts.valign ?? p.style.valign;
    const ix = p.x + padding, iy = p.bottom + padding;
    const dx = align === 'center' ? (innerW - drawnW) / 2 : align === 'right' ? innerW - drawnW : 0;
    const dy = valign === 'center' ? (innerH - drawnH) / 2 : valign === 'top' ? innerH - drawnH : 0;
    // Untagged, the marking options are ignored entirely — output stays
    // byte-identical to a table drawn without them.
    const mark = p.figure !== undefined
      ? { tag: p.figure }
      : tagged && opts.artifact ? { artifact: true } : {};
    drawBuiltImage(doc, page, built, [ix + dx, iy + dy, drawnW, drawnH],
      { opacity: opts.opacity, ...mark });
  }

  // Pass 2: cell text (middle), aligned per resolved style.
  for (const p of placed)
    stampTextBlock(doc, page, p.text,
      [p.x + padding, p.bottom + padding, p.w - 2 * padding, p.h - 2 * padding],
      // The cell's `textBackground` becomes the stamp's `background`: inside a
      // cell, `background` already means the box fill.
      { font: p.style.font, fontSize: p.style.fontSize, leading: p.style.leading,
        color: p.style.color, align: p.style.align, valign: p.style.valign,
        underline: p.style.underline, strikethrough: p.style.strikethrough,
        background: p.style.textBackground, tag: p.struct });

  // Pass 3: cell borders + the block's outer border (top). Each border fully
  // sets its state (width/color/dash) so nothing leaks; dash `[]` means solid.
  // Artifacted as one sequence, on the same only-when-drawn rule as pass 1.
  const bordered = placed.filter((p) => p.style.border !== undefined);
  const hasOuter = outerBorder !== undefined && blockRect !== undefined;
  if (bordered.length > 0 || hasOuter) {
    const bd = new PageGraphics(doc, page);
    if (tagged) bd.BeginArtifact();
    for (const p of bordered) {
      const b = p.style.border!;
      bd.setLineWidth(b.width).setStrokeColor(b.color).setDash(b.dash ?? [])
        .drawRect(p.x, p.bottom, p.w, p.h).stroke();
    }
    if (hasOuter) {
      const ob = outerBorder!;
      bd.setLineWidth(ob.width).setStrokeColor(ob.color).setDash(ob.dash ?? [])
        .drawRect(blockRect!.x, blockRect!.bottom, blockRect!.w, blockRect!.h).stroke();
    }
    if (tagged) bd.EndMarkedContent();
    bd.apply();
  }
}
```

In `drawTable`, validate first, then hold the tagger and build it lazily:

```ts
export function drawTable(
  doc: Document, page: Page, table: TableBuilder,
  x: number, top: number, opts: AddTableOptions,
): AddTableResult {
  validateTableTagging(opts);
  const widths = table.resolveColumnWidths(opts.width);
  if (widths.length === 0) return { pages: [page], endY: top, remainder: undefined };
```

Then, right before `paintRows` is defined:

```ts
  const tagged = opts.tagged ?? false;
  // A holder rather than a bare `let`: paintRows is a closure, and TypeScript
  // narrows a closure-assigned local back to `undefined` at the return sites.
  const tagging: { tagger?: TableTagger } = {};
```

And `paintRows` becomes:

```ts
  const paintRows = (pg: Page, rowIndices: number[], sliceTop: number): void => {
    if (rowIndices.length === 0) return;
    // Built on the first PAINTED slice, so a tagged call that draws nothing
    // bootstraps no structure tree and leaves the document untouched.
    if (tagged && tagging.tagger === undefined) tagging.tagger = new TableTagger(doc);
    let h = 0;
    for (const r of rowIndices) h += rowHeights[r];
    const placed = placeRows(table, rowIndices, rowHeights, columnX, widths, sliceTop, tagging.tagger);
    paintPlaced(doc, pg, placed, padding, ob, { x, bottom: sliceTop - h, w: tableWidth, h }, tagged);
  };
```

Finally add `struct: tagging.tagger?.table` to **both** return statements at the end of `drawTable` — the manual-overflow one inside the loop and the final one:

```ts
      if (!autoPaginate)
        return {
          pages, endY: sliceTop - usedHeight, remainder: table.continuationFrom(i),
          struct: tagging.tagger?.table,
        };
```

```ts
  return { pages, endY: sliceTop - usedHeight, remainder: undefined, struct: tagging.tagger?.table };
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/table-authoring-tagged.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the whole table suite for regressions**

Run: `npx vitest run test/table-render.test.ts test/table-author.test.ts test/table-decoration.test.ts test/table-nested.test.ts`
Expected: PASS — `paintPlaced` was restructured, and these cover the untagged paths it must not have changed.

- [ ] **Step 6: Commit**

```bash
git add src/tablerender.ts test/table-authoring-tagged.test.ts
git commit -m "feat(table): tagged mode for page.AddTable (7efj)"
```

---

### Task 5: Continuation — one `/Table` across pages

An auto-paginated table already shares one tagger, so it is already one `/Table`; this task proves it and adds the manual-pagination route, where the caller passes `result.struct` back as `structParent`.

**Files:**
- Modify: `src/tabletag.ts` (`TableTaggerOptions`, `structParent` reuse, `structParent` validation)
- Modify: `src/tablerender.ts` (`AddTableOptions.structParent`, pass it to the tagger, pass `doc` to the validator)
- Test: `test/table-authoring-tagged.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3 and 4.
- Produces:
  - `validateTableTagging(doc: Document, opts: { tagged?: boolean; structParent?: StructElement }): void` — **note the new first parameter**; update the Task 4 call site.
  - `export interface TableTaggerOptions { structParent?: StructElement }`
  - `new TableTagger(doc, opts)` — **note the new second parameter**; update the Task 4 call site.
  - `AddTableOptions.structParent?: StructElement`

- [ ] **Step 1: Write the failing tests**

Append to `test/table-authoring-tagged.test.ts`:

```ts
describe('a tagged table continued across pages', () => {
  /** Ten rows over a short bottom margin, so the table must break. */
  const tallTable = () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Name', 'Qty']);
    for (let i = 0; i < 40; i++) t.addRow([`item ${i}`, String(i)]);
    t.setRepeatingRowsCount(1);
    return t;
  };

  it('auto-pagination produces one /Table with the header repeated as a /TR', () => {
    const doc = Document.Open(buildBlankPage());
    const res = doc.Pages[0].AddTable(tallTable(), 72, 760, {
      width: 300, tagged: true, autoPaginate: true, bottomMargin: 600,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);

    const rows = res.struct!.Children;
    // 41 authored rows + one reprinted header per continuation page.
    expect(rows.length).toBe(41 + (res.pages.length - 1));
    // Every reprint is a real /TR of /TH cells, in draw order.
    const headerRows = rows.filter((r) => r.Children.every((c) => c.Type === 'TH'));
    expect(headerRows.length).toBe(res.pages.length);
  });

  it('binds each row to the page it was actually drawn on', () => {
    const doc = Document.Open(buildBlankPage());
    const res = doc.Pages[0].AddTable(tallTable(), 72, 760, {
      width: 300, tagged: true, autoPaginate: true, bottomMargin: 600,
    });
    const rows = res.struct!.Children;
    const firstCellPage = (r: (typeof rows)[number]) => r.Children[0].Page?.Number;
    expect(firstCellPage(rows[0])).toBe(res.pages[0].Number);
    expect(firstCellPage(rows[rows.length - 1])).toBe(res.pages[res.pages.length - 1].Number);
  });

  it('manual pagination stays one /Table when struct is passed back', () => {
    const doc = Document.Open(buildBlankPage());
    const first = doc.Pages[0].AddTable(tallTable(), 72, 760, {
      width: 300, tagged: true, bottomMargin: 600,
    });
    expect(first.remainder).toBeDefined();

    const page2 = doc.AddPage().page;
    const second = page2.AddTable(first.remainder!, 72, 760, {
      width: 300, tagged: true, structParent: first.struct,
    });
    expect(second.struct!.Dict).toBe(first.struct!.Dict);   // reused, not nested
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Table']);
  });

  it('nests the /Table under a non-/Table structParent', () => {
    const doc = Document.Open(buildBlankPage());
    const sect = doc.CreateStructTree().Append('Sect');
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true, structParent: sect });
    expect(sect.Children.map((c) => c.Type)).toEqual(['Table']);
    expect(res.struct!.Dict).toBe(sect.Children[0].Dict);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Sect']);
  });

  it('rejects structParent without tagged, and a foreign structParent', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    const sect = doc.CreateStructTree().Append('Sect');

    expect(() => doc.Pages[0].AddTable(t, 72, 720, { width: 300, structParent: sect }))
      .toThrow(TypeError);

    const other = Document.Open(buildBlankPage());
    const foreign = other.CreateStructTree().Append('Sect');
    const before = doc.Pages[0].Contents.length;
    expect(() => doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true, structParent: foreign }))
      .toThrow(TypeError);
    expect(doc.Pages[0].Contents.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table-authoring-tagged.test.ts`
Expected: FAIL — `structParent` is not a property of `AddTableOptions`.

- [ ] **Step 3: Implement**

In `src/tabletag.ts`, replace `validateTableTagging` with the two-argument form:

```ts
/** Validate a table's tagging options. Throws before the caller allocates or
 *  paints anything, so a rejected call leaves the document byte-identical. */
export function validateTableTagging(
  doc: Document, opts: { tagged?: boolean; structParent?: StructElement },
): void {
  const tagged = opts.tagged ?? false;
  if (typeof tagged !== 'boolean') throw new TypeError('tagged must be a boolean');
  const sp = opts.structParent;
  if (sp === undefined) return;
  // Explicit rejection rather than implying `tagged`: an unused option must
  // never silently change output.
  if (!tagged) throw new TypeError('structParent requires tagged: true');
  if (sp.Ref === undefined)
    throw new TypeError('structParent must be a structure element with an indirect ref');
  const root = doc.GetStructTree();
  if (!root || sp.Root.Dict !== root.Dict)
    throw new TypeError('structParent belongs to a different document');
}
```

Add the options interface above the class:

```ts
export interface TableTaggerOptions {
  /** Element to append the /Table under; a /Table element is *reused* rather
   *  than nested. Default: the structure tree root. */
  structParent?: StructElement;
}
```

And change the constructor:

```ts
  constructor(doc: Document, opts: TableTaggerOptions = {}) {
    const parent = opts.structParent;
    // A /Table parent is continuation, not nesting: a manual-pagination loop
    // hands back the previous call's element so a three-page table is one table.
    this.table = parent !== undefined && parent.Type === 'Table'
      ? parent
      : (parent ?? doc.CreateStructTree()).Append('Table');
  }
```

> `StructTreeRoot.Append` and `StructElement.Append` have the same signature, so
> the `parent ?? doc.CreateStructTree()` union needs no narrowing. If `strict`
> complains, give the expression an explicit
> `const host: { Append(type: string, opts?: ElemOpts): StructElement } = parent ?? doc.CreateStructTree();`
> and import `ElemOpts` from `./structwrite.js` — the same shape `tocstruct.ts`
> relies on.

In `src/tablerender.ts`, add to `AddTableOptions`:

```ts
  /** Element to append the /Table under. Default: the structure tree root. When
   *  this element is itself a /Table it is *reused* rather than nested, which is
   *  how a manual-pagination loop keeps one table across pages — pass back
   *  {@link AddTableResult.struct}. Requires `tagged: true`. */
  structParent?: StructElement;
```

Update the validator call at the top of `drawTable`:

```ts
  validateTableTagging(doc, opts);
```

And the tagger construction inside `paintRows`:

```ts
    if (tagged && tagging.tagger === undefined)
      tagging.tagger = new TableTagger(doc, { structParent: opts.structParent });
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run test/table-authoring-tagged.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tabletag.ts src/tablerender.ts test/table-authoring-tagged.test.ts
git commit -m "feat(table): one /Table across a paginated tagged table (7efj)"
```

---

### Task 6: The guarantee, the read-back, and the docs

Closes the loop: prove the motivating bug is fixed, prove untagged output did not move, prove the tree is readable by the extraction stack, and document the feature.

**Files:**
- Test: `test/table-authoring-tagged.test.ts`
- Modify: `README.md` (the `AddTable` section)
- Modify: `CLAUDE.md` (the `tableauthor.ts` / `tablerender.ts` architecture bullet)

**Interfaces:**
- Consumes: everything from Tasks 1-5. Produces nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `test/table-authoring-tagged.test.ts` (add `extractTaggedTables` to the `'../src/index.js'` import):

```ts
describe('the UntaggedContent guarantee', () => {
  const fires = (doc: Document) =>
    doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

  const styledTable = () => {
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      background: [0.9, 0.9, 0.9],
      border: { width: 0.5, color: [0, 0, 0] },
      outerBorder: { width: 1, color: [0, 0, 0] },
    });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    t.setRepeatingRowsCount(1);
    return t;
  };

  it('fires for a table drawn untagged into a tagged document', () => {
    const doc = Document.Open(buildBlankPage());
    doc.CreateStructTree();                       // the document is tagged
    doc.Pages[0].AddTable(styledTable(), 72, 720, { width: 300 });
    expect(fires(doc)).toBe(true);                // the bug 7efj is about
  });

  it('stays silent for the same table drawn tagged', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddTable(styledTable(), 72, 720, { width: 300, tagged: true });
    expect(fires(doc)).toBe(false);
  });
});

describe('untagged output is unchanged', () => {
  const build = (tagged: boolean) => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      background: [0.9, 0.9, 0.9],
      border: { width: 0.5, color: [0, 0, 0] },
    });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    doc.Pages[0].AddTable(t, 72, 720, tagged ? { width: 300, tagged: true } : { width: 300 });
    return doc;
  };

  it('draws byte-identical content with tagged absent and tagged: false', () => {
    const absent = Document.Open(buildBlankPage());
    const explicit = Document.Open(buildBlankPage());
    for (const [doc, opts] of [
      [absent, { width: 300 }],
      [explicit, { width: 300, tagged: false }],
    ] as const) {
      const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
      t.addRow(['Name', 'Qty']);
      doc.Pages[0].AddTable(t, 72, 720, opts);
    }
    expect(explicit.Pages[0].Contents).toEqual(absent.Pages[0].Contents);
  });

  it('adds only marked-content operators when tagged', () => {
    const plain = new TextDecoder().decode(build(false).Pages[0].Contents);
    const tagged = new TextDecoder().decode(build(true).Pages[0].Contents);
    expect(plain).not.toContain('BDC');
    expect(plain).not.toContain('BMC');
    // Strip the marking and the two streams must agree operator for operator.
    const strip = (s: string) => s
      .split('\n')
      .filter((l) => !/(BDC|BMC|EMC)\s*$/.test(l.trim()))
      .join('\n');
    expect(strip(tagged)).toBe(plain);
  });
});

describe('the authored tree reads back through the extraction stack', () => {
  it('extractTaggedTables recovers the rows, columns and header flags', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Name', 'Qty']);
    t.addRow(['Bolt', '12']);
    t.setRepeatingRowsCount(1);
    doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });

    const [table] = extractTaggedTables(doc, doc.Pages[0]);
    expect(table.rowCount).toBe(2);
    expect(table.colCount).toBe(2);
    expect(table.rows[0].cells[0].isHeader).toBe(true);
    expect(table.rows[0].cells[0].scope).toBe('Column');
    expect(table.rows[1].cells[0].isHeader).toBeUndefined();
    expect(table.rows[1].cells[0].text).toContain('Bolt');
  });
});
```

`Table` exposes `rowCount` and `colCount` (`src/tablemodel.ts:35`) — note it is
`colCount`, not `columnCount`.

- [ ] **Step 2: Run the tests to verify they fail (or reveal a real gap)**

Run: `npx vitest run test/table-authoring-tagged.test.ts`
Expected: these may pass immediately, since Tasks 1-5 implement the behaviour. **That is not evidence.** Prove each assertion is load-bearing before moving on — see Step 3.

- [ ] **Step 3: Prove the new assertions are load-bearing**

For each of the three describe blocks, break the code path and confirm the suite goes red, then revert:

1. In `paintPlaced`, delete the `if (tagged) bd.BeginArtifact();` / `bd.EndMarkedContent();` pair → the `stays silent for the same table drawn tagged` test must FAIL.
2. In `paintPlaced`'s pass 2, drop `tag: p.struct` from the `stampTextBlock` options → `stays silent…` must FAIL, and the read-back's `text` assertion must FAIL.
3. In `TableTagger.cell`, always `Append('TD')` → the read-back's `isHeader` / `scope` assertions must FAIL.
4. In `paintPlaced`, make pass 1 and pass 3 open their artifact sequence unconditionally (drop the `filled.length > 0` / `bordered.length > 0` guards) → the `adds only marked-content operators when tagged` and `opens no artifact sequence for a pass that draws nothing` tests must FAIL.

Revert each mutation immediately after confirming red. Do not commit any of them.

- [ ] **Step 4: Update the docs**

In `README.md`, find the `AddTable` section and add the tagged mode. Append after the existing options prose:

```markdown
Pass `{ tagged: true }` to emit logical structure alongside the ink: the table
becomes a `/Table` of `/TR` rows whose cells are `/TD`, or `/TH` for the
repeating-header rows (`setRepeatingRowsCount`) and for any cell built with
`{ header: 'row' | 'column' }`. Cell backgrounds and borders are marked as
artifacts, and a cell image gets a `/Figure` carrying the `alt` passed to
`setImage`. Without it, output is byte-identical to an untagged call.

A paginated table stays a single `/Table`: in auto mode automatically, and in
manual mode by passing `result.struct` back as `structParent` on the next call.
```

In `CLAUDE.md`, extend the `tableauthor.ts` / `tablerender.ts` architecture bullet with a sentence naming the new module, and add the invariant:

```markdown
  `tabletag.ts` is the authoring-side structure module behind
  `AddTable({ tagged: true })` — the `/Table` > `/TR` > `/TD`|`/TH` subtree, its
  `/Scope` and `ColSpan` attributes, and the `/Table` reuse that keeps a
  paginated table one table. Its own module for tocstruct.ts's reason: threading
  the tree through `paintPlaced` would blur "where the ink goes". Note the
  direction — `tablestruct.ts` is table *extraction*, and the two never import
  each other.
  **Invariant:** a cell's `/Figure` is appended when the cell element is created,
  not in the image pass. `paintPlaced` draws every image before any text, so
  allocating it later would put the text MCID ahead of the figure in the cell's
  `/K` and reverse its reading order.
  **Invariant:** the two `PageGraphics` passes open their `/Artifact` sequence
  only when they actually draw. `apply()` no-ops on an empty part list but
  `BeginArtifact` pushes a part, so an unconditional call emits a bare
  `/Artifact BMC EMC` into a table with no backgrounds — moving bytes for no
  content, and breaking the byte-identical guarantee the untagged path relies on.
```

- [ ] **Step 5: Run the full suite and the typecheck**

Run: `npm run typecheck && npm test`
Expected: both green. Report any failure with its output rather than working around it.

- [ ] **Step 6: Commit and close the issue**

```bash
git add test/table-authoring-tagged.test.ts README.md CLAUDE.md
git commit -m "test(table): UntaggedContent guarantee and read-back for tagged tables (7efj)"
bd close aspose-pdf-foss-for-ts-7efj
```

- [ ] **Step 7: Push**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: public surface → Tasks 1, 2, 4, 5; the tree → Task 3; where each pass lands → Task 4; element creation order → Task 4 (asserted by the `/K = [Figure, textMcid]` test); validation → Tasks 1, 2, 3, 5; tests → Tasks 1-6; out-of-scope items are absent from every task, as intended.

**Signature changes across tasks.** `validateTableTagging` and `TableTagger`'s constructor both gain a parameter in Task 5. Both call sites are named explicitly in Task 5 Step 3, and the Interfaces block flags the change.
