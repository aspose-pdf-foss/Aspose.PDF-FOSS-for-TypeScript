# AutoTag Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `doc.AutoTag` to tag `GetTables`-detected tables as `Table > TR > TH/TD` (headers, spans, summary, scope), excluding table text from the paragraph/heading pass. Add `AutoTagOptions.tables` (default true) and `AutoTagReport.tables`.

**Architecture:** All changes are in `src/autotag.ts` (plus the report/option types). A `tagTables` helper builds the table subtree using the existing `StructElement.MarkContent` (pwi.1) and `SetTableAttributes`; the per-page loop runs tables first, then skips text blocks whose center falls inside a table.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps.

## Global Constraints

- Zero runtime deps; ESM + NodeNext (`.js` specifiers).
- Heuristic and documented; first row of a multi-row table → `TH` (standard first-row-header convention) in addition to any `cell.isHeader`.
- UA structure: `Table > TR > TH/TD` (validator requires `TR` under a table-family element and `TH`/`TD` under `TR`).
- Run `npm run typecheck` and `npm test` green before closing.
- Keep `README.md` in sync.

---

### Task 1: tag tables in `autoTag`

**Files:**
- Modify: `src/autotag.ts` (option + report fields, `tagTables`, per-page wiring, block exclusion)
- Test: `test/autotag.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `page.GetTables()` → `Table[]` (`src/tablemodel.js`), `root.Append`/`element.Append`/`element.MarkContent`/`element.SetTableAttributes` (existing), `TableAttributes` (`src/structattr.js`), `Rect` (`src/text.js`).
- Produces:
  - `AutoTagOptions.tables?: boolean` (default true)
  - `AutoTagReport.tables: number`
  - internal `tagTables(doc, root, page, tables): number`

- [ ] **Step 1: Write the failing test**

Add to `test/autotag.test.ts` (extend the top imports with the ruled-table fixture helpers):

```ts
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';

// A 2x2 ruled grid with cell text (same construction as the table tests).
const TABLE = hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
  + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
  + text(55, 175, 'A') + text(105, 175, 'B')
  + text(55, 125, 'C') + text(105, 125, 'D');

