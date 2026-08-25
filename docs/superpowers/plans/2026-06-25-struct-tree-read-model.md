# Structure-tree Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, navigable in-memory model of a PDF's logical structure tree (`/StructTreeRoot`), with RoleMap resolution, language inheritance, marked-content (MCID) → text correlation, and ParentTree lookups.

**Architecture:** A new `src/struct.ts` module exposes two live dict-handle classes (`StructTreeRoot`, `StructElement`) wrapping the underlying `PdfDict`s, mirroring `Page`/`Annotation`. The existing content walk in `src/text.ts` is extended to track marked-content sequences and tag each `GlyphEvent` with its active MCID; `struct.ts` runs that walk per page to build a `(page, MCID) → glyphs` map for text extraction. The `Document` facade gains `GetStructTree()`, `IsTagged`, and `Lang`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext — import specifiers carry `.js`), vitest. Zero runtime dependencies (only `node:` built-ins).

## Global Constraints

- **Zero runtime deps** — only `node:` built-ins; do not add npm runtime dependencies.
- **ESM + NodeNext** — every relative import specifier ends in `.js` (e.g. `import { Page } from './page.js'`).
- **`PdfDict` is a `Map<string, PdfObject>`** keyed by name without the leading `/`. Names/strings/refs are tagged objects; use the `isName`/`isDict`/`isRef`/`isString`/`isArray` guards from `types.js`.
- **Live-mutation model** — read accessors resolve straight from the live dict; never copy or mutate during read.
- **TDD** — write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Quality gates** — `npm run typecheck` and `npm test` must both be green before any task is considered done.
- **Errors** — throw only `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` from `errors.js` if an error is needed (none expected here; untagged → `null`).

## File Structure

- **Create `src/struct.ts`** — `StructTreeRoot`, `StructElement`, `ContentItem`, the standard-type set, RoleMap resolution, the number-tree reader, the per-page MCID→glyph map, and `GetText`.
- **Modify `src/text.ts`** — add `mcid?: number` to `GlyphEvent`; track `BMC`/`BDC`/`EMC` in `walkScope`; thread the active MCID into emitted glyphs.
- **Modify `src/document.ts`** — add `GetStructTree()`, `IsTagged`, `Lang`, and an `@internal pageForRef()` helper.
- **Modify `src/index.ts`** — export `StructTreeRoot`, `StructElement`, `ContentItem`.
- **Create `test/helpers/build-tagged-pdf.ts`** — programmatic tagged-PDF fixture.
- **Create `test/struct.test.ts`** — the test suite.
- **Modify `README.md`** — Features + Limitations.

---

### Task 1: Tagged-PDF fixture builder

**Files:**
- Create: `test/helpers/build-tagged-pdf.ts`
- Test: `test/struct.test.ts` (smoke test only in this task)

**Interfaces:**
- Consumes: nothing.
- Produces: `buildTaggedPdf(): Uint8Array` — a one-page classic-xref PDF whose catalog has `/StructTreeRoot`, `/MarkInfo << /Marked true >>`, and `/Lang (en-US)`. Object layout: 1 Catalog, 2 Pages, 3 Page, 4 Contents (two MCID-marked text runs, MCID 0 = "Hello Heading", MCID 1 = "Body paragraph"), 5 Font (Helvetica), 6 Link annot (`/StructParent 1`), 7 StructTreeRoot, 8 Document elem, 9 H1 elem (`/S /MyHead`, MCID 0), 10 P elem (`/S /P`, MCID 1), 11 Figure elem (`/S /Figure`, OBJR → 6), 12 ParentTree.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-tagged-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref tagged PDF.
 *
 *  Catalog carries /StructTreeRoot, /MarkInfo << /Marked true >>, /Lang (en-US).
 *  Page content has two marked-content sequences: MCID 0 ("Hello Heading"),
 *  MCID 1 ("Body paragraph"). Structure tree:
 *    Document (8)
 *      H1 via RoleMap MyHead->SubHead->H2 (9), /Pg 3, /K 0, /T, /Lang en-GB
 *      P (10), /Pg 3, /K 1, /ActualText
 *      Figure (11), /Pg 3, /Alt, /K << /Type /OBJR /Obj 6 >>
 *  RoleMap also has a Loop1<->Loop2 cycle to exercise the cycle guard.
 *  ParentTree maps page key 0 -> [9 10] (by MCID) and object key 1 -> 11. */
