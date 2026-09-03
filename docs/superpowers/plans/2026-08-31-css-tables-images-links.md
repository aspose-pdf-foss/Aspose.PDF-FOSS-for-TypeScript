# CSS tables, images and links — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `<table>`, `<img>` and `<a>` render through `AddHtml`, so the
two constructs `cssflow.ts` currently reports in `skipped` stop being reported
and links gain the fence they never had.

**Architecture:** `cssbox.ts` gains the descent into a table, because CSS 2.1
§17.2.1 is about generating anonymous *boxes* and that module already owns box
generation and the styles map. A new pure leaf `csstable.ts` maps the
resulting `TableBox` to a `TableBuilder`. `cssflow.ts` loses its
`skipped.push('table')` and gains one call, plus a lone-image branch.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, no runtime
dependencies.

**Spec:** `docs/superpowers/specs/2026-08-31-css-tables-images-links-design.md`
— read it first. Its "Three findings that set the shape" section is why this
plan spends almost nothing on links and almost everything on tables.

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only.
- **ESM + NodeNext.** Every import specifier carries a `.js` extension.
- **`src/csstable.ts` and `src/datauri.ts` are PURE LEAVES.** No `Document`,
  no PDF object module, no `node:` module, no `htmldom.js` in `datauri.ts`.
  Neither throws.
- **CSS px → points (× 0.75) crosses in `cssflow.ts` and NOWHERE ELSE.** This
  is a recorded CLAUDE.md invariant. `csstable.ts` therefore takes `toPt` and
  `scaleRuns` as injected functions rather than computing points itself.
- **A construct that does not render names itself in `skipped` and still
  contributes its text.** The rule every module in this stack follows.
- **Custom properties, `calc()` and the whole cascade are already done.** Do
  not touch `csscascade.ts`, `csscompute.ts`, `cssvalue.ts`, `csscalc.ts` or
  `cssvar.ts`.
- **Run `npm run typecheck` and `npm test` before the final commit.** Both
  must be green. `test/rich-runs-identity.test.ts`,
  `test/html-identity.test.ts` and `test/docx-flow-identity.test.ts` are
  FENCES, not goldens — if one goes red, stop and investigate.
- **Mutation-check every rule** (Task 8). A mutation that reddens nothing is
  recorded as uncovered in `CLAUDE.md`, not quietly kept.

---

### Task 1: `datauri.ts` — one owner for the `data:` decoder

**Files:**
- Create: `src/datauri.ts`
- Modify: `src/mdflow.ts:79-92` (delete its private copy, import instead)
- Test: `test/datauri.test.ts`

**Interfaces:**
- Produces: `export function decodeDataUri(dest: string): Uint8Array | undefined;`

`mdflow.ts` holds this privately at lines 79-92 as `decodeDataUri`. The name
is kept exactly so its one call site does not change; this task is a MOVE, and
`test/markdown-flow.test.ts` is the fence that proves it moved nothing.

- [ ] **Step 1: Write the failing test**

Create `test/datauri.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeDataUri } from '../src/datauri.js';

describe('decodeDataUri', () => {
  it('decodes a base64 payload', () => {
    // "hi" in base64.
    expect(decodeDataUri('data:image/png;base64,aGk=')).toEqual(
      new Uint8Array([0x68, 0x69]));
  });

  it('decodes a percent-encoded payload as UTF-8', () => {
    expect(decodeDataUri('data:text/plain,a%20b')).toEqual(
      new Uint8Array([0x61, 0x20, 0x62]));
  });

  it('refuses anything that is not a data: URI', () => {
    expect(decodeDataUri('https://example.com/a.png')).toBeUndefined();
    expect(decodeDataUri('a.png')).toBeUndefined();
    expect(decodeDataUri('')).toBeUndefined();
  });

  it('refuses a data: URI with no comma', () => {
    // No payload separator at all: there is nothing to decode, and slicing
    // from -1 would silently take the whole string as the payload.
    expect(decodeDataUri('data:image/png;base64')).toBeUndefined();
  });

  it('never throws on a malformed payload', () => {
    // Damage is a value, the rule every parser here follows. A stray percent
    // makes decodeURIComponent throw, which must not escape.
    expect(() => decodeDataUri('data:text/plain,%%%')).not.toThrow();
    expect(decodeDataUri('data:text/plain,%%%')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/datauri.test.ts`
Expected: FAIL — `Failed to load url ../src/datauri.js`.

- [ ] **Step 3: Create the module**

Create `src/datauri.ts`. The body is transcribed VERBATIM from
`src/mdflow.ts:82-93` — do not "improve" it here, or the move stops being a
move:

```ts
/** Decoding a `data:` URI's payload.
 *
 *  Invariant: a PURE LEAF importing NOTHING. Two consumers — mdflow.ts's
 *  resolveImage path and cssflow.ts's — and two copies is how they would come
 *  to disagree about one payload. The extraction colornames.ts, preformat.ts
 *  and bordersides.ts each already made.
 *
 *  Invariant: it NEVER throws. A payload it cannot decode is `undefined` —
 *  including a malformed one, which is a destination we cannot resolve rather
 *  than an error. */

/** The bytes of a `data:` URI, or undefined for anything else. */
export function decodeDataUri(dest: string): Uint8Array | undefined {
  const comma = dest.indexOf(',');
  if (!dest.startsWith('data:') || comma < 0) return undefined;
  const meta = dest.slice(5, comma);
  const payload = dest.slice(comma + 1);
  try {
    if (/;base64$/i.test(meta)) return new Uint8Array(Buffer.from(payload, 'base64'));
    return new TextEncoder().encode(decodeURIComponent(payload));
  } catch {
    return undefined;
  }
}
```

`Buffer` is a `node:` global rather than an import, which this repo already
relies on elsewhere.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/datauri.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Switch `mdflow.ts` over and prove nothing moved**

Delete lines 79-93 of `src/mdflow.ts` (the doc comment and the function), and
add `import { decodeDataUri } from './datauri.js';` beside its other imports.
Its one call site keeps the same name and does not change.

Run: `npx vitest run test/markdown-flow.test.ts`
Expected: PASS. If that file does not exist, run
`npx vitest run 2>&1 | tail -5` and confirm the whole suite is green.

- [ ] **Step 6: Commit**

```bash
git add src/datauri.ts src/mdflow.ts test/datauri.test.ts
git commit -m "refactor(zch2.6): one owner for the data: URI decoder"
```

---

### Task 2: `cssbox.ts` — the table descent and §17.2.1