describe('doc.AutoTag — tables', () => {
  it('tags a ruled table as Table > TR > TH/TD with first-row headers', () => {
    const doc = Document.Open(buildTablePdf(TABLE));
    const report = doc.AutoTag();
    expect(report.tables).toBe(1);

    const re = Document.Open(doc.Save());
    const kids = re.GetStructTree()!.Children;
    const table = kids.find((c) => c.Type === 'Table')!;
    expect(table).toBeDefined();
    const trs = table.Children;
    expect(trs.map((r) => r.Type)).toEqual(['TR', 'TR']);
    expect(trs[0].Children.map((c) => c.Type)).toEqual(['TH', 'TH']); // header row
    expect(trs[1].Children.map((c) => c.Type)).toEqual(['TD', 'TD']); // body row
    expect(trs[0].Children[0].GetText()).toContain('A');              // MCID round-trip
    expect(trs[1].Children[1].GetText()).toContain('D');
    expect(trs[0].Children[0].TableAttributes?.scope).toBe('Column');

    // Table text is not also tagged as a paragraph.
    expect(kids.some((c) => c.Type === 'P')).toBe(false);
  });

  it('reports no TableStructure errors from ValidatePdfUa', () => {
    const doc = Document.Open(buildTablePdf(TABLE));
    doc.AutoTag();
    expect(doc.ValidatePdfUa().Errors.some((e) => e.rule === 'TableStructure')).toBe(false);
  });

  it('skips table tagging when opts.tables is false', () => {
    const doc = Document.Open(buildTablePdf(TABLE));
    const report = doc.AutoTag({ tables: false });
    expect(report.tables).toBe(0);
    expect(doc.GetStructTree()!.Children.some((c) => c.Type === 'Table')).toBe(false);
    expect(report.paragraphs).toBeGreaterThan(0); // cells fell back to P/H
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/autotag.test.ts`
Expected: FAIL — `report.tables` is undefined / no `Table` element / `tables` option ignored.

- [ ] **Step 3: Add the option + report fields**

In `src/autotag.ts`, add `tables?` to `AutoTagOptions`:

```ts
  /** Detect and tag tables (via GetTables). Default true. */
  tables?: boolean;
```

Add `tables` to `AutoTagReport`:

```ts
export interface AutoTagReport {
  headings: number;
  paragraphs: number;
  figures: number;
  artifacts: number;
  tables: number;
}
```

- [ ] **Step 4: Add imports + `tagTables` + helpers**

Extend the imports at the top of `src/autotag.ts`:

```ts
import type { Rect, TextBlock, ImageEvent } from './text.js';
import type { Table } from './tablemodel.js';
import type { TableAttributes } from './structattr.js';
```
(Merge `Rect` into the existing `./text.js` type import; keep the value import of `visitContent` separate.)

Add near the other helpers (before `autoTag`):

```ts
const SCOPES = new Set(['Row', 'Column', 'Both']);

/** True when the center of `box` lies inside `region`. */
function centerInside(box: Rect, region: Rect): boolean {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const x0 = Math.min(region[0], region[2]), x1 = Math.max(region[0], region[2]);
  const y0 = Math.min(region[1], region[3]), y1 = Math.max(region[1], region[3]);
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

/** Tag each table as Table > TR > TH/TD, marking cell content. First row of a
 *  multi-row table is treated as a header (TH, scope Column) unless a cell already
 *  declares isHeader. Returns the number of tables tagged. */
function tagTables(doc: Document, root: ReturnType<Document['CreateStructTree']>, page: Document['Pages'][number], tables: Table[]): number {
  let count = 0;
  for (const table of tables) {
    const tEl = root.Append('Table');
    if (table.summary) tEl.SetTableAttributes({ summary: table.summary });
    const multiRow = table.rowCount >= 2;
    table.rows.forEach((row, ri) => {
      const trEl = tEl.Append('TR');
      for (const cell of row.cells) {
        const heuristicHeader = multiRow && ri === 0;
        const isHeader = cell.isHeader === true || heuristicHeader;
        const cellEl = trEl.Append(isHeader ? 'TH' : 'TD');
        const attrs: Partial<TableAttributes> = {};
        if (cell.rowSpan > 1) attrs.rowSpan = cell.rowSpan;
        if (cell.colSpan > 1) attrs.colSpan = cell.colSpan;
        const scope = cell.scope && SCOPES.has(cell.scope)
          ? (cell.scope as 'Row' | 'Column' | 'Both')
          : (heuristicHeader ? 'Column' : undefined);
        if (scope) attrs.scope = scope;
        if (Object.keys(attrs).length > 0) cellEl.SetTableAttributes(attrs);
        cellEl.MarkContent(page, cell.quad);
      }
    });
    count++;
  }
  return count;
}
```

(If `ReturnType<Document['CreateStructTree']>` / `Document['Pages'][number]` are awkward, import `StructTreeRoot` from `./struct.js` and `Page` from `./page.js` as types and use those instead.)

- [ ] **Step 5: Wire tables into the per-page loop + exclude table text**

In `autoTag`, change the report initializer to include `tables: 0`:

```ts
  const report: AutoTagReport = { headings: 0, paragraphs: 0, figures: 0, artifacts: 0, tables: 0 };
```

Replace the body of `for (const page of doc.Pages) {` so tables run first and text blocks skip table regions:

```ts
  for (const page of doc.Pages) {
    const tables = (opts.tables ?? true) ? page.GetTables() : [];
    report.tables += tagTables(doc, root, page, tables);
    const tableQuads = tables.map((t) => t.quad);

    for (const block of page.GetStructuredText()) {
      if (block.text.trim().length === 0) continue;
      if (tableQuads.some((q) => centerInside(block.quad, q))) continue; // tagged as a cell
      const level = ranks.get(dominantSize(block));
      const isHeading = level !== undefined && block.lines.length <= 2;
      const el = root.Append(isHeading ? `H${level}` : 'P');
      el.MarkContent(page, block.quad);
      if (isHeading) report.headings++; else report.paragraphs++;
    }

    // Images: Figure with /Alt when described, else /Artifact. (unchanged)
    const images: ImageEvent[] = [];
    visitContent(doc, page, { image: (e) => { if (e.addr.path.length === 0) images.push(e); } });
    for (const img of images) {
      const alt = opts.alt?.(img);
      if (alt !== undefined) {
        const el = root.Append('Figure', { alt });
        if (el.MarkContent(page, img.quad) >= 0) report.figures++;
      } else {
        const span = regionOpSpan(doc, page, img.quad);
        if (span) {
          const ec = new EditableContent(doc, page);
          wrapRegionOps(
            ec, span.streamIndex, span.min, span.max,
            { operator: 'BMC', operands: [name('Artifact')] },
            { operator: 'EMC', operands: [] },
          );
          ec.commit();
          report.artifacts++;
        }
      }
    }
  }
```

- [ ] **Step 6: Run tests + typecheck to verify they pass**

Run: `npx vitest run test/autotag.test.ts && npm run typecheck`
Expected: PASS (all describe blocks), no type errors. If the header row is not `['TH','TH']`, confirm `GetTables` returns 2 rows for the fixture (`extractTables` does in the table tests) and that `multiRow`/`ri===0` logic matches; if `ValidatePdfUa` still reports `TableStructure`, print the failing issue's `message` and check the parent chain is `Table→TR→TH/TD`.

- [ ] **Step 7: Commit**

```bash
git add src/autotag.ts test/autotag.test.ts
git commit -m "feat(pwi.3): AutoTag tables — Table/TR/TH/TD from GetTables"
```

---

### Task 2: README + full verify + close

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Features "Accessibility auto-tagging" bullet**

In `README.md`, extend that bullet to note table tagging. Add, after the figures/artifacts sentence:

```md
Detected tables (via `GetTables`) are tagged as `Table > TR > TH/TD` — the first row of a multi-row table becomes a header row (`TH`, `scope` Column) and any `rowSpan`/`colSpan`/`summary` are carried into the table attributes; `opts.tables` (default true) toggles table detection.
```

- [ ] **Step 2: Update the auto-tagging Limitations bullet**

In `README.md`, extend the "Auto-tagging is heuristic" bullet. Replace "It does not tag tables or lists (follow-ups)," with:

```md
Tables are tagged from `GetTables` (`Table > TR > TH/TD`, first-row-header heuristic), but `THead`/`TBody`/`TFoot` grouping, nested tables (a cell's inner table is not separately tagged), and exact rotated-table cell regions are out of scope; lists remain untagged.
```

- [ ] **Step 3: Update the AutoTag API-table row**

In `README.md`, update the `doc.AutoTag(opts?)` row to mention tables:

```md
| `doc.AutoTag(opts?)` | Infer a `/StructTreeRoot` (headings/paragraphs/figures/tables) from layout; marks Tagged; returns per-type counts |
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS — entire suite green, no type errors.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(pwi.3): document AutoTag table tagging"
```

- [ ] **Step 6: Close the sub-issue and the umbrella**

Run:
```bash
bd close aspose-pdf-foss-for-ts-pwi.3
bd close aspose-pdf-foss-for-ts-pwi   # all sub-issues (.1/.2/.3) done
```

---

## Notes for the implementer

- `page.GetTables()` is read once per page **before** any tagging on that page; tagging inserts `BDC`/`EMC` ops that do not move glyphs, so the later `GetStructuredText` block pass sees the same block geometry.
- The first-row-header heuristic only applies to multi-row tables (`rowCount >= 2`); a single-row table's cells stay `TD`.
- `SetTableAttributes` is called only when at least one attribute is present, to avoid writing an empty `/A`.
- Excluding a block by its center (not full containment) keeps a block that slightly overhangs the table box from being double-tagged.