export function buildTaggedPdf(): Uint8Array {
  const content =
    '/P <</MCID 0>> BDC\nBT /F1 24 Tf 50 350 Td (Hello Heading) Tj ET\nEMC\n' +
    '/P <</MCID 1>> BDC\nBT /F1 12 Tf 50 300 Td (Body paragraph) Tj ET\nEMC\n';

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 /Annots [6 0 R] >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< /Type /Annot /Subtype /Link /Rect [50 100 150 150] /StructParent 1 >>`;
  objects[7] = `<< /Type /StructTreeRoot /K [8 0 R] /RoleMap << /MyHead /SubHead /SubHead /H2 /Loop1 /Loop2 /Loop2 /Loop1 >> /ParentTree 12 0 R >>`;
  objects[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R 10 0 R 11 0 R] >>`;
  objects[9] = `<< /Type /StructElem /S /MyHead /P 8 0 R /Pg 3 0 R /K 0 /T (Heading One) /Lang (en-GB) >>`;
  objects[10] = `<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K 1 /ActualText (Body paragraph actual) >>`;
  objects[11] = `<< /Type /StructElem /S /Figure /P 8 0 R /Pg 3 0 R /Alt (A descriptive figure) /K << /Type /OBJR /Obj 6 0 R >> >>`;
  objects[12] = `<< /Nums [0 [9 0 R 10 0 R] 1 11 0 R] >>`;
  const maxObj = 12;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 2: Write the smoke test**

Create `test/struct.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';

describe('tagged-pdf fixture', () => {
  it('opens and exposes one page', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.Pages.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run the smoke test**

Run: `npx vitest run test/struct.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add test/helpers/build-tagged-pdf.ts test/struct.test.ts
git commit -m "test(struct): tagged-pdf fixture builder + smoke test"
```

---

### Task 2: Marked-content MCID tracking in the content walk

**Files:**
- Modify: `src/text.ts` (`GlyphEvent` interface ~line 136; `walkScope` ~line 198; `emitGlyphs` ~line 290; `emitGlyphArray` ~line 312)
- Test: `test/struct.test.ts`

**Interfaces:**
- Consumes: `visitContent(doc, page, visitor)`, `GlyphEvent` from `text.js`; `buildTaggedPdf()`.
- Produces: `GlyphEvent.mcid?: number` — the innermost active MCID when the glyph was drawn (`undefined` outside any MCID-bearing marked-content sequence).

- [ ] **Step 1: Write the failing test**

Append to `test/struct.test.ts`:

```ts
import { visitContent } from '../src/index.js';
import type { GlyphEvent } from '../src/index.js';

describe('marked-content MCID tracking', () => {
  it('tags glyphs with their enclosing MCID', () => {
    const doc = Document.Open(buildTaggedPdf());
    const page = doc.Pages[0];
    const byMcid = new Map<number | undefined, string>();
    visitContent(doc, page, {
      glyph: (e: GlyphEvent) => {
        byMcid.set(e.mcid, (byMcid.get(e.mcid) ?? '') + e.text);
      },
    });
    expect(byMcid.get(0)).toBe('Hello Heading');
    expect(byMcid.get(1)).toBe('Body paragraph');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct.test.ts -t "tags glyphs"`
Expected: FAIL — `byMcid.get(0)` is `undefined` (every glyph currently has `mcid === undefined`, so all text lands under the `undefined` key).

- [ ] **Step 3: Add `mcid` to the `GlyphEvent` interface**

In `src/text.ts`, add to `interface GlyphEvent` (after the `advance` field, before the closing `}`):

```ts
  /** The innermost active marked-content MCID when this glyph was drawn,
   *  or undefined outside any MCID-bearing marked-content sequence. */
  mcid?: number;
```

- [ ] **Step 4: Track marked content in `walkScope`**

In `src/text.ts`, inside `walkScope`, after the existing `const xobjects = resolveDict(ctx.doc, resources?.get('XObject'));` line, add:

```ts
  const properties = resolveDict(ctx.doc, resources?.get('Properties'));
  const mcidStack: (number | undefined)[] = [];
  let activeMcid: number | undefined;
```

Then add these three cases to the `switch (op.operator)` block (e.g. just before the `case 'BI':` line):

```ts
        case 'BMC': mcidStack.push(activeMcid); break;
        case 'BDC': {
          mcidStack.push(activeMcid);
          const m = mcidFromProps(ctx.doc, properties, op.operands[1]);
          if (m !== undefined) activeMcid = m;
          break;
        }
        case 'EMC': if (mcidStack.length) activeMcid = mcidStack.pop(); break;
```

Change the four glyph-emitting call sites to pass `activeMcid` as a new trailing argument:

```ts
        case 'Tj': emitGlyphs(ctx, st, op.operands[0], curCtm, addr, 0, activeMcid); break;
        case 'TJ': emitGlyphArray(ctx, st, op.operands[0], curCtm, addr, activeMcid); break;
        case "'": lineMove(st, 0, -st.leading); emitGlyphs(ctx, st, op.operands[0], curCtm, addr, 0, activeMcid); break;
        case '"': {
          st.wordSp = num(op.operands[0]); st.charSp = num(op.operands[1]);
          lineMove(st, 0, -st.leading); emitGlyphs(ctx, st, op.operands[2], curCtm, addr, 0, activeMcid); break;
        }
```

- [ ] **Step 5: Thread `mcid` through the emit helpers**

In `src/text.ts`, change `emitGlyphs` to accept and stamp the MCID:

```ts
function emitGlyphs(ctx: Ctx, st: TextState, strObj: PdfObject, ctm: Matrix, addr: ContentAddr, elementIndex: number, mcid?: number): void {
```

and in its `ctx.visitor.glyph?.({ ... })` object literal add `mcid,` (e.g. after `advance,`).

Change `emitGlyphArray` to accept and forward it:

```ts
function emitGlyphArray(ctx: Ctx, st: TextState, arrObj: PdfObject, ctm: Matrix, addr: ContentAddr, mcid?: number): void {
  if (!isArray(arrObj) || !st.font) return;
  arrObj.forEach((el, idx) => {
    if (isString(el)) emitGlyphs(ctx, st, el, ctm, addr, idx, mcid);
    else if (typeof el === 'number') {
      const shift = (-el / 1000) * st.fontSize * st.hscale;
      st.tm = mul(translate(shift, 0), st.tm);
    }
  });
}
```

- [ ] **Step 6: Add the `mcidFromProps` helper**

In `src/text.ts`, near the other small helpers at the bottom (next to `resolveDict`), add:

```ts
/** The /MCID of a BDC properties operand: an inline dict, or a name resolved
 *  through the page's /Properties resource. Undefined when there is no MCID. */
function mcidFromProps(doc: Document, properties: PdfDict | undefined, operand: PdfObject | undefined): number | undefined {
  let d: PdfObject | undefined = operand;
  if (isName(operand)) d = properties?.get(operand.name);
  const dict = doc.resolve(d);
  if (!isDict(dict)) return undefined;
  const m = doc.resolve(dict.get('MCID'));
  return typeof m === 'number' ? m : undefined;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/struct.test.ts -t "tags glyphs"`
Expected: PASS.

- [ ] **Step 8: Run typecheck and the full suite (no regressions)**

Run: `npm run typecheck && npm test`
Expected: PASS — `mcid` is optional and additive, so existing consumers are unaffected.

- [ ] **Step 9: Commit**

```bash
git add src/text.ts test/struct.test.ts
git commit -m "feat(text): track marked-content MCID on glyph events"
```

---

### Task 3: struct.ts core — tree navigation + Document entry points

**Files:**
- Create: `src/struct.ts`
- Modify: `src/document.ts` (imports; `pageForRef`; `GetStructTree`; `IsTagged`; `Lang`)
- Test: `test/struct.test.ts`

**Interfaces:**
- Consumes: `Document` (`resolve`, `getObject`, `catalog`, `Pages`), `Page`, type guards from `types.js`, `decodePdfText` from `metadata.js`.
- Produces:
  - `class StructTreeRoot { Dict; Ref?; Children: StructElement[]; RoleMap: Map<string,string>; ClassMap: Map<string,PdfObject> }`
  - `class StructElement { Dict; Ref?; Type: string; Parent?: StructElement; Children: StructElement[] }`
  - `Document.GetStructTree(): StructTreeRoot | null`
  - `Document.IsTagged: boolean`
  - `Document.Lang: string | undefined`
  - `Document.pageForRef(r: PdfRef): Page | undefined` (`@internal`)

- [ ] **Step 1: Write the failing test**

Append to `test/struct.test.ts`:

```ts
import { StructTreeRoot, StructElement } from '../src/index.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

describe('struct tree navigation', () => {
  it('reports tagged + document language', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.IsTagged).toBe(true);
    expect(doc.Lang).toBe('en-US');
  });

  it('returns null for an untagged document', () => {
    const doc = Document.Open(buildFormPdf());
    expect(doc.GetStructTree()).toBeNull();
    expect(doc.IsTagged).toBe(false);
  });

  it('walks the element tree, excluding content items from Children', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree).toBeInstanceOf(StructTreeRoot);
    expect(tree.Children.length).toBe(1);
    const docElem = tree.Children[0];
    expect(docElem.Type).toBe('Document');
    expect(docElem.Children.map((c) => c.Type)).toEqual(['MyHead', 'P', 'Figure']);
    // Figure's only /K entry is an OBJR, not a struct element.
    expect(docElem.Children[2].Children.length).toBe(0);
    // Parent navigation.
    expect(docElem.Children[0].Parent?.Type).toBe('Document');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct.test.ts -t "struct tree navigation"`
Expected: FAIL — `StructTreeRoot` is not exported / `GetStructTree` undefined.

- [ ] **Step 3: Create `src/struct.ts` with the core classes**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  PdfObject, PdfDict, PdfRef, isDict, isRef, isName, isArray, isString,
} from './types.js';
import { decodePdfText } from './metadata.js';

/** Normalize a struct element's /K into an array of entries. /K may be a single
 *  item (int / dict / ref), an array, or absent. */
function kids(doc: Document, dict: PdfDict): PdfObject[] {
  const k = dict.get('K'); // keep refs un-resolved so we can build child elems
  if (k === undefined) return [];
  const resolved = doc.resolve(k);
  if (isArray(resolved)) return resolved;
  return [k];
}

/** True when a resolved /K entry is itself a structure element (has /S). */
function isStructElem(doc: Document, o: PdfObject): boolean {
  const d = doc.resolve(o);
  return isDict(d) && d.has('S');
}

/** A node in the structure tree: a live handle over its real /StructElem dict. */
export class StructElement {
  constructor(
    private readonly doc: Document,
    /** The live structure-element dict. */
    readonly Dict: PdfDict,
    /** This element's indirect ref, when it has one. */
    readonly Ref: PdfRef | undefined,
    /** The owning structure tree root (for RoleMap resolution). */
    readonly Root: StructTreeRoot,
  ) {}

  /** The raw structure type (/S), e.g. 'P', 'H1', or a custom role name. */
  get Type(): string {
    const s = this.doc.resolve(this.Dict.get('S'));
    return isName(s) ? s.name : '';
  }

  /** The parent element, or undefined when the parent is the tree root. */
  get Parent(): StructElement | undefined {
    const pRef = this.Dict.get('P');
    const p = this.doc.resolve(pRef);
    if (!isDict(p) || !p.has('S')) return undefined; // root or missing
    return new StructElement(this.doc, p, isRef(pRef) ? pRef : undefined, this.Root);
  }

  /** Child elements only (integers, MCR, and OBJR content items excluded). */
  get Children(): StructElement[] {
    const out: StructElement[] = [];
    for (const k of kids(this.doc, this.Dict)) {
      if (!isStructElem(this.doc, k)) continue;
      const d = this.doc.resolve(k) as PdfDict;
      out.push(new StructElement(this.doc, d, isRef(k) ? k : undefined, this.Root));
    }
    return out;
  }
}

/** The document's logical structure tree: a live handle over /StructTreeRoot. */
export class StructTreeRoot {
  /** Custom role -> mapped role name, from /RoleMap (values are name strings). */
  readonly RoleMap: Map<string, string>;
  /** Class name -> attribute object, from /ClassMap (raw, unresolved values). */
  readonly ClassMap: Map<string, PdfObject>;

  constructor(
    private readonly doc: Document,
    readonly Dict: PdfDict,
    readonly Ref: PdfRef | undefined,
  ) {
    this.RoleMap = new Map();
    const rm = doc.resolve(Dict.get('RoleMap'));
    if (isDict(rm)) {
      for (const [k, v] of rm) {
        const mapped = doc.resolve(v);
        if (isName(mapped)) this.RoleMap.set(k, mapped.name);
      }
    }
    this.ClassMap = new Map();
    const cm = doc.resolve(Dict.get('ClassMap'));
    if (isDict(cm)) for (const [k, v] of cm) this.ClassMap.set(k, v);
  }

  /** Top-level structure elements (the tree's /K). */
  get Children(): StructElement[] {
    const out: StructElement[] = [];
    for (const k of kids(this.doc, this.Dict)) {
      if (!isStructElem(this.doc, k)) continue;
      const d = this.doc.resolve(k) as PdfDict;
      out.push(new StructElement(this.doc, d, isRef(k) ? k : undefined, this));
    }
    return out;
  }
}

/** Decode a PDF text-string value to JS text, or undefined when not a string. */
export function textValue(doc: Document, v: PdfObject | undefined): string | undefined {
  const s = doc.resolve(v);
  return isString(s) ? decodePdfText(s.bytes) : undefined;
}
```

- [ ] **Step 4: Wire the Document facade**

In `src/document.ts`, add the import near the other module imports:

```ts
import { StructTreeRoot } from './struct.js';
```

Ensure `isString` and `isRef` are imported from `./types.js` in `document.ts` (add them to the existing `types.js` import if missing).

Add these members to the `Document` class (e.g. after `GetXmp()`):

```ts
  /** The document's logical structure tree, or null when untagged. */
  GetStructTree(): StructTreeRoot | null {
    const stRef = this.catalog().get('StructTreeRoot');
    const st = this.resolve(stRef);
    if (!isDict(st)) return null;
    return new StructTreeRoot(this, st, isRef(stRef) ? stRef : undefined);
  }

  /** Whether the catalog declares the document Tagged (/MarkInfo /Marked true). */
  get IsTagged(): boolean {
    const mi = this.resolve(this.catalog().get('MarkInfo'));
    return isDict(mi) && this.resolve(mi.get('Marked')) === true;
  }

  /** The document default language (/Lang on the catalog), or undefined. */
  get Lang(): string | undefined {
    const l = this.resolve(this.catalog().get('Lang'));
    return isString(l) ? decodePdfText(l.bytes) : undefined;
  }

  /** @internal Map a page object ref to its Page handle, or undefined. */
  pageForRef(r: PdfRef): Page | undefined {
    const i = this.pageObjNums.indexOf(r.num);
    return i >= 0 ? this.Pages[i] : undefined;
  }
```

Add `import { decodePdfText } from './metadata.js';` to `document.ts` if not already imported. Confirm `Page` and `PdfRef` are imported there (they are used elsewhere in the file).

- [ ] **Step 5: Add temporary exports so the test can import the classes**

In `src/index.ts`, add (final export wiring lands in Task 7, but the classes are needed now):

```ts
export { StructTreeRoot, StructElement } from './struct.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/struct.test.ts -t "struct tree navigation"`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/struct.ts src/document.ts src/index.ts test/struct.test.ts
git commit -m "feat(struct): structure-tree model + GetStructTree/IsTagged/Lang"
```

---

### Task 4: RoleMap resolution and standard types

**Files:**
- Modify: `src/struct.ts`
- Test: `test/struct.test.ts`

**Interfaces:**
- Consumes: `StructTreeRoot`, `StructElement` from Task 3.
- Produces:
  - `StructTreeRoot.ResolveRole(role: string): string` — follows the RoleMap chain to a standard type (cycle-guarded).
  - `StructElement.StandardType: string` — `Root.ResolveRole(this.Type)`.
  - `StructElement.IsStandardType: boolean` — whether `StandardType` is a known PDF 1.7 standard structure type.
  - exported `STANDARD_STRUCTURE_TYPES: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct.test.ts`:

```ts
describe('role map resolution', () => {
  it('resolves a custom role through a chain to a standard type', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const h = tree.Children[0].Children[0]; // S = MyHead
    expect(h.Type).toBe('MyHead');
    expect(h.StandardType).toBe('H2'); // MyHead -> SubHead -> H2
    expect(h.IsStandardType).toBe(true);
  });

  it('passes a standard type through unchanged', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const p = tree.Children[0].Children[1];
    expect(p.StandardType).toBe('P');
  });

  it('terminates on a cyclic role map', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree.ResolveRole('Loop1')).toBe('Loop1'); // Loop1<->Loop2 cycle, guarded
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct.test.ts -t "role map resolution"`
Expected: FAIL — `StandardType` / `ResolveRole` undefined.

- [ ] **Step 3: Add the standard-type set**

In `src/struct.ts`, add near the top (after the imports):

```ts
/** The PDF 1.7 standard structure types (grouping, block-level, inline-level,
 *  and illustration). Used by IsStandardType and to terminate RoleMap chains. */
export const STANDARD_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  // Grouping
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC',
  'TOCI', 'Index', 'NonStruct', 'Private',
  // Block-level
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  // Inline-level
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot',
  'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
  // Illustration
  'Figure', 'Formula', 'Form',
]);
```

- [ ] **Step 4: Add `ResolveRole` to `StructTreeRoot`**

In `src/struct.ts`, add this method to `StructTreeRoot`:

```ts
  /** Follow the RoleMap chain from `role` to a standard structure type.
   *  Stops at the first standard type, at an unmapped name, or on a cycle. */
  ResolveRole(role: string): string {
    let cur = role;
    const seen = new Set<string>();
    while (!STANDARD_STRUCTURE_TYPES.has(cur) && this.RoleMap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.RoleMap.get(cur)!;
    }
    return cur;
  }
```

- [ ] **Step 5: Add `StandardType` / `IsStandardType` to `StructElement`**

In `src/struct.ts`, add to `StructElement`:

```ts
  /** The structure type resolved through the RoleMap chain to a standard type. */
  get StandardType(): string {
    return this.Root.ResolveRole(this.Type);
  }

  /** Whether StandardType is a known PDF 1.7 standard structure type. */
  get IsStandardType(): boolean {
    return STANDARD_STRUCTURE_TYPES.has(this.StandardType);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/struct.test.ts -t "role map resolution"`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/struct.ts test/struct.test.ts
git commit -m "feat(struct): RoleMap chain resolution + standard types"
```

---

### Task 5: Element metadata, content items, and ParentTree lookups

**Files:**
- Modify: `src/struct.ts`
- Test: `test/struct.test.ts`

**Interfaces:**
- Consumes: `StructElement`, `StructTreeRoot` from prior tasks; `Document.pageForRef`; `textValue`.
- Produces:
  - `StructElement`: `Title`, `Lang`, `EffectiveLang`, `Alt`, `ActualText`, `Expansion`, `ID` (all `string | undefined`); `Page: Page | undefined`; `ContentItems: ContentItem[]`; `Attributes: { A: PdfObject[]; C: PdfObject[] }`.
  - `StructTreeRoot`: `ElementFor(structParentsKey: number, mcid: number): StructElement | undefined`; `ElementForObject(structParentKey: number): StructElement | undefined`.
  - exported `type ContentItem = { kind: 'mcid'; page: Page | undefined; mcid: number } | { kind: 'objr'; page: Page | undefined; ref: PdfRef }`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct.test.ts`:

```ts
describe('element metadata + content items', () => {
  it('reads title, alt, actual text, and language inheritance', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const [h, p, fig] = tree.Children[0].Children;
    expect(h.Title).toBe('Heading One');
    expect(h.Lang).toBe('en-GB');
    expect(h.EffectiveLang).toBe('en-GB');
    expect(p.Lang).toBeUndefined();
    expect(p.EffectiveLang).toBe('en-US');   // inherited from catalog /Lang
    expect(p.ActualText).toBe('Body paragraph actual');
    expect(fig.Alt).toBe('A descriptive figure');
  });

  it('associates elements with their page', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const h = tree.Children[0].Children[0];
    expect(h.Page?.Number).toBe(1);
  });

  it('exposes content items (mcid + objr)', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const [h, , fig] = tree.Children[0].Children;
    expect(h.ContentItems).toEqual([{ kind: 'mcid', page: h.Page, mcid: 0 }]);
    const objr = fig.ContentItems[0];
    expect(objr.kind).toBe('objr');
  });

  it('looks up elements through the ParentTree', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree.ElementFor(0, 0)?.Type).toBe('MyHead');
    expect(tree.ElementFor(0, 1)?.Type).toBe('P');
    expect(tree.ElementForObject(1)?.Type).toBe('Figure');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct.test.ts -t "element metadata"`
Expected: FAIL — `Title` / `Page` / `ContentItems` / `ElementFor` undefined.

- [ ] **Step 3: Add the `ContentItem` type and number-tree reader**

In `src/struct.ts`, add the type after the imports:

```ts
/** A marked-content reference owned by a structure element. */
export type ContentItem =
  | { kind: 'mcid'; page: Page | undefined; mcid: number }
  | { kind: 'objr'; page: Page | undefined; ref: PdfRef };
```

And add this module-level helper (near `textValue`):

```ts
/** Look up `key` in a PDF number tree rooted at `node` (/Nums leaves, /Kids
 *  with /Limits for intermediate nodes). Returns the (unresolved) value or
 *  undefined. */
export function lookupNumberTree(doc: Document, node: PdfDict, key: number): PdfObject | undefined {
  let cur: PdfDict | undefined = node;
  const seen = new Set<PdfDict>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const nums = doc.resolve(cur.get('Nums'));
    if (isArray(nums)) {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (doc.resolve(nums[i]) === key) return nums[i + 1];
      }
    }
    const kidsArr = doc.resolve(cur.get('Kids'));
    if (!isArray(kidsArr)) return undefined;
    let next: PdfDict | undefined;
    for (const k of kidsArr) {
      const kd = doc.resolve(k);
      if (!isDict(kd)) continue;
      const lim = doc.resolve(kd.get('Limits'));
      if (isArray(lim) && lim.length === 2) {
        const lo = doc.resolve(lim[0]); const hi = doc.resolve(lim[1]);
        if (typeof lo === 'number' && typeof hi === 'number' && key >= lo && key <= hi) {
          next = kd; break;
        }
      }
    }
    cur = next;
  }
  return undefined;
}
```

- [ ] **Step 4: Add metadata + page + content-item accessors to `StructElement`**

In `src/struct.ts`, add these members to `StructElement`. They reuse `textValue` and `lookupNumberTree`; `doc` is the private field already on the class.

```ts
  /** Title (/T). */
  get Title(): string | undefined { return textValue(this.doc, this.Dict.get('T')); }
  /** Alternate description (/Alt). */
  get Alt(): string | undefined { return textValue(this.doc, this.Dict.get('Alt')); }
  /** Replacement text (/ActualText). */
  get ActualText(): string | undefined { return textValue(this.doc, this.Dict.get('ActualText')); }
  /** Abbreviation expansion (/E). */
  get Expansion(): string | undefined { return textValue(this.doc, this.Dict.get('E')); }
  /** Element identifier (/ID). */
  get ID(): string | undefined { return textValue(this.doc, this.Dict.get('ID')); }
  /** This element's own language (/Lang), if set. */
  get Lang(): string | undefined { return textValue(this.doc, this.Dict.get('Lang')); }

  /** Language resolved up the ancestor chain, then the document default. */
  get EffectiveLang(): string | undefined {
    let node: StructElement | undefined = this;
    while (node) {
      const l = node.Lang;
      if (l !== undefined) return l;
      node = node.Parent;
    }
    return this.doc.Lang;
  }

  /** The page this element's content lives on (/Pg, inherited from ancestors). */
  get Page(): Page | undefined {
    let node: StructElement | undefined = this;
    while (node) {
      const pg = node.Dict.get('Pg');
      if (isRef(pg)) return this.doc.pageForRef(pg);
      node = node.Parent;
    }
    return undefined;
  }

  /** Raw attribute objects: /A (attribute dicts/streams) and /C (class names). */
  get Attributes(): { A: PdfObject[]; C: PdfObject[] } {
    const toArr = (v: PdfObject | undefined): PdfObject[] => {
      if (v === undefined) return [];
      const r = this.doc.resolve(v);
      return isArray(r) ? r : [v];
    };
    return { A: toArr(this.Dict.get('A')), C: toArr(this.Dict.get('C')) };
  }

  /** The marked-content references (/K integers, MCR dicts, OBJR dicts). */
  get ContentItems(): ContentItem[] {
    const out: ContentItem[] = [];
    const ownPage = this.Page;
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        out.push({ kind: 'mcid', page: ownPage, mcid: r });
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        const typeName = isName(type) ? type.name : '';
        if (typeName === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          if (typeof mcid === 'number') {
            const pg = r.get('Pg');
            out.push({ kind: 'mcid', page: isRef(pg) ? this.doc.pageForRef(pg) : ownPage, mcid });
          }
        } else if (typeName === 'OBJR') {
          const obj = r.get('Obj');
          if (isRef(obj)) {
            const pg = r.get('Pg');
            out.push({ kind: 'objr', page: isRef(pg) ? this.doc.pageForRef(pg) : ownPage, ref: obj });
          }
        }
      }
    }
    return out;
  }