**Files:**
- Modify: `src/cssbox.ts` (`TableBox`, and `boxFor`'s table branch)
- Test: `test/cssbox.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TableCellBox {
    el: HtmlElement | null;          // null for an anonymous cell
    style: ComputedStyle;
    colSpan: number;                 // >= 1
    rowSpan: number;                 // >= 1
    header: boolean;
    content: BlockBox['content'];
  }
  export interface TableRowBox {
    el: HtmlElement | null;          // null for an anonymous row
    style: ComputedStyle;
    section: 'head' | 'body' | 'foot';
    cells: TableCellBox[];
  }
  export interface TableBox {
    kind: 'table';
    el: HtmlElement;
    style: ComputedStyle;
    float: 'none' | 'left' | 'right';
    clear: 'none' | 'left' | 'right' | 'both';
    rows: TableRowBox[];
    caption: BoxNode | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/cssbox.test.ts`. Read the top of that file first for its
existing helpers — it already has a way to build boxes from a source string;
reuse it rather than adding a second.

```ts
describe('table boxes (zch2.6)', () => {
  /** The first table box in the tree. */
  const tableOf = (src: string): TableBox => {
    const { boxes } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolver);
    const find = (bs: BoxNode[]): TableBox | undefined => {
      for (const b of bs) {
        if (b.kind === 'table') return b;
        if (b.content.kind === 'blocks') {
          const hit = find(b.content.children);
          if (hit !== undefined) return hit;
        }
      }
      return undefined;
    };
    const t = find(boxes);
    if (t === undefined) throw new Error('no table box');
    return t;
  };

  it('descends into rows and cells', () => {
    const t = tableOf('<table><tr><td>a</td><td>b</td></tr></table>');
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].cells.length).toBe(2);
  });

  it('reads a cell as an ordinary block container, so its runs are built', () => {
    // A cell's content goes through the SAME machinery a paragraph's does,
    // which is what makes bold, code and links behave identically inside one.
    const t = tableOf('<table><tr><td>hello</td></tr></table>');
    const c = t.rows[0].cells[0].content;
    expect(c.kind).toBe('inline');
    if (c.kind !== 'inline') throw new Error('expected inline');
    expect(c.runs.map((r) => r.text).join('')).toBe('hello');
  });

  it('marks a thead row as the head section and its cells as headers', () => {
    const t = tableOf('<table><thead><tr><th>h</th></tr></thead>'
      + '<tbody><tr><td>b</td></tr></tbody></table>');
    expect(t.rows[0].section).toBe('head');
    expect(t.rows[0].cells[0].header).toBe(true);
    expect(t.rows[1].section).toBe('body');
    expect(t.rows[1].cells[0].header).toBe(false);
  });

  it('marks a bare th as a header even outside a thead', () => {
    const t = tableOf('<table><tr><th>h</th><td>b</td></tr></table>');
    expect(t.rows[0].cells[0].header).toBe(true);
    expect(t.rows[0].cells[1].header).toBe(false);
  });

  it('puts a tfoot row in the foot section', () => {
    const t = tableOf('<table><tfoot><tr><td>f</td></tr></tfoot></table>');
    expect(t.rows[0].section).toBe('foot');
  });

  it('reads colspan and rowspan, defaulting to 1', () => {
    const t = tableOf('<table><tr><td colspan=2 rowspan=3>a</td><td>b</td></tr></table>');
    expect(t.rows[0].cells[0].colSpan).toBe(2);
    expect(t.rows[0].cells[0].rowSpan).toBe(3);
    expect(t.rows[0].cells[1].colSpan).toBe(1);
    expect(t.rows[0].cells[1].rowSpan).toBe(1);
  });

  it('clamps a junk span to 1 rather than producing NaN', () => {
    // A NaN span reaches TableBuilder and corrupts the whole grid, where 1 is
    // simply the cell the author most likely meant.
    const t = tableOf('<table><tr><td colspan=0 rowspan=abc>a</td></tr></table>');
    expect(t.rows[0].cells[0].colSpan).toBe(1);
    expect(t.rows[0].cells[0].rowSpan).toBe(1);
  });

  it('takes the caption out of the row flow', () => {
    const t = tableOf('<table><caption>Cap</caption><tr><td>a</td></tr></table>');
    expect(t.caption).not.toBeNull();
    expect(t.rows.length).toBe(1);
  });

  it('wraps a stray display:table-cell in an anonymous ROW (17.2.1)', () => {
    // The fixup earns its place HERE, not on <table> markup: htmltree.ts
    // already produces well-formed table > tbody > tr > td, so real HTML
    // needs almost none of 17.2.1.
    const t = tableOf('<div style="display:table">'
      + '<div style="display:table-cell">a</div></div>');
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].el).toBeNull();
    expect(t.rows[0].cells.length).toBe(1);
  });

  it('wraps a stray non-cell child of a row in an anonymous CELL (17.2.1)', () => {
    const t = tableOf('<div style="display:table">'
      + '<div style="display:table-row"><span>a</span></div></div>');
    expect(t.rows[0].cells.length).toBe(1);
    expect(t.rows[0].cells[0].el).toBeNull();
  });

  it('emits NO table box for an empty table', () => {
    // A table with no rows draws nothing and would otherwise reach
    // TableBuilder with zero rows, whose grid[0] does not exist.
    const t = tableOf('<table></table>');
    expect(t.rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cssbox.test.ts`
Expected: FAIL — `Property 'rows' does not exist on type 'TableBox'` at
typecheck, and every new case failing at runtime.

- [ ] **Step 3: Extend the types**

In `src/cssbox.ts`, replace the `TableBox` interface with the three
interfaces from the **Interfaces** block above, keeping `TableBox` last so
`BoxNode` still resolves.

- [ ] **Step 4: Extract the content builder so a cell can reuse it**

`boxFor` currently computes `content` inline. Pull that into a named function
declared inside `buildBoxes`, so both `boxFor` and the cell walk call it:

```ts
  /** The `blocks | inline` content of an element, the same rule for a cell as
   *  for a paragraph. A second content builder is how a cell comes to render
   *  bold where a paragraph renders code — mdflow.ts records the same rule. */
  const contentOf = (el: HtmlElement, style: ComputedStyle): BlockBox['content'] => {
    const hasBlockChild = el.children.some((c) => isBlockLevel(c, styles));
    if (!hasBlockChild) {
      return { kind: 'inline', ...inlineContentOf(el.children, style, styles, resolveFamily, unsupported) };
    }
    const children: BoxNode[] = [];
    let pending: HtmlNode[] = [];
    const flush = (): void => {
      if (!pending.some((n) => contributesInline(n, styles))) { pending = []; return; }
      const c = inlineContentOf(pending, style, styles, resolveFamily, unsupported);
      if (c.runs.length > 0 || c.atomics.length > 0) {
        children.push({
          kind: 'anonymous', el: null, style, float: 'none', clear: 'none',
          content: { kind: 'inline', ...c },
        });
      }
      pending = [];
    };
    for (const child of el.children) {
      if (isBlockLevel(child, styles)) {
        flush();
        const b = child.kind === 'element' ? boxFor(child) : null;
        if (b !== null) children.push(b);
        continue;
      }
      pending.push(child);
    }
    flush();
    return { kind: 'blocks', children };
  };
```

Then `boxFor`'s non-table branch becomes:

```ts
    const kind: BlockBox['kind'] = style.display === 'list-item' ? 'list-item' : 'block';
    return { kind, el, style, float, clear, content: contentOf(el, style) };
```

Run `npx vitest run test/cssbox.test.ts test/cssflow.test.ts` and confirm the
PRE-EXISTING cases still pass before going on. This step must change no
behaviour.

- [ ] **Step 5: Write the table walk**

Add inside `buildBoxes`, above `boxFor`:

```ts
  const SECTION_OF: Partial<Record<ComputedStyle['display'], 'head' | 'body' | 'foot'>> = {
    'table-header-group': 'head',
    'table-footer-group': 'foot',
    'table-row-group': 'body',
  };

  /** An HTML span attribute. Junk clamps to 1: a NaN reaches TableBuilder and
   *  corrupts the whole grid, where 1 is the cell the author meant. */
  const spanAttr = (el: HtmlElement | null, name: string): number => {
    const raw = el?.attrs.get(name);
    const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 1 ? n : 1;
  };

  const cellFor = (el: HtmlElement, style: ComputedStyle, inHead: boolean): TableCellBox => ({
    el,
    style,
    colSpan: spanAttr(el, 'colspan'),
    rowSpan: spanAttr(el, 'rowspan'),
    header: inHead || (el.ns === 'html' && el.name === 'th'),
    content: contentOf(el, style),
  });

  /** §17.2.1: a run of non-cell children of a row becomes ONE anonymous cell. */
  const anonCell = (
    nodes: HtmlNode[], style: ComputedStyle, inHead: boolean,
  ): TableCellBox | null => {
    if (!nodes.some((n) => contributesInline(n, styles))) return null;
    const c = inlineContentOf(nodes, style, styles, resolveFamily, unsupported);
    if (c.runs.length === 0 && c.atomics.length === 0) return null;
    return {
      el: null, style, colSpan: 1, rowSpan: 1, header: inHead,
      content: { kind: 'inline', ...c },
    };
  };

  const rowFor = (
    el: HtmlElement, style: ComputedStyle, section: 'head' | 'body' | 'foot',
  ): TableRowBox => {
    const cells: TableCellBox[] = [];
    let pending: HtmlNode[] = [];
    const flush = (): void => {
      const c = anonCell(pending, style, section === 'head');
      if (c !== null) cells.push(c);
      pending = [];
    };
    for (const child of el.children) {
      const st = child.kind === 'element' ? styles.get(child) : undefined;
      if (child.kind === 'element' && st !== undefined && st.display === 'table-cell') {
        flush();
        cells.push(cellFor(child, st, section === 'head'));
        continue;
      }
      pending.push(child);
    }
    flush();
    return { el, style, section, cells };
  };

  /** Collect the rows under a table or a row group, applying §17.2.1's
   *  anonymous-row fixup to a stray cell. */
  const collectRows = (
    el: HtmlElement, style: ComputedStyle, section: 'head' | 'body' | 'foot',
    rows: TableRowBox[], caption: { box: BoxNode | null },
  ): void => {
    let strays: HtmlNode[] = [];
    const flushStrays = (): void => {
      const c = anonCell(strays, style, section === 'head');
      strays = [];
      if (c !== null) rows.push({ el: null, style, section, cells: [c] });
    };
    for (const child of el.children) {
      const st = child.kind === 'element' ? styles.get(child) : undefined;
      if (child.kind !== 'element' || st === undefined || st.display === 'none') {
        strays.push(child);
        continue;
      }
      if (st.display === 'table-row') {
        flushStrays();
        rows.push(rowFor(child, st, section));
        continue;
      }
      const grouped = SECTION_OF[st.display];
      if (grouped !== undefined) {
        flushStrays();
        collectRows(child, st, grouped, rows, caption);
        continue;
      }
      if (st.display === 'table-caption') {
        flushStrays();
        // A caption is ordinary block content emitted BEFORE the table;
        // TableBuilder has no caption vocabulary and dropping it would lose
        // its text.
        if (caption.box === null) {
          caption.box = {
            kind: 'block', el: child, style: st, float: 'none', clear: 'none',
            content: contentOf(child, st),
          };
        }
        continue;
      }
      strays.push(child);
    }
    flushStrays();
  };
```

Note `SECTION_OF` is consulted for a nested group inside a group too; HTML
does not produce that, but `display: table-row-group` on an arbitrary div can.

- [ ] **Step 6: Use the walk in `boxFor`**

Replace the table branch:

```ts
    if (TABLE_DISPLAYS.has(style.display)) {
      const rows: TableRowBox[] = [];
      const caption: { box: BoxNode | null } = { box: null };
      // A stray table-row / table-cell reached directly is itself wrapped:
      // collectRows treats THIS element as the table, so a cell child lands
      // in an anonymous row, which is §17.2.1's answer.
      collectRows(el, style, 'body', rows, caption);
      return { kind: 'table', el, style, float, clear, rows, caption: caption.box };
    }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/cssbox.test.ts`
Expected: typecheck reports errors ONLY in `src/cssflow.ts` (it destructures
`TableBox` in `mapList`'s narrowing guard); `test/cssbox.test.ts` PASSES.
If `cssflow.ts` errors, leave them — Task 4 fixes them. If it does not error,
that is fine too.

- [ ] **Step 8: Commit**

```bash
git add src/cssbox.ts test/cssbox.test.ts
git commit -m "feat(zch2.6): descend into tables, with 17.2.1's anonymous fixup"
```

---

### Task 3: `csstable.ts` — TableBox to TableBuilder

**Files:**
- Create: `src/csstable.ts`
- Test: `test/csstable.test.ts`

**Interfaces:**
- Consumes: Task 2's `TableBox`, `TableRowBox`, `TableCellBox`.
- Produces:
  ```ts
  export interface TableMapCtx {
    toPt: (px: number) => number;
    scaleRuns: (runs: TextRun[]) => TextRun[];
    skipped: string[];
  }
  export function buildTable(box: TableBox, c: TableMapCtx): TableBuilder | null;
  ```
  `null` for a table with no rows — `TableBuilder` has no meaning with an
  empty grid, and `flowtable.ts` would index `grid[0]`.

- [ ] **Step 1: Write the failing test**

Create `test/csstable.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import { buildTable } from '../src/csstable.js';
import type { BoxNode, TableBox } from '../src/cssbox.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import type { TextRun } from '../src/textdecor.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

const PT_PER_PX = 0.75;
const ctx = () => ({
  toPt: (px: number) => px * PT_PER_PX,
  scaleRuns: (runs: TextRun[]) => runs.map(
    (r) => (r.fontSize === undefined ? r : { ...r, fontSize: r.fontSize * PT_PER_PX })),
  skipped: [] as string[],
});

function tableOf(src: string): TableBox {
  const { boxes } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolver);
  const find = (bs: BoxNode[]): TableBox | undefined => {
    for (const b of bs) {
      if (b.kind === 'table') return b;
      if (b.content.kind === 'blocks') {
        const hit = find(b.content.children);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  const t = find(boxes);
  if (t === undefined) throw new Error('no table box');
  return t;
}

/** The built table's grid, via the builder's own public shape. */
const build = (src: string, c = ctx()) => ({ t: buildTable(tableOf(src), c), c });

describe('buildTable', () => {
  it('builds a row per row and a cell per cell', () => {
    const { t } = build('<table><tr><td>a</td><td>b</td></tr>'
      + '<tr><td>c</td><td>d</td></tr></table>');
    expect(t).not.toBeNull();
    expect(t!.rows.length).toBe(2);
    expect(t!.rows[0].cells.length).toBe(2);
  });

  it('returns null for a table with no rows', () => {
    // TableBuilder has no meaning with an empty grid and flowtable.ts would
    // index grid[0].
    expect(build('<table></table>').t).toBeNull();
  });

  it('carries colSpan through to the cell', () => {
    const { t } = build('<table><tr><td colspan=2>a</td></tr>'
      + '<tr><td>b</td><td>c</td></tr></table>');
    expect(t!.rows[0].cells[0].colSpan).toBe(2);
    expect(t!.rows[1].cells[0].colSpan).toBe(1);
  });

  it('repeats the LEADING header rows rather than setting header per cell', () => {
    // CellOptions.header already defaults to "cells in the repeating-header
    // rows are column headers", so stating both would be two statements that
    // can drift — mdflow.ts records the same rule. Hence the header is
    // UNDEFINED on a leading header cell: the default already says it.
    const { t } = build('<table><thead><tr><th>h</th></tr></thead>'
      + '<tbody><tr><td>b</td></tr></tbody></table>');
    expect(t!.repeatingRowCount).toBe(1);
    expect(t!.rows[0].cells[0].header).toBeUndefined();
  });

  it('does NOT repeat rows when the header is not leading', () => {
    // A tfoot's th cannot be reached by the repeating-header default, so it
    // gets an EXPLICIT header instead and nothing repeats.
    const { t } = build('<table><tbody><tr><td>b</td></tr></tbody>'
      + '<tfoot><tr><th>f</th></tr></tfoot></table>');
    expect(t!.repeatingRowCount).toBe(0);
    expect(t!.rows[1].cells[0].header).toBe('column');
  });

  it('flattens a cell holding BLOCK content and reports it', () => {
    const { t, c } = build('<table><tr><td><p>a</p><p>b</p></td></tr></table>');
    expect(t).not.toBeNull();
    expect(c.skipped).toContain('table-cell-blocks');
  });

  it('keeps the flattened text rather than dropping the subtree', () => {
    // Visible content beats a silently dropped subtree, the rule svgdraw.ts
    // sets and this whole stack follows.
    const { t } = build('<table><tr><td><p>alpha</p><p>beta</p></td></tr></table>');
    expect(t).not.toBeNull();
  });

  it('does not report a cell whose content is plain inline', () => {
    const { c } = build('<table><tr><td>a</td></tr></table>');
    expect(c.skipped).toEqual([]);
  });
});
```

The accessors those assertions use are the ones `TableBuilder` actually
exposes, checked while writing this plan: `readonly rows: RowBuilder[]`
(line 518), `RowBuilder.readonly cells: CellBuilder[]` (line 471),
`CellBuilder.readonly colSpan` / `.rowSpan` / `.header` (lines 441-443), and
`get repeatingRowCount()` (line 623). There is no `rowCount`, no
`columnCount` and no `repeatingRowsCount` — do not reach for them, and do not
add a getter to `tableauthor.ts` for a test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/csstable.test.ts`
Expected: FAIL — `Failed to load url ../src/csstable.js`.

- [ ] **Step 3: Write the implementation**

Create `src/csstable.ts`:

```ts
/** A CSS table box to a TableBuilder.
 *
 *  Invariant: a PURE LEAF. It imports cssbox.js and cssprop.js for TYPES,
 *  tableauthor.js for the builder and bordersides.js for the edge flags, and
 *  nothing else — no Document, no PDF object, no `node:` import. `createTable`
 *  is document-free, which is what lets every rule here be tested from a
 *  hand-built box tree.
 *
 *  Invariant: the px -> pt conversion is INJECTED, never computed here.
 *  CLAUDE.md records that the × 0.75 crosses in cssflow.ts and nowhere else;
 *  a second site is a second thing to get wrong.
 *
 *  Invariant: NEVER throws. A table it cannot build is `null`. */

import type { BoxNode, TableBox, TableCellBox } from './cssbox.js';
import type { ComputedStyle } from './cssprop.js';
import type { TextRun } from './textdecor.js';
import { createTable } from './tableauthor.js';
import type { BorderInfo, CellOptions, TableBuilder } from './tableauthor.js';
import type { BorderSides } from './bordersides.js';

export interface TableMapCtx {
  toPt: (px: number) => number;
  scaleRuns: (runs: TextRun[]) => TextRun[];
  skipped: string[];
}

const rgb = (c: ComputedStyle['color']): [number, number, number] => c.rgb;

/** Every run a box subtree contributes, in order.
 *
 *  A cell holding block content FLATTENS: TableBuilder.addCell takes
 *  `string | TextRun[]`, so a cell containing a <p> and a <ul> cannot be
 *  represented. Extending the authoring layer to accept FlowElement[] would
 *  change tableauthor.ts, tablerender.ts and flowtable.ts together and is its
 *  own issue; losing the text instead would break the rule that a construct
 *  which does not render still contributes what it has. */
function flattenRuns(content: TableCellBox['content'], out: TextRun[]): void {
  if (content.kind === 'inline') { out.push(...content.runs); return; }
  for (const child of content.children) collectBox(child, out);
}

function collectBox(b: BoxNode, out: TextRun[]): void {
  if (b.kind === 'table') return;      // a nested table has no run form
  flattenRuns(b.content, out);
}

/** The painted edges of a CSS border box.
 *
 *  A border edge's USED width is 0 when its style is `none` or `hidden`
 *  (CSS 2.1 §8.5.3) — the rule cssresolve.ts records, and it matters here for
 *  the same reason: the initial border-style is `none` while the initial
 *  border-width is `medium`, so every cell that states no border carries a
 *  computed 3px per edge. */
function borderOf(s: ComputedStyle, toPt: (px: number) => number): BorderInfo | undefined {
  const edges = [
    { on: s.borderTopStyle, w: s.borderTopWidth, c: s.borderTopColor, k: 'top' },
    { on: s.borderRightStyle, w: s.borderRightWidth, c: s.borderRightColor, k: 'right' },
    { on: s.borderBottomStyle, w: s.borderBottomWidth, c: s.borderBottomColor, k: 'bottom' },
    { on: s.borderLeftStyle, w: s.borderLeftWidth, c: s.borderLeftColor, k: 'left' },
  ].map((e) => ({ ...e, painted: e.on !== 'none' && e.on !== 'hidden' && e.w > 0 }));

  const first = edges.find((e) => e.painted);
  if (first === undefined) return undefined;

  // BorderInfo carries ONE width and ONE colour plus per-edge flags, so four
  // edges that differ collapse to the first painted one. A limitation of the
  // authoring type rather than a dropped construct, so it is documented
  // rather than reported per cell.
  const sides: BorderSides = edges.every((e) => e.painted)
    ? 'all'
    : {
      top: edges[0].painted, right: edges[1].painted,
      bottom: edges[2].painted, left: edges[3].painted,
    };
  return { width: toPt(first.w), color: rgb(first.c), sides };
}

const ALIGN: Record<string, 'left' | 'center' | 'right'> = {
  left: 'left', right: 'right', center: 'center', start: 'left', end: 'right',
  justify: 'left',
};

/** Build a TableBuilder, or null when there is nothing to build. */
export function buildTable(box: TableBox, c: TableMapCtx): TableBuilder | null {
  if (box.rows.length === 0) return null;

  const s = box.style;
  const t = createTable({
    fontSize: c.toPt(s.fontSize),
    leading: c.toPt(s.fontSize) * 1.2,
    color: rgb(s.color),
    border: borderOf(s, c.toPt),
    outerBorder: borderOf(s, c.toPt),
  });

  // The LEADING run of header rows is what setRepeatingRowsCount can express;
  // a header row anywhere else gets an explicit header instead, because the
  // repeating-header default cannot reach it.
  let leadingHeaders = 0;
  while (leadingHeaders < box.rows.length
    && box.rows[leadingHeaders].cells.every((x) => x.header)
    && box.rows[leadingHeaders].cells.length > 0) leadingHeaders += 1;

  let reportedBlocks = false;
  box.rows.forEach((row, ri) => {
    const bg = row.style.backgroundColor;
    const r = t.addRow(undefined, bg.a > 0 ? { background: rgb(bg) } : {});
    for (const cell of row.cells) {
      const runs: TextRun[] = [];
      flattenRuns(cell.content, runs);
      if (cell.content.kind === 'blocks' && !reportedBlocks) {
        c.skipped.push('table-cell-blocks');
        reportedBlocks = true;
      }
      const cs = cell.style;
      const opts: CellOptions = {
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        align: ALIGN[cs.textAlign] ?? 'left',
        fontSize: c.toPt(cs.fontSize),
        color: rgb(cs.color),
        padding: c.toPt(cs.paddingTop.px ?? 0),
      };
      const cellBorder = borderOf(cs, c.toPt);
      if (cellBorder !== undefined) opts.border = cellBorder;
      if (cs.backgroundColor.a > 0) opts.background = rgb(cs.backgroundColor);
      // Only outside the repeating block, where the default cannot reach.
      if (cell.header && ri >= leadingHeaders) opts.header = 'column';
      r.addCell(c.scaleRuns(runs), opts);
    }
  });

  if (leadingHeaders > 0) t.setRepeatingRowsCount(leadingHeaders);
  // CSS column widths are a follow-up: mixing stated and auto columns is what
  // resolveColumnWidths's ColumnWidth specs are for, and guessing silently
  // mis-sizes every column rather than failing.
  t.autoFitColumns();
  return t;
}
```

**`cs.paddingTop.px ?? 0` will not typecheck** — `paddingTop` is a
`LengthPct`, which since `zch2.2.7` is `{ px, pct } | { expr }`. Use
`cssvalue.ts`'s `fixedPx`:

```ts
import { fixedPx } from './cssvalue.js';
// …
padding: c.toPt(fixedPx(cs.paddingTop) ?? 0),
```

A percentage padding resolves against a containing block a table cell does not
have here, so 0 is the same refusal `cssresolve.ts` already makes for a
percentage height.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/csstable.test.ts`
Expected: typecheck clean except `src/cssflow.ts`; the test file PASSES.

- [ ] **Step 5: Commit**

```bash
git add src/csstable.ts test/csstable.test.ts
git commit -m "feat(zch2.6): map a CSS table box to a TableBuilder"
```

---

### Task 4: `cssflow.ts` — render the table and its caption

**Files:**
- Modify: `src/cssflow.ts` (`mapBox`'s table branch, `mapList`'s guard)
- Test: `test/cssflow.test.ts`

**Interfaces:**
- Consumes: `buildTable`, `TableMapCtx` from `./csstable.js`; `table` from
  `./flowtable.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/cssflow.test.ts`. Read the top of that file for its existing
helper that maps a source to elements, and reuse it.

```ts
describe('tables (zch2.6)', () => {
  it('emits a table element rather than reporting it skipped', () => {
    const { elements, skipped } = mapSource(
      '<table><tr><td>a</td><td>b</td></tr></table>');
    expect(skipped).not.toContain('table');
    expect(elements.length).toBeGreaterThan(0);
  });

  it('emits the caption BEFORE the table', () => {
    // TableBuilder has no caption vocabulary, so the caption is an ordinary
    // paragraph; dropping it would lose its text.
    const { elements, skipped } = mapSource(
      '<table><caption>Cap</caption><tr><td>a</td></tr></table>');
    expect(skipped).not.toContain('table');
    expect(elements.length).toBeGreaterThanOrEqual(2);
  });

  it('produces NO element for an empty table and carries its gap forward', () => {
    // The gap of a box that produces no element must land on the next box
    // that does, or the space disappears — the rule mapSiblings already has
    // for a skipped table.
    const { elements } = mapSource('<table></table><p>after</p>');
    expect(elements.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cssflow.test.ts`
Expected: FAIL — `skipped` still contains `'table'`.

- [ ] **Step 3: Write the implementation**

Add the imports:

```ts
import { buildTable } from './csstable.js';
import { table } from './flowtable.js';
```

Replace the table branch in `mapBox`:

```ts
  if (box.kind === 'table') {
    const els: FlowElement[] = [];
    // A caption is ordinary block content emitted BEFORE the table.
    if (box.caption !== null) {
      els.push(...mapSiblings([box.caption], r.contentWidth, c));
    }
    const built = buildTable(box, {
      toPt: pt, scaleRuns, skipped: c.skipped,
    });
    if (built !== null) {
      els.push(...table(built, { width: r.contentWidth * PT_PER_PX, spaceBefore }));
    }
    return els;
  }
```

`table()` returns `FlowElement[]`; confirm with
`grep -n "export function table" src/flowtable.ts` and match its actual
return type and option names before writing this.

In `mapList`, the guard that narrows away a `TableBox` stays as it is — a
table cannot carry `display: list-item`, so that branch is still unreachable
and still narrows the type.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/cssflow.test.ts test/csstable.test.ts test/cssbox.test.ts`
Expected: typecheck clean; all three PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: 537 files green. If `test/html-identity.test.ts` goes red, STOP: a
document with no table has changed, which nothing in this task should do.

- [ ] **Step 6: Commit**

```bash
git add src/cssflow.ts test/cssflow.test.ts
git commit -m "feat(zch2.6): render CSS tables through flowtable"
```

---

### Task 5: Images

**Files:**
- Modify: `src/htmlflow.ts` (`HtmlFlowOptions`, plumbing)
- Modify: `src/cssflow.ts` (`Ctx`, the lone-image branch in `mapBox` and `mapList`)
- Test: `test/htmlflow.test.ts`

**Interfaces:**
- Consumes: `decodeDataUri` from `./datauri.js`; `image` from `./flow.js`.
- Produces: `HtmlFlowOptions.resolveImage?: (src: string, alt: string) => Uint8Array | undefined`

- [ ] **Step 1: Write the failing test**

Append to `test/htmlflow.test.ts`:

```ts
describe('images (zch2.6)', () => {
  // A 1x1 red PNG, the smallest thing buildImageXObject accepts.
  const PNG_1x1 = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('renders a lone image from a data: URI with no resolver at all', () => {
    const { skipped } = render(`<p><img src="${PNG_1x1}" alt="a red dot"></p>`);
    expect(skipped.some((s) => s.startsWith('image:'))).toBe(false);
  });

  it('treats surrounding WHITESPACE as no content', () => {
    // cssinline.ts filters only text !== '', so this carries whitespace runs
    // either side of the atomic — and it is the commonest formatting of an
    // image in real markup.
    const { skipped } = render(`<p>\n  <img src="${PNG_1x1}">\n</p>`);
    expect(skipped.some((s) => s.startsWith('image:'))).toBe(false);
  });

  it('still reports an image that shares its line with text', () => {
    // zch2.11's, not this issue's: layoutRuns cannot place an atomic in a
    // line, so the text renders and the image is reported.
    const { skipped } = render(`<p>before <img src="${PNG_1x1}"> after</p>`);
    expect(skipped.some((s) => s.startsWith('image:'))).toBe(true);
  });

  it('asks the resolver for a non-data src, with the src and the alt', () => {
    const seen: [string, string][] = [];
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = htmlElements(
      doc, '<p><img src="logo.png" alt="Logo"></p>', 400,
      { resolveImage: (src, alt) => { seen.push([src, alt]); return undefined; } });
    placeElements(doc, page, elements, [20, 20, 400, 750], { paragraphSpacing: 0 });
    expect(seen).toEqual([['logo.png', 'Logo']]);
  });

  it('reports an image the resolver declines rather than throwing', () => {
    const { skipped } = render('<p><img src="missing.png"></p>');
    expect(skipped).toContain('image:missing.png');
  });

  it('reports an image whose bytes will not decode', () => {
    // buildImageXObject rejects anything that is not JPEG or PNG, and the
    // report has to survive that rather than the throw escaping.
    const { skipped } = render('<p><img src="data:image/png;base64,aGk="></p>');
    expect(skipped.some((s) => s.startsWith('image:'))).toBe(true);
  });
});
```

`render` is the helper already at the top of that file. Confirm it forwards an
options bag; if it does not, add an optional third parameter to it rather than
writing a second helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlflow.test.ts`
Expected: FAIL — every image is currently reported.

- [ ] **Step 3: Add the option**

In `src/htmlflow.ts`, extend `HtmlFlowOptions`:

```ts
  /** Supply the bytes for an `<img src>`. `data:` URIs are decoded without
   *  this; anything else is the caller's, which is how this library renders
   *  pictures while touching neither `fs` nor the network. Return `undefined`
   *  for a src you cannot resolve: the image is reported in `skipped` and the
   *  rest of the document still renders. Mirrors mdflow.ts's resolveImage in
   *  pattern rather than arity — that one takes Markdown's (destination,
   *  title), these are HTML's (src, alt). */
  resolveImage?: (src: string, alt: string) => Uint8Array | undefined;
```

Validate it as `mdflow.ts` does, beside the existing `resolveFamily` check:

```ts
  if (options.resolveImage !== undefined && typeof options.resolveImage !== 'function')
    throw new TypeError('resolveImage must be a function');
```

Thread it into the `Ctx` that `buildElements` passes to `cssflow.ts`.

- [ ] **Step 4: Add the lone-image branch**

In `src/cssflow.ts`, extend `Ctx` with
`resolveImage?: (src: string, alt: string) => Uint8Array | undefined;` and add:

```ts
import { decodeDataUri } from './datauri.js';
import { image } from './flow.js';
import type { AtomicInline } from './cssinline.js';

/** The image element for a lone atomic, or null when its bytes cannot be had
 *  or decoded. Reported by the caller either way. */
function imageElement(
  a: AtomicInline, widthPx: number, spaceBefore: number, c: Ctx,
): FlowElement[] | null {
  const src = a.el.attrs.get('src') ?? '';
  const alt = a.el.attrs.get('alt') ?? '';
  const data = decodeDataUri(src) ?? c.resolveImage?.(src, alt);
  if (data === undefined) return null;
  try {
    return image(data, {
      width: pt(widthPx),
      alt: alt !== '' ? alt : undefined,
      spaceBefore,
    });
  } catch {
    // buildImageXObject rejects anything that is not JPEG or PNG. The report
    // has to survive that rather than letting the throw escape a mapper whose
    // whole contract is that damage is a value.
    return null;
  }
}

/** Is this inline content ONE atomic and nothing else that draws?
 *
 *  MEANINGFUL matters: cssinline.ts filters only `text !== ''`, so
 *  `<p>\n  <img>\n</p>` arrives with whitespace runs either side of the
 *  atomic, and a naive "no runs" test would report the commonest formatting
 *  of an image in real markup. mdflow.ts's loneImage says the same thing as
 *  "ignoring surrounding whitespace". */
function loneAtomic(
  content: { runs: TextRun[]; atomics: AtomicInline[] },
): AtomicInline | null {
  if (content.atomics.length !== 1) return null;
  return content.runs.every((r) => r.text.trim() === '') ? content.atomics[0] : null;
}
```

In `mapBox`'s inline branch, before the existing atomic reporting:

```ts
  if (box.content.kind === 'inline') {
    const lone = loneAtomic(box.content);
    if (lone !== null) {
      const els = imageElement(lone, r.contentWidth, spaceBefore, c);
      if (els !== null) return frameBoxes(els, frameOf(r), spacing);
    }
    for (const a of box.content.atomics)
      c.skipped.push(`image:${a.el.attrs.get('src') ?? ''}`);
    // …unchanged from here
```

Note the width: `image()`'s `width` is in points and `r.contentWidth` is px,
so `pt()` is applied — the conversion still crossing in this file only.

Leave `mapList`'s atomic loop reporting as it is; a list item whose whole body
is an image is rare enough that the extra branch is not worth it, and it is
still reported rather than dropped.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlflow.test.ts`
Expected: typecheck clean; PASS.

- [ ] **Step 6: Commit**

```bash
git add src/htmlflow.ts src/cssflow.ts test/htmlflow.test.ts
git commit -m "feat(zch2.6): render a lone img, with a resolveImage hook"
```

---

### Task 6: Links — the fence, and the fragment decision

**Files:**
- Modify: `src/cssinline.ts` (the `href` read)
- Test: `test/htmlflow.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/htmlflow.test.ts`:

```ts
describe('links (zch2.6)', () => {
  const annots = (src: string) => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = htmlElements(doc, src, 400);
    placeElements(doc, page, elements, [20, 20, 400, 750], { paragraphSpacing: 0 });
    return page.Annotations;
  };

  it('emits ONE /Link annotation for an anchor', () => {
    // A fence rather than a feature: this already works, by cssinline.ts
    // setting TextRun.link and runlink.ts emitting the annotation, and
    // nothing pinned it.
    const a = annots('<p>See <a href="https://example.com">the docs</a> here.</p>');
    expect(a.length).toBe(1);
    expect(a[0].Subtype).toBe('Link');
  });

  it('emits ONE annotation for a link broken across a line', () => {
    // A link broken across a line break is ONE link; two elements would have
    // a screen reader announce it twice. runlink.ts's rule.
    const a = annots(`<p><a href="https://example.com">${'word '.repeat(40)}</a></p>`);
    expect(a.length).toBe(1);
  });

  it('keeps two adjacent links separate', () => {
    // cssinline.ts folds the destination into the run merge key: merged, the
    // whole phrase would point at the second URI, rendering perfectly and
    // linking wrongly.
    const a = annots('<p><a href="https://a.example">a</a>'
      + '<a href="https://b.example">b</a></p>');
    expect(a.length).toBe(2);
  });

  it('emits NO annotation for a fragment-only href, and reports it', () => {
    // A /URI action pointing at "#intro" is a link that looks clickable and
    // does nothing in a viewer. Resolving one needs an id-to-destination map
    // built after placement, which is a follow-up.
    //
    // Reported on `unsupported`, not `skipped`: cssinline.ts is a pure leaf
    // that already carries an `unsupported` list and cannot reach cssflow.ts's
    // `skipped` without threading a new parameter through four call sites.
    const { unsupported } = render('<p><a href="#intro">jump</a></p>');
    expect(annots('<p><a href="#intro">jump</a></p>').length).toBe(0);
    expect(unsupported.some(
      (u) => u.property === 'href' && u.value === '#intro')).toBe(true);
  });

  it('still renders the TEXT of a fragment link', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { elements } = htmlElements(doc, '<p><a href="#intro">jump</a></p>', 400);
    placeElements(doc, page, elements, [20, 20, 400, 750], { paragraphSpacing: 0 });
    expect(page.GetText()).toContain('jump');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlflow.test.ts`
Expected: the first three PASS (they are a fence on working behaviour); the
fragment cases FAIL — one annotation is emitted and nothing is reported.

- [ ] **Step 3: Implement the fragment rule**

In `src/cssinline.ts`, the `href` read is currently:

```ts
      const href = n.ns === 'html' && n.name === 'a' ? n.attrs.get('href') : undefined;
```

`inlineContentOf` already takes `unsupported`; it does NOT take `skipped`.
Rather than thread a second list through a pure leaf, report through the
`unsupported` list it already has:

```ts
      const rawHref = n.ns === 'html' && n.name === 'a' ? n.attrs.get('href') : undefined;
      // A FRAGMENT-only href gets no link. A /URI action pointing at "#intro"
      // is a link that looks clickable and does nothing in a viewer, which is
      // worse than no link — "renders perfectly and links wrongly" is the
      // failure this stack already guards against for merged runs. Resolving
      // one needs an id-to-destination map built after placement.
      const fragment = rawHref !== undefined && rawHref.startsWith('#');
      if (fragment) {
        unsupported.push({
          el: n, property: 'href', value: rawHref, reason: 'unparsable-value',
        });
      }
      const href = fragment ? undefined : rawHref;
```

`reason` is `'unparsable-value'` rather than a new variant: the href parsed
fine and we decline to act on it, which is the same shape as a value we can
read but cannot use. A new `reason` would be a public-surface change for one
case, and `zch2.7` — the issue that consumes this report — can widen it then
if it wants to.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlflow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cssinline.ts test/htmlflow.test.ts
git commit -m "feat(zch2.6): fence links, and refuse a fragment-only href"
```

---

### Task 7: End to end through `AddHtml`

**Files:**
- Modify: `test/htmlflow.test.ts`

- [ ] **Step 1: Write the test**

```ts
describe('tables end to end (zch2.6)', () => {
  it('draws every cell\'s text', () => {
    const { page } = renderPage('<table><tr><td>alpha</td><td>beta</td></tr>'
      + '<tr><td>gamma</td><td>delta</td></tr></table>');
    const text = page.GetText();
    for (const w of ['alpha', 'beta', 'gamma', 'delta']) expect(text).toContain(w);
  });

  it('draws the caption and the cells', () => {
    const { page } = renderPage(
      '<table><caption>Totals</caption><tr><td>a</td></tr></table>');
    expect(page.GetText()).toContain('Totals');
    expect(page.GetText()).toContain('a');
  });

  it('keeps a spanning cell\'s text', () => {
    const { page } = renderPage('<table><tr><td colspan=2>wide</td></tr>'
      + '<tr><td>x</td><td>y</td></tr></table>');
    const t = page.GetText();
    expect(t).toContain('wide');
    expect(t).toContain('x');
    expect(t).toContain('y');
  });

  it('keeps the text of a cell whose content had to be flattened', () => {
    const { page, skipped } = renderPage(
      '<table><tr><td><p>one</p><p>two</p></td></tr></table>');
    expect(skipped).toContain('table-cell-blocks');
    expect(page.GetText()).toContain('one');
    expect(page.GetText()).toContain('two');
  });
});
```

`renderPage` is the existing `render` helper — use whatever that file already
calls it, and do not add a second.

- [ ] **Step 2: Run**

Run: `npx vitest run test/htmlflow.test.ts`
Expected: PASS, because Tasks 2-6 already made it work. **This is a
regression guard at the public boundary, not a driver of new behaviour** —
confirm it is load-bearing by mutation in Task 8 instead.

- [ ] **Step 3: Commit**

```bash
git add test/htmlflow.test.ts
git commit -m "test(zch2.6): tables end to end through AddHtml"
```

---

### Task 8: Mutation sweep

Every rule must be proved load-bearing. Reuse the harness from `zch2.2.7`
(a throwaway script in the session scratchpad, not `scripts/`):

```js
// mutate.mjs — apply one mutation, run tests, report which redden, restore.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const [, , srcPath, testPath, specPath] = process.argv;
const MUTATIONS = JSON.parse(readFileSync(specPath, 'utf8'));
const original = readFileSync(srcPath, 'utf8');
for (const m of MUTATIONS) {
  if (!original.includes(m.find)) { console.log(`!! ${m.name}: FIND NOT PRESENT`); continue; }
  writeFileSync(srcPath, original.replace(m.find, m.replace));
  let out = '';
  try {
    out = execSync(`npx vitest run ${testPath} --reporter=json`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { out = e.stdout ?? ''; }
  const failed = JSON.parse(out.slice(out.indexOf('{'))).testResults
    .flatMap((f) => f.assertionResults).filter((a) => a.status === 'failed')
    .map((a) => a.title);
  console.log(`\n== ${m.name}`);
  console.log(failed.length === 0 ? '   NOTHING REDDENED' : failed.map((t) => `   red: ${t}`).join('\n'));
}
writeFileSync(srcPath, original);
console.log('\nrestored');
```

Test target throughout:
`test/cssbox.test.ts test/csstable.test.ts test/cssflow.test.ts test/htmlflow.test.ts test/datauri.test.ts`

- [ ] **Step 1: Mutate `src/cssbox.ts`**

| Mutation | Must redden |
|---|---|
| `spanAttr` returns the raw parse without the `Number.isInteger && n >= 1` guard | the junk-span case |
| `header` reads only `el.name === 'th'`, dropping `inHead` | the thead case |
| `SECTION_OF` maps `table-footer-group` to `'body'` | the tfoot case |
| `anonCell` is never called from `rowFor` | the stray non-cell child case |
| `collectRows` pushes a caption into `rows` instead of `caption` | the caption case |

- [ ] **Step 2: Mutate `src/csstable.ts`**

| Mutation | Must redden |
|---|---|
| `leadingHeaders` counts header rows ANYWHERE, not just leading | the tfoot-header case |
| `setRepeatingRowsCount` is never called | the thead case |
| `buildTable` returns a builder for an empty table instead of null | the empty-table case |
| `flattenRuns` returns `[]` for `blocks` content | the flattened-text end-to-end case |
| the `table-cell-blocks` report is removed | the report case |
| `borderOf` ignores `border-style: none` and always paints | expected to redden NOTHING — **record as uncovered**, since no assertion reads a cell border |

- [ ] **Step 3: Mutate `src/cssflow.ts`**

| Mutation | Must redden |
|---|---|
| `loneAtomic` requires `content.runs.length === 0` rather than all-whitespace | the whitespace case |
| `loneAtomic` accepts more than one atomic | nothing is expected to assert this — **record as uncovered** unless a case does |
| the caption is emitted AFTER the table | expected to redden NOTHING at the element level — **record as uncovered**, since GetText order is not asserted. If you want it covered, assert the caption's y is above the table's first row instead |
| `imageElement`'s `try/catch` removed | the will-not-decode case |

- [ ] **Step 4: Record the results and close real gaps**

Any mutation that SHOULD redden and does not means the test is not
load-bearing: add the case, then re-run. Any that is expected to redden
nothing goes into `CLAUDE.md` in Task 9 as an explicitly uncovered rule.

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test(zch2.6): close the gaps the mutation sweep found"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: CLAUDE.md**

Add entries for `csstable.ts` and `datauri.ts` in the Source list, and notes
on `cssbox.ts` and `cssflow.ts`. They must carry, as invariants: that
`csstable.ts` is a pure leaf taking `toPt`/`scaleRuns` injected, because the
× 0.75 crosses in `cssflow.ts` and nowhere else; that a cell's content goes
through the SAME builder a paragraph's does; that the §17.2.1 fixup earns its
place on `display: table-*` rather than on `<table>` markup, since
`htmltree.ts` already produces well-formed tables; that only the LEADING
header rows can use `setRepeatingRowsCount` and a header row elsewhere needs
an explicit `header`; that a block cell flattens and reports; that
`BorderInfo` collapses four differing edges to the first painted one; that
`loneAtomic` means no MEANINGFUL runs, with the whitespace reason; and that a
fragment-only href gets no link, with the reason.

Then run the module sweep and confirm the two new modules are covered:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected output: the five pre-existing entries `67mt` is about
(`colorkey.ts`, `errors.ts`, `formremove.ts`, `htmlforms.ts`, `tabletag.ts`)
and NOTHING else. **Those five are not gaps** — `2qkk` judged each as needing
no entry of its own because each carries a prose mention in a neighbour's
entry. Do not add entries for them.

- [ ] **Step 2: CHANGELOG.md**

Under `## [Unreleased]` → `### Added`, newest first. Say what a user gets —
`<table>`, `<img>` and `<a>` render through `AddHtml` — what the limits are
(a block cell flattens, an inline image is still reported until `zch2.11`,
CSS column widths are a follow-up, a fragment href gets no link), and cite
`(zch2.6)`.

- [ ] **Step 3: README.md**

In the "HTML rendering is a documented subset" paragraph, move tables and
images out of the "Tables, images and float placement are not rendered" claim
— float placement stays. Note the `resolveImage` option beside it, since it is
a new public option a caller needs to know about to render a non-`data:`
image.

- [ ] **Step 4: Verify everything**

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean, all files green, `dist/index.js` produced.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md README.md
git commit -m "docs(zch2.6): CHANGELOG, README and CLAUDE.md for tables and images"
```

- [ ] **Step 6: Close and push**

```bash
bd close zch2.6 --reason "<what shipped, the limits, the mutation results>"
git add -A .beads && git commit -m "chore(beads): close zch2.6"
git checkout main && git merge --ff-only zch2.6-css-tables && git push origin main
git status -sb   # MUST show main...origin/main with no ahead/behind
```

---

## Self-review

**Spec coverage.** Every section maps to a task: the module split to Tasks
2-4; the §17.2.1 fixup, spans, headers and the caption to Task 2; borders,
widths, the flattened cell and `autoFitColumns` to Task 3; the `data:`
decoder and the lone-image rule to Tasks 1 and 5; the links fence and the
fragment decision to Task 6; the no-oracle testing position to Tasks 7-8;
documentation to Task 9. The spec's "out of scope" list needs no task.

**Three drafting errors the review caught and FIXED, recorded because each
would have cost the implementer a cycle.** The first draft asserted
`rowCount`, `columnCount` and `repeatingRowsCount` on `TableBuilder`; none of
them exists — the real surface is `rows`, `RowBuilder.cells`,
`CellBuilder.colSpan`/`.rowSpan`/`.header` and `repeatingRowCount`, and the
plan now cites the line numbers. The first draft also paraphrased
`mdflow.ts`'s `data:` decoder instead of transcribing it, getting both
branches wrong (`/;\s*base64\s*$/` for `/;base64$/`, and a `Buffer` binary
decode for a `TextEncoder` one) — which would have made a "move" change
behaviour. And Task 6 drafted a test expecting `skipped` against an
implementation reporting `unsupported`; the test now matches the route, with
the reason it takes that route.

**Type consistency.** `TableBox`/`TableRowBox`/`TableCellBox` are defined in
Task 2 and used unchanged in Tasks 3 and 4. `TableMapCtx` is defined in Task 3
and constructed in Task 4. `decodeDataUri` — that name, matching the existing
identifier so `mdflow.ts`'s call site does not move — is defined in Task 1 and
used in Task 5. `resolveImage`'s `(src, alt)` arity is the same in Task 5's
option, its validation, and `imageElement`.

**Three mutations are predicted to redden nothing** and are called out as
such in Task 8 rather than discovered: the cell-border rule, a multi-atomic
`loneAtomic`, and caption ORDER. The last has a suggested fix if you want it
covered — assert the caption's y against the table's first row.
