# Deep attribute semantics (S4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typed read + write of the standard structure-attribute owners — Table, List, and the full Layout owner — on top of the S1 raw `/A`+`/C` passthrough.

**Architecture:** A new `src/structattr.ts` holds the value codecs, the owner-collection/precedence logic, declarative field tables, and per-owner read/write functions. `StructElement` (in `struct.ts`) gains thin typed getters/setters that delegate to it. Reads merge `/A` (then `/C` via the root's `/ClassMap`) by PDF precedence; writers merge a typed partial into the element's `/A` dict for that owner.

**Tech Stack:** TypeScript (strict, NodeNext, `.js` import specifiers), vitest, zero runtime deps.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension.
- **Strict TypeScript** — `npm run typecheck` must be green. Explicit `any` is allowed; implicit `any` is not.
- **TDD** — write the failing test first.
- **Live-mutation model** — edits act on the live object map; call `doc.markModified()` from new mutation entry points.
- **PDF naming** — `PdfDict` keys carry no leading `/`; names are `name('X')`; text strings are `{ kind: 'string', bytes: encodePdfText(s) }`; `isName`/`isArray`/`isDict`/`isString`/`isRef` are the guards in `types.ts`.
- **RGB convention** — colors are `[r, g, b]` components in 0..1.
- Run `npm run typecheck` and `npm test` before closing beads issue `aspose-pdf-foss-for-ts-pjx.4`.

## File Structure

- **Create `src/structattr.ts`** — types (`RGB`, `Edged`, `BorderStyle`, `TableAttributes`, `ListAttributes`, `LayoutAttributes`), value codecs, `collectOwnerDicts`/`readAttr`/`ownerDictForWrite` + helpers, declarative field tables, and `readTable`/`writeTable`/`readList`/`writeList`/`readLayout`/`writeLayout`.
- **Modify `src/struct.ts`** — add typed getters (`TableAttributes`/`ListAttributes`/`LayoutAttributes`) and setters (`SetTableAttributes`/`SetListAttributes`/`SetLayoutAttributes`) to `StructElement`, delegating to `structattr.ts`.
- **Modify `src/index.ts`** — export the new types.
- **Modify `README.md`** — Features + Limitations.
- **Create `test/struct-attr.test.ts`** — all S4 tests. Base docs via `buildStampTarget()` (a blank page) + S3 authoring (`CreateStructTree`/`Append`); read-precedence tests poke the live `.Dict` directly (no new fixture builder needed).

### Cyclic-import note

`structattr.ts` imports the `StructTreeRoot` **type** only (`import type { StructTreeRoot } from './struct.js'`) and the `Document`/`Page` types; it imports `encodePdfText` (value) from `metadata.js` and guards/`name` from `types.js`. `struct.ts` imports the `structattr.ts` **functions** (value). This one-directional value import (`struct.ts` → `structattr.ts`) mirrors `structwrite.ts` and has no runtime cycle.

---

## Task 1: Core machinery + Table owner

**Files:**
- Create: `src/structattr.ts`
- Modify: `src/struct.ts` (add `TableAttributes` getter + `SetTableAttributes`)
- Modify: `src/index.ts` (export `RGB`, `Edged`, `TableAttributes`)
- Test: `test/struct-attr.test.ts`

**Interfaces:**
- Consumes: `StructElement` (struct.ts) live handle — `.Dict`, `.Root`, `.doc`; S3 `Document.CreateStructTree`, `StructTreeRoot.Append`.
- Produces:
  - `type RGB = [number, number, number]`, `type Edged<T> = T | [T, T, T, T]`.
  - `interface TableAttributes { rowSpan?; colSpan?; headers?; scope?; summary? }`.
  - `collectOwnerDicts(doc, root, elemDict, owner): PdfDict[]`, `readAttr(dicts, key): PdfObject | undefined`, `ownerDictForWrite(doc, elemDict, owner): PdfDict`.
  - `readTable(doc, root, elemDict): TableAttributes | undefined`, `writeTable(doc, elemDict, attrs: Partial<TableAttributes>): void`.
  - `StructElement.get TableAttributes`, `StructElement.SetTableAttributes(attrs)`.

- [ ] **Step 1: Write the failing test**

Create `test/struct-attr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { name } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

describe('TableAttributes (read/write)', () => {
  it('round-trips table attributes through Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const td = root.Append('Table').Append('TR').Append('TD');
    td.SetTableAttributes({ colSpan: 2, headers: ['h1', 'h2'], scope: 'Column' });

    const re = Document.Open(doc.Save());
    const rtd = re.GetStructTree()!.Children[0].Children[0].Children[0];
    const a = rtd.TableAttributes!;
    expect(a.colSpan).toBe(2);
    expect(a.rowSpan).toBe(1);          // default
    expect(a.headers).toEqual(['h1', 'h2']);
    expect(a.scope).toBe('Column');
  });

  it('returns undefined when the element has no /Table attributes', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    expect(p.TableAttributes).toBeUndefined();
  });

  it('prefers /A over /C (ClassMap) for the same owner+key', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const td = root.Append('Table').Append('TD');
    // /C class "cell" -> ColSpan 9 in ClassMap; /A ColSpan 3 must win.
    root.Dict.set('ClassMap', new Map([
      ['cell', new Map<string, any>([['O', name('Table')], ['ColSpan', 9]])],
    ]));
    td.Dict.set('C', name('cell'));
    td.SetTableAttributes({ colSpan: 3 });
    expect(td.TableAttributes!.colSpan).toBe(3);
  });

  it('reads an attribute supplied only via /C', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const td = root.Append('Table').Append('TD');
    root.Dict.set('ClassMap', new Map([
      ['cell', new Map<string, any>([['O', name('Table')], ['RowSpan', 4]])],
    ]));
    td.Dict.set('C', name('cell'));
    expect(td.TableAttributes!.rowSpan).toBe(4);
  });

  it('deletes a key when set to undefined', () => {
    const doc = Document.Open(buildStampTarget());
    const td = doc.CreateStructTree().Append('Table').Append('TD');
    td.SetTableAttributes({ scope: 'Row' });
    td.SetTableAttributes({ scope: undefined });
    expect(td.TableAttributes!.scope).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-attr.test.ts`
Expected: FAIL — `td.SetTableAttributes is not a function`.

- [ ] **Step 3: Create `src/structattr.ts` with core machinery + Table support**

```ts
import type { Document } from './document.js';
import type { StructTreeRoot } from './struct.js';
import {
  PdfObject, PdfDict, isDict, isArray, isName, isString, name,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

export type RGB = [number, number, number];
/** A single value, or one-per-edge [top, right, bottom, left]. */
export type Edged<T> = T | [T, T, T, T];

// ---- value decoders (PdfObject -> JS | undefined) ----
function decNum(doc: Document, o: PdfObject): number | undefined {
  const v = doc.resolve(o);
  return typeof v === 'number' ? v : undefined;
}
function decName(doc: Document, o: PdfObject): string | undefined {
  const v = doc.resolve(o);
  return isName(v) ? v.name : undefined;
}
function decStr(doc: Document, o: PdfObject): string | undefined {
  const v = doc.resolve(o);
  return isString(v) ? decodePdfText(v.bytes) : undefined;
}
function decStrList(doc: Document, o: PdfObject): string[] | undefined {
  const v = doc.resolve(o);
  if (!isArray(v)) return undefined;
  const out: string[] = [];
  for (const e of v) { const s = doc.resolve(e); if (isString(s)) out.push(decodePdfText(s.bytes)); }
  return out;
}
function decEnum(values: readonly string[]) {
  return (doc: Document, o: PdfObject): string | undefined => {
    const n = decName(doc, o);
    return n !== undefined && values.includes(n) ? n : undefined;
  };
}

// ---- value encoders (JS -> PdfObject) ----
function encNum(v: number): PdfObject { return v; }
function encName(v: string): PdfObject { return name(v); }
function encStr(v: string): PdfObject { return { kind: 'string', bytes: encodePdfText(v) }; }
function encStrList(v: string[]): PdfObject { return v.map((s) => ({ kind: 'string', bytes: encodePdfText(s) })); }

/** One field: its PDF key plus a decode/encode pair. */
export interface Field {
  key: string;
  dec: (doc: Document, o: PdfObject) => unknown;
  enc: (v: any) => PdfObject;
}

const SCOPES = ['Row', 'Column', 'Both'] as const;

export interface TableAttributes {
  rowSpan?: number;
  colSpan?: number;
  headers?: string[];
  scope?: 'Row' | 'Column' | 'Both';
  summary?: string;
}

const TABLE_FIELDS: Record<string, Field> = {
  rowSpan: { key: 'RowSpan', dec: decNum, enc: encNum },
  colSpan: { key: 'ColSpan', dec: decNum, enc: encNum },
  headers: { key: 'Headers', dec: decStrList, enc: encStrList },
  scope: { key: 'Scope', dec: decEnum(SCOPES), enc: encName },
  summary: { key: 'Summary', dec: decStr, enc: encStr },
};

// ---- owner collection + precedence ----
function ownerOf(doc: Document, d: PdfDict): string | undefined {
  const o = doc.resolve(d.get('O'));
  return isName(o) ? o.name : undefined;
}
/** Normalize an /A or ClassMap value into a list of attribute dicts (resolving,
 *  skipping integer revision numbers and non-dicts). */
function attrObjects(doc: Document, v: PdfObject | undefined): PdfDict[] {
  if (v === undefined) return [];
  const resolved = doc.resolve(v);
  const arr = isArray(resolved) ? resolved : [v];
  const out: PdfDict[] = [];
  for (const e of arr) { const d = doc.resolve(e); if (isDict(d)) out.push(d); }
  return out;
}
/** Normalize a /C value into a list of class-name strings. */
function classNames(doc: Document, v: PdfObject | undefined): string[] {
  if (v === undefined) return [];
  const resolved = doc.resolve(v);
  const arr = isArray(resolved) ? resolved : [v];
  const out: string[] = [];
  for (const e of arr) { const n = doc.resolve(e); if (isName(n)) out.push(n.name); }
  return out;
}
/** Candidate attribute dicts for `owner`, in precedence order: /A entries first
 *  (array order), then /C classes resolved through the root's /ClassMap. */
export function collectOwnerDicts(
  doc: Document, root: StructTreeRoot, elemDict: PdfDict, owner: string,
): PdfDict[] {
  const out: PdfDict[] = [];
  for (const d of attrObjects(doc, elemDict.get('A'))) if (ownerOf(doc, d) === owner) out.push(d);
  for (const cls of classNames(doc, elemDict.get('C'))) {
    for (const d of attrObjects(doc, root.ClassMap.get(cls))) if (ownerOf(doc, d) === owner) out.push(d);
  }
  return out;
}
/** First occurrence of `key` across the ordered dict list. */
export function readAttr(dicts: PdfDict[], key: string): PdfObject | undefined {
  for (const d of dicts) if (d.has(key)) return d.get(key);
  return undefined;
}

/** Decode all known fields of `fields` from the owner's dict list, or undefined
 *  when the list is empty. */
function readOwner<T>(
  doc: Document, root: StructTreeRoot, elemDict: PdfDict, owner: string, fields: Record<string, Field>,
): T | undefined {
  const dicts = collectOwnerDicts(doc, root, elemDict, owner);
  if (dicts.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, f] of Object.entries(fields)) {
    const raw = readAttr(dicts, f.key);
    if (raw === undefined) continue;
    const v = f.dec(doc, raw);
    if (v !== undefined) out[field] = v;
  }
  return out as T;
}

/** The element's own /A dict for `owner` (normalizing /A to an array, creating
 *  the dict if absent). */
export function ownerDictForWrite(doc: Document, elemDict: PdfDict, owner: string): PdfDict {
  const raw = elemDict.get('A');
  const resolved = doc.resolve(raw);
  let arr: PdfObject[];
  if (raw === undefined) { arr = []; elemDict.set('A', arr); }
  else if (isArray(resolved)) { arr = resolved; }
  else { arr = [raw]; elemDict.set('A', arr); }
  for (const e of arr) { const d = doc.resolve(e); if (isDict(d) && ownerOf(doc, d) === owner) return d; }
  const dict: PdfDict = new Map<string, PdfObject>([['O', name(owner)]]);
  arr.push(dict);
  return dict;
}

/** Merge a typed partial into the element's /A dict for `owner`: set each present
 *  field (undefined deletes the key). */
function writeOwner(
  doc: Document, elemDict: PdfDict, owner: string, fields: Record<string, Field>, attrs: Record<string, unknown>,
): void {
  const dict = ownerDictForWrite(doc, elemDict, owner);
  for (const [field, f] of Object.entries(fields)) {
    if (!(field in attrs)) continue;
    const v = attrs[field];
    if (v === undefined) dict.delete(f.key);
    else dict.set(f.key, f.enc(v));
  }
  doc.markModified();
}

// ---- Table owner ----
export function readTable(doc: Document, root: StructTreeRoot, elemDict: PdfDict): TableAttributes | undefined {
  const t = readOwner<TableAttributes>(doc, root, elemDict, 'Table', TABLE_FIELDS);
  if (t === undefined) return undefined;
  if (t.rowSpan === undefined) t.rowSpan = 1;
  if (t.colSpan === undefined) t.colSpan = 1;
  return t;
}
export function writeTable(doc: Document, elemDict: PdfDict, attrs: Partial<TableAttributes>): void {
  writeOwner(doc, elemDict, 'Table', TABLE_FIELDS, attrs as Record<string, unknown>);
}
```

- [ ] **Step 4: Add the Table getter/setter to `StructElement` in `src/struct.ts`**

Add to the `structattr.js` import (new import line near the top, after the `structwrite.js` import):

```ts
import {
  TableAttributes, readTable, writeTable,
} from './structattr.js';
```

Inside `class StructElement`, after `AddAnnotation` (the last method from S3):

```ts
  /** Interpreted /Table attributes (/A + /C merged), or undefined when none. */
  get TableAttributes(): TableAttributes | undefined {
    return readTable(this.doc, this.Root, this.Dict);
  }

  /** Merge table attributes into this element's /A (a field set to undefined
   *  deletes that key). */
  SetTableAttributes(attrs: Partial<TableAttributes>): void {
    writeTable(this.doc, this.Dict, attrs);
  }
```

- [ ] **Step 5: Export the types from `src/index.ts`**

After the `ElemOpts` export line, add:

```ts
export type { RGB, Edged, TableAttributes } from './structattr.js';
```

- [ ] **Step 6: Run the tests + typecheck**

Run: `npx vitest run test/struct-attr.test.ts`
Expected: PASS (5 tests).
Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/structattr.ts src/struct.ts src/index.ts test/struct-attr.test.ts
git commit -m "feat(struct): typed Table attribute read/write + core machinery (S4)"
```

---

## Task 2: List owner

**Files:**
- Modify: `src/structattr.ts` (add `ListAttributes`, `LIST_FIELDS`, `readList`/`writeList`)
- Modify: `src/struct.ts` (add `ListAttributes` getter + `SetListAttributes`)
- Modify: `src/index.ts` (export `ListAttributes`)
- Test: `test/struct-attr.test.ts`

**Interfaces:**
- Consumes: `readOwner`/`writeOwner` machinery, `decEnum`/`encName` (Task 1).
- Produces: `interface ListAttributes { listNumbering? }`, `readList(doc, root, elemDict)`, `writeList(doc, elemDict, attrs)`, `StructElement.get ListAttributes` + `SetListAttributes`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-attr.test.ts`:

```ts
describe('ListAttributes (read/write)', () => {
  it('round-trips ListNumbering', () => {
    const doc = Document.Open(buildStampTarget());
    const l = doc.CreateStructTree().Append('L');
    l.SetListAttributes({ listNumbering: 'Decimal' });
    const re = Document.Open(doc.Save());
    const rl = re.GetStructTree()!.Children[0];
    expect(rl.ListAttributes!.listNumbering).toBe('Decimal');
  });

  it('returns undefined when there is no /List owner', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    expect(p.ListAttributes).toBeUndefined();
  });

  it('ignores an out-of-enum ListNumbering value (lenient)', () => {
    const doc = Document.Open(buildStampTarget());
    const l = doc.CreateStructTree().Append('L');
    l.Dict.set('A', [new Map<string, any>([['O', name('List')], ['ListNumbering', name('Bogus')]])]);
    expect(l.ListAttributes!.listNumbering).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-attr.test.ts`
Expected: FAIL — `l.SetListAttributes is not a function`.

- [ ] **Step 3: Add List support to `src/structattr.ts`**

After the Table section:

```ts
// ---- List owner ----
const LIST_NUMBERING = [
  'None', 'Disc', 'Circle', 'Square',
  'Decimal', 'UpperRoman', 'LowerRoman', 'UpperAlpha', 'LowerAlpha',
] as const;

export interface ListAttributes {
  listNumbering?:
    | 'None' | 'Disc' | 'Circle' | 'Square'
    | 'Decimal' | 'UpperRoman' | 'LowerRoman' | 'UpperAlpha' | 'LowerAlpha';
}

const LIST_FIELDS: Record<string, Field> = {
  listNumbering: { key: 'ListNumbering', dec: decEnum(LIST_NUMBERING), enc: encName },
};

export function readList(doc: Document, root: StructTreeRoot, elemDict: PdfDict): ListAttributes | undefined {
  return readOwner<ListAttributes>(doc, root, elemDict, 'List', LIST_FIELDS);
}
export function writeList(doc: Document, elemDict: PdfDict, attrs: Partial<ListAttributes>): void {
  writeOwner(doc, elemDict, 'List', LIST_FIELDS, attrs as Record<string, unknown>);
}
```

- [ ] **Step 4: Add the List getter/setter to `StructElement` in `src/struct.ts`**

Widen the `structattr.js` import:

```ts
import {
  TableAttributes, ListAttributes, readTable, writeTable, readList, writeList,
} from './structattr.js';
```

After `SetTableAttributes`:

```ts
  /** Interpreted /List attributes, or undefined when none. */
  get ListAttributes(): ListAttributes | undefined {
    return readList(this.doc, this.Root, this.Dict);
  }

  /** Merge list attributes into this element's /A. */
  SetListAttributes(attrs: Partial<ListAttributes>): void {
    writeList(this.doc, this.Dict, attrs);
  }
```

- [ ] **Step 5: Export `ListAttributes` from `src/index.ts`**

```ts
export type { RGB, Edged, TableAttributes, ListAttributes } from './structattr.js';
```

(Replace the Task 1 export line with this widened one.)

- [ ] **Step 6: Run the tests + typecheck**

Run: `npx vitest run test/struct-attr.test.ts`
Expected: PASS (Task 1 + Task 2).
Run: `npx tsc -p tsconfig.json --noEmit` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/structattr.ts src/struct.ts src/index.ts test/struct-attr.test.ts
git commit -m "feat(struct): typed List attribute read/write (S4)"
```

---

## Task 3: Layout owner (full set)

**Files:**
- Modify: `src/structattr.ts` (add Layout codecs, `LayoutAttributes`, `BorderStyle`, `LAYOUT_FIELDS`, `readLayout`/`writeLayout`)
- Modify: `src/struct.ts` (add `LayoutAttributes` getter + `SetLayoutAttributes`)
- Modify: `src/index.ts` (export `LayoutAttributes`, `BorderStyle`)
- Test: `test/struct-attr.test.ts`

**Interfaces:**
- Consumes: the readOwner/writeOwner machinery + `decNum`/`decName`/`decEnum`/`encNum`/`encName` (Task 1).
- Produces: the Layout codecs (`decRgb`/`decEdgedRgb`/`decEdgedNum`/`decEdgedName`/`decNumOrName`/`decNumList`/`decBBox` + encoders), `type BorderStyle`, `interface LayoutAttributes`, `readLayout(doc, root, elemDict)`, `writeLayout(doc, elemDict, attrs)`, `StructElement.get LayoutAttributes` + `SetLayoutAttributes`.

- [ ] **Step 1: Write the failing test**

Append to `test/struct-attr.test.ts`:

```ts
describe('LayoutAttributes (read/write)', () => {
  it('round-trips scalar, enum, color, bbox, and number-or-name fields', () => {
    const doc = Document.Open(buildStampTarget());
    const fig = doc.CreateStructTree().Append('Figure');
    fig.SetLayoutAttributes({
      placement: 'Block',
      color: [1, 0, 0],
      spaceBefore: 6,
      bbox: [10, 20, 110, 220],
      width: 'Auto',
      lineHeight: 14,
      columnWidths: [100, 120],
    });
    const re = Document.Open(doc.Save());
    const a = re.GetStructTree()!.Children[0].LayoutAttributes!;
    expect(a.placement).toBe('Block');
    expect(a.color).toEqual([1, 0, 0]);
    expect(a.spaceBefore).toBe(6);
    expect(a.bbox).toEqual([10, 20, 110, 220]);
    expect(a.width).toBe('Auto');
    expect(a.lineHeight).toBe(14);
    expect(a.columnWidths).toEqual([100, 120]);
  });

  it('round-trips Edged values (scalar and per-edge)', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const a = root.Append('P');
    const b = root.Append('P');
    a.SetLayoutAttributes({ padding: 4, borderColor: [0, 0, 1] });
    b.SetLayoutAttributes({ padding: [1, 2, 3, 4], borderColor: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]] });
    const re = Document.Open(doc.Save());
    const ra = re.GetStructTree()!.Children[0].LayoutAttributes!;
    const rb = re.GetStructTree()!.Children[1].LayoutAttributes!;
    expect(ra.padding).toBe(4);
    expect(ra.borderColor).toEqual([0, 0, 1]);
    expect(rb.padding).toEqual([1, 2, 3, 4]);
    expect(rb.borderColor).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]]);
  });

  it('is lenient: a malformed field is omitted, siblings intact', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    p.Dict.set('A', [new Map<string, any>([
      ['O', name('Layout')],
      ['SpaceBefore', name('NotANumber')], // wrong type
      ['SpaceAfter', 8],
    ])]);
    const a = p.LayoutAttributes!;
    expect(a.spaceBefore).toBeUndefined();
    expect(a.spaceAfter).toBe(8);
  });

  it('returns undefined when there is no /Layout owner', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    expect(p.LayoutAttributes).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-attr.test.ts`
Expected: FAIL — `fig.SetLayoutAttributes is not a function`.

- [ ] **Step 3: Add Layout codecs to `src/structattr.ts`**

After the encoders from Task 1 (before the `Field` interface is fine, or grouped with the other codecs — placement is not critical):

```ts
// ---- Layout codecs ----
function decRgb(doc: Document, o: PdfObject): RGB | undefined {
  const v = doc.resolve(o);
  if (!isArray(v) || v.length !== 3) return undefined;
  const n = v.map((x) => doc.resolve(x));
  return n.every((x) => typeof x === 'number') ? [n[0] as number, n[1] as number, n[2] as number] : undefined;
}
function decBBox(doc: Document, o: PdfObject): [number, number, number, number] | undefined {
  const v = doc.resolve(o);
  if (!isArray(v) || v.length !== 4) return undefined;
  const n = v.map((x) => doc.resolve(x));
  return n.every((x) => typeof x === 'number')
    ? [n[0] as number, n[1] as number, n[2] as number, n[3] as number] : undefined;
}
function decEdgedNum(doc: Document, o: PdfObject): number | [number, number, number, number] | undefined {
  const v = doc.resolve(o);
  if (typeof v === 'number') return v;
  if (isArray(v) && v.length === 4) {
    const n = v.map((x) => doc.resolve(x));
    if (n.every((x) => typeof x === 'number'))
      return [n[0] as number, n[1] as number, n[2] as number, n[3] as number];
  }
  return undefined;
}
function decEdgedRgb(doc: Document, o: PdfObject): RGB | [RGB, RGB, RGB, RGB] | undefined {
  const v = doc.resolve(o);
  if (isArray(v) && v.length === 4 && v.every((e) => isArray(doc.resolve(e)))) {
    const edges = v.map((e) => decRgb(doc, e));
    if (edges.every((e) => e !== undefined)) return edges as [RGB, RGB, RGB, RGB];
  }
  return decRgb(doc, o);
}
function decEdgedName(values: readonly string[]) {
  return (doc: Document, o: PdfObject): string | string[] | undefined => {
    const v = doc.resolve(o);
    if (isName(v)) return values.includes(v.name) ? v.name : undefined;
    if (isArray(v) && v.length === 4) {
      const ns = v.map((e) => decName(doc, e));
      if (ns.every((x) => x !== undefined && values.includes(x))) return ns as string[];
    }
    return undefined;
  };
}
function decNumOrName(values: readonly string[]) {
  return (doc: Document, o: PdfObject): number | string | undefined => {
    const v = doc.resolve(o);
    if (typeof v === 'number') return v;
    if (isName(v) && values.includes(v.name)) return v.name;
    return undefined;
  };
}
function decNumList(doc: Document, o: PdfObject): number | number[] | undefined {
  const v = doc.resolve(o);
  if (typeof v === 'number') return v;
  if (isArray(v)) {
    const n = v.map((x) => doc.resolve(x)).filter((x): x is number => typeof x === 'number');
    return n;
  }
  return undefined;
}

function encRgb(v: RGB): PdfObject { return [v[0], v[1], v[2]]; }
function encBBox(v: [number, number, number, number]): PdfObject { return [v[0], v[1], v[2], v[3]]; }
function encNumOrArray(v: number | number[]): PdfObject { return Array.isArray(v) ? v.slice() : v; }
function encEdgedRgb(v: RGB | RGB[]): PdfObject {
  return Array.isArray(v[0]) ? (v as RGB[]).map((c) => [c[0], c[1], c[2]]) : [...(v as RGB)];
}
function encEdgedName(v: string | string[]): PdfObject {
  return Array.isArray(v) ? v.map((s) => name(s)) : name(v);
}
function encNumOrName(v: number | string): PdfObject {
  return typeof v === 'number' ? v : name(v);
}
```

- [ ] **Step 4: Add the `LayoutAttributes` type + field table + read/write to `src/structattr.ts`**

After the List section:

```ts
// ---- Layout owner ----
export type BorderStyle =
  | 'None' | 'Hidden' | 'Dotted' | 'Dashed' | 'Solid'
  | 'Double' | 'Groove' | 'Ridge' | 'Inset' | 'Outset';

const BORDER_STYLES = [
  'None', 'Hidden', 'Dotted', 'Dashed', 'Solid', 'Double', 'Groove', 'Ridge', 'Inset', 'Outset',
] as const;

export interface LayoutAttributes {
  placement?: 'Block' | 'Inline' | 'Before' | 'Start' | 'End';
  writingMode?: 'LrTb' | 'RlTb' | 'TbRl';
  backgroundColor?: RGB;
  borderColor?: Edged<RGB>;
  borderStyle?: Edged<BorderStyle>;
  borderThickness?: Edged<number>;
  color?: RGB;
  padding?: Edged<number>;
  spaceBefore?: number;
  spaceAfter?: number;
  startIndent?: number;
  endIndent?: number;
  textIndent?: number;
  textAlign?: 'Start' | 'Center' | 'End' | 'Justify';
  bbox?: [number, number, number, number];
  width?: number | 'Auto';
  height?: number | 'Auto';
  blockAlign?: 'Before' | 'Middle' | 'After' | 'Justify';
  inlineAlign?: 'Start' | 'Center' | 'End';
  tBorderStyle?: Edged<BorderStyle>;
  tPadding?: Edged<number>;
  lineHeight?: number | 'Normal' | 'Auto';
  baselineShift?: number;
  textDecorationType?: 'None' | 'Underline' | 'Overline' | 'LineThrough';
  textDecorationColor?: RGB;
  textDecorationThickness?: number;
  columnCount?: number;
  columnGap?: number | number[];
  columnWidths?: number | number[];
  glyphOrientationVertical?: 'Auto' | number;
  rubyAlign?: 'Start' | 'Center' | 'End' | 'Justify' | 'Distribute';
  rubyPosition?: 'Before' | 'After' | 'Warichu' | 'Inline';
}

const LAYOUT_FIELDS: Record<string, Field> = {
  placement: { key: 'Placement', dec: decEnum(['Block', 'Inline', 'Before', 'Start', 'End']), enc: encName },
  writingMode: { key: 'WritingMode', dec: decEnum(['LrTb', 'RlTb', 'TbRl']), enc: encName },
  backgroundColor: { key: 'BackgroundColor', dec: decRgb, enc: encRgb },
  borderColor: { key: 'BorderColor', dec: decEdgedRgb, enc: encEdgedRgb },
  borderStyle: { key: 'BorderStyle', dec: decEdgedName(BORDER_STYLES), enc: encEdgedName },
  borderThickness: { key: 'BorderThickness', dec: decEdgedNum, enc: encNumOrArray },
  color: { key: 'Color', dec: decRgb, enc: encRgb },
  padding: { key: 'Padding', dec: decEdgedNum, enc: encNumOrArray },
  spaceBefore: { key: 'SpaceBefore', dec: decNum, enc: encNum },
  spaceAfter: { key: 'SpaceAfter', dec: decNum, enc: encNum },
  startIndent: { key: 'StartIndent', dec: decNum, enc: encNum },
  endIndent: { key: 'EndIndent', dec: decNum, enc: encNum },
  textIndent: { key: 'TextIndent', dec: decNum, enc: encNum },
  textAlign: { key: 'TextAlign', dec: decEnum(['Start', 'Center', 'End', 'Justify']), enc: encName },
  bbox: { key: 'BBox', dec: decBBox, enc: encBBox },
  width: { key: 'Width', dec: decNumOrName(['Auto']), enc: encNumOrName },
  height: { key: 'Height', dec: decNumOrName(['Auto']), enc: encNumOrName },
  blockAlign: { key: 'BlockAlign', dec: decEnum(['Before', 'Middle', 'After', 'Justify']), enc: encName },
  inlineAlign: { key: 'InlineAlign', dec: decEnum(['Start', 'Center', 'End']), enc: encName },
  tBorderStyle: { key: 'TBorderStyle', dec: decEdgedName(BORDER_STYLES), enc: encEdgedName },
  tPadding: { key: 'TPadding', dec: decEdgedNum, enc: encNumOrArray },
  lineHeight: { key: 'LineHeight', dec: decNumOrName(['Normal', 'Auto']), enc: encNumOrName },
  baselineShift: { key: 'BaselineShift', dec: decNum, enc: encNum },
  textDecorationType: {
    key: 'TextDecorationType', dec: decEnum(['None', 'Underline', 'Overline', 'LineThrough']), enc: encName,
  },
  textDecorationColor: { key: 'TextDecorationColor', dec: decRgb, enc: encRgb },
  textDecorationThickness: { key: 'TextDecorationThickness', dec: decNum, enc: encNum },
  columnCount: { key: 'ColumnCount', dec: decNum, enc: encNum },
  columnGap: { key: 'ColumnGap', dec: decNumList, enc: encNumOrArray },
  columnWidths: { key: 'ColumnWidths', dec: decNumList, enc: encNumOrArray },
  glyphOrientationVertical: { key: 'GlyphOrientationVertical', dec: decNumOrName(['Auto']), enc: encNumOrName },
  rubyAlign: {
    key: 'RubyAlign', dec: decEnum(['Start', 'Center', 'End', 'Justify', 'Distribute']), enc: encName,
  },
  rubyPosition: { key: 'RubyPosition', dec: decEnum(['Before', 'After', 'Warichu', 'Inline']), enc: encName },
};

export function readLayout(doc: Document, root: StructTreeRoot, elemDict: PdfDict): LayoutAttributes | undefined {
  return readOwner<LayoutAttributes>(doc, root, elemDict, 'Layout', LAYOUT_FIELDS);
}
export function writeLayout(doc: Document, elemDict: PdfDict, attrs: Partial<LayoutAttributes>): void {
  writeOwner(doc, elemDict, 'Layout', LAYOUT_FIELDS, attrs as Record<string, unknown>);
}
```

- [ ] **Step 5: Add the Layout getter/setter to `StructElement` in `src/struct.ts`**

Widen the `structattr.js` import:

```ts
import {
  TableAttributes, ListAttributes, LayoutAttributes,
  readTable, writeTable, readList, writeList, readLayout, writeLayout,
} from './structattr.js';
```

After `SetListAttributes`:

```ts
  /** Interpreted /Layout attributes, or undefined when none. */
  get LayoutAttributes(): LayoutAttributes | undefined {
    return readLayout(this.doc, this.Root, this.Dict);
  }

  /** Merge layout attributes into this element's /A. */
  SetLayoutAttributes(attrs: Partial<LayoutAttributes>): void {
    writeLayout(this.doc, this.Dict, attrs);
  }
```

- [ ] **Step 6: Export `LayoutAttributes` + `BorderStyle` from `src/index.ts`**

```ts
export type {
  RGB, Edged, TableAttributes, ListAttributes, LayoutAttributes, BorderStyle,
} from './structattr.js';
```

(Replace the Task 2 export line with this widened one.)

- [ ] **Step 7: Run the tests + typecheck**

Run: `npx vitest run test/struct-attr.test.ts`
Expected: PASS (all groups).
Run: `npx tsc -p tsconfig.json --noEmit` — clean.

- [ ] **Step 8: Commit**

```bash
git add src/structattr.ts src/struct.ts src/index.ts test/struct-attr.test.ts
git commit -m "feat(struct): typed full Layout attribute read/write (S4)"
```

---

## Task 4: Docs, full suite, and close

**Files:**
- Modify: `README.md`
- Test: full suite

- [ ] **Step 1: Update `README.md`**

In the Features list, after the "Tagged-PDF structure authoring" bullet, add:

```markdown
- **Tagged-PDF attribute semantics** — `StructElement.TableAttributes` / `ListAttributes` / `LayoutAttributes` interpret the `/A` + `/C` attribute dictionaries (resolving `/ClassMap` classes, `/A`-over-`/C` precedence) into typed views: table (`rowSpan`/`colSpan`/`headers`/`scope`/`summary`), list (`listNumbering`), and the full Layout owner (placement, writing mode, colors, borders, padding, indents, alignment, BBox, columns, ruby, …). `SetTableAttributes` / `SetListAttributes` / `SetLayoutAttributes` author them with typed partials (merged into `/A`; a field set to `undefined` deletes it).
```

In Limitations, update the tagged-PDF entry to note interpreted owners. Replace:

```markdown
- **Tagged-PDF authoring tags what you author** — `CreateStructTree` and the `tag` / `AddAnnotation` / `NextMcid` APIs build a structure tree and tag content you add, but there is no auto-tagging of pre-existing untagged content, no interpretation of table/list layout attributes, and no PDF/UA conformance validation. Authoring into a `/ParentTree` that uses an intermediate `/Kids` number tree (some large imported tagged PDFs) throws `UnsupportedFeatureError` — trees built by `CreateStructTree` use a flat `/Nums`. A page copied multiple times in a single `ExtractPages` call carries structure only on its first occurrence.
```

with:

```markdown
- **Tagged-PDF authoring tags what you author** — `CreateStructTree` and the `tag` / `AddAnnotation` / `NextMcid` APIs build a structure tree and tag content you add, but there is no auto-tagging of pre-existing untagged content and no PDF/UA conformance validation. Typed attribute interpretation covers the Table, List, and Layout owners; other owners (`/PrintField`, `/Artifact`, `/XML`/`/HTML`/`/CSS`, …) remain available only through the raw `Attributes` passthrough. Authoring into a `/ParentTree` that uses an intermediate `/Kids` number tree (some large imported tagged PDFs) throws `UnsupportedFeatureError` — trees built by `CreateStructTree` use a flat `/Nums`. A page copied multiple times in a single `ExtractPages` call carries structure only on its first occurrence.
```

- [ ] **Step 2: Run the full quality gates**

Run: `npm run typecheck`
Expected: clean.
Run: `npm test`
Expected: all green (existing suite + `test/struct-attr.test.ts`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: tagged-PDF attribute semantics (S4)"
```

- [ ] **Step 4: Close the beads issue**

```bash
bd close aspose-pdf-foss-for-ts-pjx.4
```

Then follow the CLAUDE.md session-completion workflow (file follow-ups, finishing-a-development-branch, push).

---

## Self-Review

**Spec coverage:**

- *Typed read getters (Table/List/Layout)* → Tasks 1/2/3. ✅
- *Typed partial-object setters merging into /A* → `writeOwner` + `ownerDictForWrite` (Task 1), used by all three owners. ✅
- *PDF precedence (/A over /C, ClassMap resolution, skip revision integers)* → `collectOwnerDicts` + `attrObjects`/`classNames` + `readAttr` (Task 1), tested in Task 1. ✅
- *Value codecs (enum, number, RGB, Edged, number-or-name, bbox, headers, num-or-list)* → Task 1 (table subset) + Task 3 (layout set). ✅
- *Defaults rowSpan/colSpan = 1 on read; writers don't elide* → `readTable` (Task 1), tested. ✅
- *Lenient malformed handling (field omitted, siblings intact)* → `readOwner` skips `undefined` decode results; tested in Task 2 (list enum) and Task 3 (layout). ✅
- *undefined deletes a key* → `writeOwner`; tested Task 1. ✅
- *Writer merges into an existing owner /A dict (keys preserved)* → `ownerDictForWrite` finds the existing dict; covered by the Task 1 delete test (two SetTableAttributes calls hit the same dict) and Task 3 Edged test (two fields). ✅
- *Edge: multiple /A dicts same owner; /C name missing from ClassMap* → `collectOwnerDicts`/`ownerDictForWrite` handle; the missing-class path is exercised implicitly (classNames yields nothing when ClassMap lacks the key). ✅
- *Serialization unchanged; types exported; README* → no serializer task; Task 1/2/3 exports; Task 4 README. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows complete code. ✅

**Type consistency:** `readTable`/`writeTable`/`readList`/`writeList`/`readLayout`/`writeLayout`, `collectOwnerDicts(doc, root, elemDict, owner)`, `ownerDictForWrite(doc, elemDict, owner)`, `Field { key, dec, enc }`, and the `RGB`/`Edged`/`BorderStyle`/`*Attributes` types are referenced identically across `structattr.ts`, `struct.ts`, and `index.ts`. The `index.ts` export line is widened (not duplicated) in Tasks 2 and 3. ✅

**Note for the implementer:** the `index.ts` export of the attribute types is a single line that Task 2 and Task 3 each *replace* (widen) — do not add a second export line.