```

- [ ] **Step 5: Add ParentTree lookups to `StructTreeRoot`**

In `src/struct.ts`, add to `StructTreeRoot`:

```ts
  /** The element for a page's marked content: ParentTree[structParentsKey] is
   *  an array indexed by MCID. */
  ElementFor(structParentsKey: number, mcid: number): StructElement | undefined {
    const pt = this.doc.resolve(this.Dict.get('ParentTree'));
    if (!isDict(pt)) return undefined;
    const v = this.doc.resolve(lookupNumberTree(this.doc, pt, structParentsKey));
    if (!isArray(v)) return undefined;
    const entryRef = v[mcid];
    const d = this.doc.resolve(entryRef);
    if (!isDict(d) || !d.has('S')) return undefined;
    return new StructElement(this.doc, d, isRef(entryRef) ? entryRef : undefined, this);
  }

  /** The element for an object (annotation / XObject) via its /StructParent key:
   *  ParentTree[structParentKey] is the element directly. */
  ElementForObject(structParentKey: number): StructElement | undefined {
    const pt = this.doc.resolve(this.Dict.get('ParentTree'));
    if (!isDict(pt)) return undefined;
    const entryRef = lookupNumberTree(this.doc, pt, structParentKey);
    const d = this.doc.resolve(entryRef);
    if (!isDict(d) || !d.has('S')) return undefined;
    return new StructElement(this.doc, d, isRef(entryRef) ? entryRef : undefined, this);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/struct.test.ts -t "element metadata"`
Expected: PASS (4 tests).

Then also run the ParentTree test name:
Run: `npx vitest run test/struct.test.ts -t "ParentTree"`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/struct.ts test/struct.test.ts
git commit -m "feat(struct): element metadata, content items, ParentTree lookups"
```

---

### Task 6: MCID → text resolution (GetText)

**Files:**
- Modify: `src/struct.ts`
- Test: `test/struct.test.ts`

**Interfaces:**
- Consumes: `visitContent`, `assembleLines`, `GlyphEvent`, `Run` from `text.js`; `StructElement.ContentItems`/`Children`/`Page`; `StructTreeRoot.Children`.
- Produces:
  - `StructElement.GetText(): string` — this element + descendants, in `/K` (reading) order.
  - `StructTreeRoot.GetText(): string` — whole-tree reading-order text.

- [ ] **Step 1: Write the failing test**

Append to `test/struct.test.ts`:

```ts
describe('reading-order text', () => {
  it('extracts text per element from its MCIDs', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const [h, p] = tree.Children[0].Children;
    expect(h.GetText()).toBe('Hello Heading');
    expect(p.GetText()).toBe('Body paragraph');
  });

  it('walks the whole tree in reading order', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree.GetText()).toBe('Hello Heading\nBody paragraph');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct.test.ts -t "reading-order text"`
Expected: FAIL — `GetText` is not a function.

- [ ] **Step 3: Confirm the helpers `struct.ts` will import are exported from `text.ts`**

`text.ts` already exports `visitContent`, `assembleLines`, and the `Run` and `GlyphEvent` types (verified). No change needed; if `Run` is not exported, add `Run` to the existing `export interface Run` / export list in `text.ts`.

- [ ] **Step 4: Add the per-page MCID glyph map + GetText to `struct.ts`**

In `src/struct.ts`, add the import:

```ts
import { visitContent, assembleLines, type GlyphEvent, type Run } from './text.js';
```

Add a module-level cached map builder:

```ts
/** Per-page cache of MCID -> glyph events, built from one content walk. */
const mcidCache = new WeakMap<Page, Map<number, GlyphEvent[]>>();

function mcidGlyphs(doc: Document, page: Page): Map<number, GlyphEvent[]> {
  const cached = mcidCache.get(page);
  if (cached) return cached;
  const map = new Map<number, GlyphEvent[]>();
  visitContent(doc, page, {
    glyph: (e: GlyphEvent) => {
      if (e.mcid === undefined || !e.text) return;
      const list = map.get(e.mcid) ?? [];
      list.push(e);
      map.set(e.mcid, list);
    },
  });
  mcidCache.set(page, map);
  return map;
}

/** Assemble a glyph list into text via the shared line layout. */
function glyphsToText(glyphs: GlyphEvent[]): string {
  const runs: Run[] = glyphs.map((e) => ({
    x: e.quad[0], endX: e.quad[2], y: e.quad[1], text: e.text,
    size: e.quad[3] - e.quad[1],
  }));
  return assembleLines(runs);
}
```

Add `GetText` to `StructElement` (walks `/K` in order so MCIDs and child elements interleave in reading order):

```ts
  /** This element's text and its descendants', in /K (reading) order. */
  GetText(): string {
    const parts: string[] = [];
    const ownPage = this.Page;
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        if (ownPage) parts.push(glyphsToText(mcidGlyphs(this.doc, ownPage).get(r) ?? []));
      } else if (isStructElem(this.doc, k)) {
        const child = new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root);
        parts.push(child.GetText());
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        if (isName(type) && type.name === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          const pg = r.get('Pg');
          const page = isRef(pg) ? this.doc.pageForRef(pg) : ownPage;
          if (typeof mcid === 'number' && page) {
            parts.push(glyphsToText(mcidGlyphs(this.doc, page).get(mcid) ?? []));
          }
        }
        // OBJR: no text contribution.
      }
    }
    return parts.filter((s) => s.length > 0).join('\n');
  }
```

Add `GetText` to `StructTreeRoot`:

```ts
  /** The whole tree's text, in reading order. */
  GetText(): string {
    return this.Children.map((c) => c.GetText()).filter((s) => s.length > 0).join('\n');
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/struct.test.ts -t "reading-order text"`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full struct suite + typecheck**

Run: `npx vitest run test/struct.test.ts && npm run typecheck`
Expected: PASS (all struct tests).

- [ ] **Step 7: Commit**

```bash
git add src/struct.ts test/struct.test.ts
git commit -m "feat(struct): MCID->text resolution (StructElement/StructTreeRoot GetText)"
```

---

### Task 7: Public exports + documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md` (Features section; Limitations section ~line 603)
- Test: `test/struct.test.ts`

**Interfaces:**
- Consumes: all public types from `struct.js`.
- Produces: the final public surface — `StructTreeRoot`, `StructElement` (values) and `ContentItem` (type) exported from the package root.

- [ ] **Step 1: Write the failing test**

Append to `test/struct.test.ts`:

```ts
describe('public exports', () => {
  it('exposes the structure types from the package root', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.StructTreeRoot).toBe('function');
    expect(typeof mod.StructElement).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test (it likely already passes from Task 3's temporary export — make it intentional)**

Run: `npx vitest run test/struct.test.ts -t "public exports"`
Expected: PASS (the class export was added in Task 3).

- [ ] **Step 3: Finalize `src/index.ts` exports**

Replace the temporary line from Task 3 with the complete export block (place near the other read-model exports, e.g. after the `text.js` exports on line 23):

```ts
export { StructTreeRoot, StructElement, STANDARD_STRUCTURE_TYPES } from './struct.js';
export type { ContentItem } from './struct.js';
```

- [ ] **Step 4: Update README Features**

In `README.md`, add a bullet to the Features list describing the new capability:

```markdown
- **Tagged-PDF structure reading** — `doc.GetStructTree()` returns a navigable
  logical structure tree (`StructTreeRoot` → `StructElement`): structure types
  resolved through `/RoleMap` (`StandardType`/`IsStandardType`), `/Lang`
  (own + inherited `EffectiveLang`), `/Alt`, `/ActualText`, `/T`, marked-content
  items, `/ParentTree` lookups, and per-element reading-order text
  (`GetText()`) via MCID→content correlation. `doc.IsTagged` / `doc.Lang`
  report document-level accessibility flags.
```

- [ ] **Step 5: Update README Limitations**

In `README.md`, replace the existing "Page copies are pruned" bullet (around line 603) to note structure reading is read-only:

Find:
```markdown
- **Page copies are pruned** — pages copied between documents lose document-level links such as `GoTo` actions, `/Dest`, and `/StructParents` (see `defaultPrunePolicy` / the `PrunePolicy` option to customize).
```

Replace with:
```markdown
- **Page copies are pruned** — pages copied between documents lose document-level links such as `GoTo` actions, `/Dest`, and `/StructParents` (see `defaultPrunePolicy` / the `PrunePolicy` option to customize).
- **Tagged-PDF support is read-only** — `GetStructTree()` parses and navigates the structure tree but does not author or edit tags, preserve structure across page operations (extract/split/merge still drop `/StructParents`), interpret table/list layout attributes, or validate PDF/UA conformance.
```

- [ ] **Step 6: Run the full test suite + typecheck + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS — full suite green, `dist/` builds.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts README.md test/struct.test.ts
git commit -m "feat(struct): export structure-tree API + document it"
```

---

## Self-Review

**Spec coverage** (each spec section → task):

- Module & entry points (`GetStructTree`/`IsTagged`/`Lang`) → Task 3. ✓
- `StructTreeRoot` (Children/RoleMap/ClassMap/ParentTree lookups/GetText/Dict/Ref) → Tasks 3, 4 (RoleMap), 5 (ParentTree), 6 (GetText). ✓
- `StructElement` accessors (Type/StandardType/IsStandardType/Title/Lang/EffectiveLang/Alt/ActualText/Expansion/ID/Page/Parent/Children/ContentItems/Attributes/GetText/Dict/Ref) → Tasks 3 (Type/Parent/Children/Dict/Ref), 4 (StandardType/IsStandardType), 5 (Title/Lang/EffectiveLang/Alt/ActualText/Expansion/ID/Page/ContentItems/Attributes), 6 (GetText). ✓
- MCID→text resolution (text.ts change: BDC/BMC/EMC, `mcid` on GlyphEvent) → Task 2; correlation/GetText → Task 6. ✓
- Standard type data + edge cases (untagged→null, /K normalization, missing /Pg fallback, RoleMap cycles, MCR/OBJR, /Lang string) → Tasks 1 (fixture exercises these), 3 (/K normalization, untagged→null), 4 (cycle guard + standard set), 5 (Pg inheritance, MCR/OBJR). ✓
- Testing (fixture builder + struct.test.ts) → Task 1 onward. ✓
- Public API summary + README → Task 7. ✓

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N" — every code step shows complete code. ✓

**Type consistency:**
- `StructElement` constructor signature `(doc, Dict, Ref, Root)` is identical at every construction site (Tasks 3, 5, 6). ✓
- `ContentItem` union (`{kind:'mcid', page, mcid}` | `{kind:'objr', page, ref}`) matches its producers in `ContentItems` (Task 5) and the test (Task 5). ✓
- `mcid?: number` added to `GlyphEvent` (Task 2) is the field read by `mcidGlyphs` (Task 6). ✓
- `Run` fields `{x, endX, y, text, size}` (Task 6 `glyphsToText`) match `text.ts`'s `Run` and `extractText` usage. ✓
- `ResolveRole`/`StandardType`/`IsStandardType` names consistent across Task 4 definition and Task 5/6 usage. ✓
- `pageForRef(r: PdfRef): Page | undefined` defined in Task 3, used in Task 5 `Page`/`ContentItems` and Task 6 `GetText`. ✓
- `STANDARD_STRUCTURE_TYPES` defined in Task 4, exported in Task 7. ✓

No issues found.
