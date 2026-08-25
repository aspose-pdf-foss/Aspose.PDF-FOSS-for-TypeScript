# Collection / Portfolio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read/write support for PDF portfolios — the `/Root /Collection` presentation layer (schema, view, sort, initial document) over embedded files, plus per-file custom field values.

**Architecture:** A new `src/collection.ts` builds/reads the `/Collection` catalog dict. The existing `Attachment` read view is promoted to a live handle **class** (over `(doc, filespecDict)`) that gains `GetField`/`SetField`/`RemoveField` for the per-file `/CI` (CollectionItem); `AddAttachment` now returns it. `document.ts` gains `GetCollection`/`SetCollection`/`RemoveCollection`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest. Zero new runtime dependencies — only `node:` built-ins already in use.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — all relative imports carry the `.js` extension.
- **TDD** — every task writes a failing test first, then minimal code to pass.
- **No module cycle** — `document.ts` imports both `embeddedfile.ts` and `collection.ts`; neither of those imports the other.
- **`/Collection` is written as a single nested direct dict** (schema/fields/sort inline, like `/Params`), allocated as one indirect object by `SetCollection`.
- **Run `npm run typecheck` and `npx vitest run test/embedded-files.test.ts test/portfolio.test.ts` green before completing each task; full `npm test` green before the final task closes.**

Spec: `docs/superpowers/specs/2026-06-26-collection-portfolio-design.md`

## File Structure

- **Modify** `src/embeddedfile.ts` — replace the `Attachment` interface + object-literal builder with an `Attachment` class; add `encodeFieldValue` helper; `readFilespec` returns `new Attachment(...)`.
- **Modify** `src/document.ts` — `AddAttachment` returns `Attachment`; add `GetCollection`/`SetCollection`/`RemoveCollection`.
- **Create** `src/collection.ts` — `CollectionView`/`CollectionFieldType`/`CollectionFieldDef`/`CollectionSettings` types; `buildCollection`; `readCollection`.
- **Modify** `src/index.ts` — export `Attachment` as a value; export the collection types.
- **Modify** `test/embedded-files.test.ts` — add `/CI` field + AddAttachment-handle tests (existing tests unchanged).
- **Create** `test/portfolio.test.ts` — collection round-trip and validation tests.
- **Modify** `README.md` — Features + portfolio usage + API table.

---

### Task 1: `Attachment` handle class + per-file `/CI` fields

**Files:**
- Modify: `src/embeddedfile.ts` (replace lines 66-122: the `Attachment` interface, `readFilespec`)
- Modify: `src/document.ts` (`AddAttachment`, ~line 639)
- Test: `test/embedded-files.test.ts`

**Interfaces:**
- Consumes: `filespecName`, `readFilespecBytes` (existing); `Document.resolve`/`markModified`/`allocObject`/`catalog`; `isDict`, `isName`, `isString`, `name`, `PdfStream` from `./types.js`; `encodePdfText`, `decodePdfText`, `formatPdfDate`, `parsePdfDate` from `./metadata.js`.
- Produces:
  - `class Attachment` with `Dict: PdfDict`, getters `Name`/`Description`/`MimeType`/`Size`/`CreationDate`/`ModDate`, `GetBytes()`, `GetField(field)`, `SetField(field, value)`, `RemoveField(field)`.
  - `readFilespec(doc, fsObj, fallbackName?)` returns `Attachment | undefined`.
  - `Document.AddAttachment(...)` returns `Attachment`.

- [ ] **Step 1: Write the failing test**

Append to `test/embedded-files.test.ts`:

```typescript
describe('Attachment /CI custom fields', () => {
  const bytes = new TextEncoder().encode('field payload');

  it('AddAttachment returns a handle whose fields round-trip', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('data.bin', bytes, {});
    att.SetField('reviewer', 'Alice');
    att.SetField('revision', 3);
    const when = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    att.SetField('approved', when);

    const re = Document.Open(doc.Save());
    const got = re.GetAttachments()[0];
    expect(got.GetField('reviewer')).toBe('Alice');
    expect(got.GetField('revision')).toBe(3);
    const d = got.GetField('approved');
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).getTime()).toBe(when.getTime());
  });

  it('RemoveField drops the value and empty /CI', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('r.bin', bytes, {});
    att.SetField('only', 'x');
    att.RemoveField('only');
    const re = Document.Open(doc.Save());
    expect(re.GetAttachments()[0].GetField('only')).toBeUndefined();
  });

  it('SetField rejects unsupported value types and empty names', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('v.bin', bytes, {});
    expect(() => att.SetField('', 'x')).toThrow(RangeError);
    expect(() => att.SetField('k', {} as any)).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/embedded-files.test.ts`
Expected: FAIL — `doc.AddAttachment(...)` returns `void`; `.SetField` is not a function.

- [ ] **Step 3a: Replace the `Attachment` interface + `readFilespec` in `src/embeddedfile.ts`**

Replace the block from `/** Metadata view over one embedded file; GetBytes inflates on demand. */`
through the end of `readFilespec` (the current lines 66-122) with:

```typescript
/** Encode a /CI field value: string→PDF string, number→PDF number,
 *  Date→PDF date string. Throws on anything else. */
function encodeFieldValue(value: string | number | Date): PdfObject {
  if (value instanceof Date) return { kind: 'string', bytes: encodePdfText(formatPdfDate(value)) };
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return { kind: 'string', bytes: encodePdfText(value) };
  throw new TypeError('field value must be a string, number, or Date');
}

/** A live handle over one embedded file's /Filespec. Read accessors and
 *  GetBytes decode on demand; GetField/SetField manage the per-file /CI
 *  (CollectionItem) custom field values used by a /Collection portfolio. */
export class Attachment {
  constructor(
    private readonly doc: Document,
    /** The live /Filespec dict from the objects map. */
    readonly Dict: PdfDict,
    /** Name-tree key used when the filespec carries no /F or /UF. */
    private readonly fallbackName: string = '',
  ) {}

  get Name(): string { return filespecName(this.doc, this.Dict) || this.fallbackName; }

  get Description(): string | undefined {
    const d = this.Dict.get('Desc');
    return isString(d) ? decodePdfText(d.bytes) : undefined;
  }

  private embeddedStream(): PdfStream | undefined {
    const ef = this.doc.resolve(this.Dict.get('EF'));
    if (!isDict(ef)) return undefined;
    const s = this.doc.resolve(ef.get('F') ?? ef.get('UF'));
    return isStream(s) ? s : undefined;
  }

  get MimeType(): string | undefined {
    const sub = this.embeddedStream()?.dict.get('Subtype');
    return isName(sub) ? sub.name : undefined;
  }

  private params(): PdfDict | undefined {
    const s = this.embeddedStream();
    const p = s ? this.doc.resolve(s.dict.get('Params')) : undefined;
    return isDict(p) ? p : undefined;
  }

  get Size(): number | undefined {
    const v = this.params()?.get('Size');
    return typeof v === 'number' ? v : undefined;
  }

  get CreationDate(): Date | undefined { return this.paramDate('CreationDate'); }
  get ModDate(): Date | undefined { return this.paramDate('ModDate'); }

  private paramDate(key: string): Date | undefined {
    const v = this.params()?.get(key);
    if (isString(v)) { const d = parsePdfDate(decodePdfText(v.bytes)); if (d instanceof Date) return d; }
    return undefined;
  }

  /** Decode the embedded bytes, inflating FlateDecode if present. */
  GetBytes(): Uint8Array { return readFilespecBytes(this.doc, this.Dict); }

  /** Read a custom /CI field. number→number; a /CollectionSubitem is unwrapped
   *  to its /D; a string is returned as a Date when it parses as a PDF date,
   *  otherwise as the raw string. */
  GetField(field: string): string | number | Date | undefined {
    const ci = this.doc.resolve(this.Dict.get('CI'));
    if (!isDict(ci)) return undefined;
    let v = this.doc.resolve(ci.get(field));
    if (isDict(v)) v = this.doc.resolve(v.get('D')); // /CollectionSubitem
    if (typeof v === 'number') return v;
    if (isString(v)) { const d = parsePdfDate(decodePdfText(v.bytes)); return d instanceof Date ? d : decodePdfText(v.bytes); }
    return undefined;
  }

  /** Upsert a custom /CI field value. */
  SetField(field: string, value: string | number | Date): void {
    if (typeof field !== 'string' || field === '') throw new RangeError('field name must be a non-empty string');
    const encoded = encodeFieldValue(value); // validate before mutating
    let ci = this.doc.resolve(this.Dict.get('CI'));
    if (!isDict(ci)) { ci = new Map<string, PdfObject>([['Type', name('CollectionItem')]]); this.Dict.set('CI', ci); }
    ci.set(field, encoded);
    this.doc.markModified();
  }

  /** Remove a custom /CI field value, dropping /CI when only /Type remains. */
  RemoveField(field: string): void {
    const ci = this.doc.resolve(this.Dict.get('CI'));
    if (!isDict(ci)) return;
    if (ci.delete(field) && [...ci.keys()].every((k) => k === 'Type')) this.Dict.delete('CI');
    this.doc.markModified();
  }
}

/** Wrap a /Filespec in an Attachment handle, or undefined when not a dict. */
export function readFilespec(doc: Document, fsObj: PdfObject, fallbackName = ''): Attachment | undefined {
  const fs = doc.resolve(fsObj);
  if (!isDict(fs)) return undefined;
  return new Attachment(doc, fs, fallbackName);
}
```

Then update `readAttachments` (just below) to pass the tree key as the fallback name. Replace its loop body:

```typescript
  for (const [key, v] of collected) {
    const att = readFilespec(doc, v, key);
    if (att) out.push(att);
  }
```

(The old `if (!att.Name) att.Name = key;` line is removed — the class computes Name with the fallback.)

- [ ] **Step 3b: `AddAttachment` returns the handle**

In `src/document.ts`, change `AddAttachment` to:

```typescript
  /** Embed `bytes` as an attachment named `name`, upserting it into the
   *  /Names /EmbeddedFiles name tree (overwriting a same-named entry). Returns
   *  a live handle for reading bytes and setting /CI custom fields. */
  AddAttachment(name: string, bytes: Uint8Array, opts: AttachmentOptions = {}): Attachment {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('attachment bytes must be a Uint8Array');
    const fs = buildFilespec(bytes, name, opts, (o) => this.allocObject(o));
    upsertEmbeddedFile(this, name, this.allocObject(fs));
    return new Attachment(this, fs);
  }
```

(`Attachment` is already imported from `./embeddedfile.js` in document.ts; it is now a class value rather than a type, which the existing mixed import handles.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/embedded-files.test.ts` then `npm run typecheck`
Expected: PASS (all prior embedded-files tests plus the 3 new ones); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/embeddedfile.ts src/document.ts test/embedded-files.test.ts
git commit -m "feat(portfolio): Attachment handle class with /CI custom fields"
```

---

### Task 2: `/Collection` catalog dict + Document API

**Files:**
- Create: `src/collection.ts`
- Modify: `src/document.ts` (import + three methods, after `RemoveAttachment`)
- Create: `test/portfolio.test.ts`

**Interfaces:**
- Consumes: `name`, `isArray`, `isDict`, `isName`, `isString`, `PdfDict`, `PdfObject` from `./types.js`; `encodePdfText`, `decodePdfText` from `./metadata.js`; `Document` (type only).
- Produces:
  - `type CollectionView`, `type CollectionFieldType`, `interface CollectionFieldDef`, `interface CollectionSettings`.
  - `function buildCollection(settings: CollectionSettings): PdfDict` (validates, then builds a nested direct dict).
  - `function readCollection(doc: Document): CollectionSettings | undefined`.
  - `Document.GetCollection()` / `SetCollection(settings)` / `RemoveCollection()`.

- [ ] **Step 1: Write the failing test**

Create `test/portfolio.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-annot-target.js';
import { isDict } from '../src/types.js';
import type { CollectionSettings } from '../src/collection.js';

const settings: CollectionSettings = {
  fields: [
    { name: 'name', type: 'filename', displayName: 'Name', order: 0 },
    { name: 'reviewer', type: 'string', displayName: 'Reviewer', order: 1, editable: true },
    { name: 'revision', type: 'number', displayName: 'Rev', order: 2, visible: false },
  ],
  view: 'tile',
  sortBy: 'reviewer',
  sortAscending: false,
  initialFile: 'a.txt',
};

describe('Document collection (portfolio)', () => {
  it('round-trips SetCollection through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('a.txt', new TextEncoder().encode('A'), {});
    doc.SetCollection(settings);
    const re = Document.Open(doc.Save());
    const got = re.GetCollection()!;
    expect(got.view).toBe('tile');
    expect(got.sortBy).toBe('reviewer');
    expect(got.sortAscending).toBe(false);
    expect(got.initialFile).toBe('a.txt');
    expect(got.fields.map((f) => [f.name, f.type, f.displayName])).toEqual([
      ['name', 'filename', 'Name'],
      ['reviewer', 'string', 'Reviewer'],
      ['revision', 'number', 'Rev'],
    ]);
    expect(got.fields[1].editable).toBe(true);
    expect(got.fields[2].visible).toBe(false);
  });

  it('GetCollection is undefined without a /Collection', () => {
    const doc = Document.Open(buildBlankPage());
    expect(doc.GetCollection()).toBeUndefined();
  });

  it('RemoveCollection reports presence and drops the dict', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetCollection({ fields: [{ name: 'name', type: 'filename', displayName: 'Name' }] });
    expect(doc.RemoveCollection()).toBe(true);
    expect(doc.RemoveCollection()).toBe(false);
    expect(Document.Open(doc.Save()).GetCollection()).toBeUndefined();
  });

  it('built-in-only schema writes no /CI on filespecs', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('a.txt', new TextEncoder().encode('A'), {});
    doc.SetCollection({ fields: [{ name: 'name', type: 'filename', displayName: 'Name' }] });
    expect(isDict(att.Dict.get('CI'))).toBe(false);
  });

  it('validates field type, sortBy, and field names', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => doc.SetCollection({ fields: [{ name: 'x', type: 'bogus' as any, displayName: 'X' }] })).toThrow(TypeError);
    expect(() => doc.SetCollection({ fields: [{ name: '', type: 'string', displayName: 'X' }] })).toThrow(TypeError);
    expect(() => doc.SetCollection({
      fields: [{ name: 'x', type: 'string', displayName: 'X' }], sortBy: 'missing',
    })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/portfolio.test.ts`
Expected: FAIL — cannot resolve `../src/collection.js`.

- [ ] **Step 3a: Create `src/collection.ts`**

```typescript
import { PdfDict, PdfObject, name, isArray, isDict, isName, isString } from './types.js';
import { encodePdfText, decodePdfText } from './metadata.js';
import type { Document } from './document.js';

/** How a viewer presents the portfolio. */
export type CollectionView = 'details' | 'tile' | 'hidden';

/** A schema column: built-in fields derive from the filespec; custom fields
 *  (string/date/number) read their value from each file's /CI. */
export type CollectionFieldType =
  | 'filename' | 'description' | 'size' | 'compressedSize' | 'creationDate' | 'modDate'
  | 'string' | 'date' | 'number';

export interface CollectionFieldDef {
  /** Schema key (and /CI key for custom fields). */
  name: string;
  type: CollectionFieldType;
  /** Column header (/N). */
  displayName: string;
  /** Column order (/O). */
  order?: number;
  /** Column visible (/V). Default true. */
  visible?: boolean;
  /** Value editable in a viewer (/E). Default false. */
  editable?: boolean;
}

export interface CollectionSettings {
  fields: CollectionFieldDef[];
  /** Default 'details'. */
  view?: CollectionView;
  /** Field name to sort on. */
  sortBy?: string;
  /** Default true. */
  sortAscending?: boolean;
  /** Name of the file shown first (/D). */
  initialFile?: string;
}

const TYPE_TO_SUBTYPE: Record<CollectionFieldType, string> = {
  filename: 'F', description: 'Desc', size: 'Size', compressedSize: 'CompressedSize',
  creationDate: 'CreationDate', modDate: 'ModDate', string: 'S', date: 'D', number: 'N',
};
const SUBTYPE_TO_TYPE: Record<string, CollectionFieldType> = {
  F: 'filename', Desc: 'description', Size: 'size', CompressedSize: 'compressedSize',
  CreationDate: 'creationDate', ModDate: 'modDate', S: 'string', D: 'date', N: 'number',
};
const VIEW_TO_NAME: Record<CollectionView, string> = { details: 'D', tile: 'T', hidden: 'H' };
const NAME_TO_VIEW: Record<string, CollectionView> = { D: 'details', T: 'tile', H: 'hidden' };

const pdfStr = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** Build the /Collection dict as one nested direct dict. Validates first so a
 *  bad `settings` throws before any document mutation. */
export function buildCollection(settings: CollectionSettings): PdfDict {
  const known = new Set<string>();
  for (const f of settings.fields) {
    if (typeof f.name !== 'string' || f.name === '') throw new TypeError('collection field name must be a non-empty string');
    if (typeof f.displayName !== 'string' || f.displayName === '') throw new TypeError('collection field displayName must be a non-empty string');
    if (!(f.type in TYPE_TO_SUBTYPE)) throw new TypeError(`unknown collection field type: ${f.type}`);
    known.add(f.name);
  }
  if (settings.sortBy !== undefined && !known.has(settings.sortBy)) throw new RangeError(`sortBy references unknown field: ${settings.sortBy}`);
  if (settings.initialFile !== undefined && settings.initialFile === '') throw new RangeError('initialFile must be a non-empty string');

  const col: PdfDict = new Map<string, PdfObject>();
  col.set('Type', name('Collection'));
  col.set('View', name(VIEW_TO_NAME[settings.view ?? 'details']));

  const schema: PdfDict = new Map<string, PdfObject>();
  schema.set('Type', name('CollectionSchema'));
  for (const f of settings.fields) {
    const field: PdfDict = new Map<string, PdfObject>();
    field.set('Type', name('CollectionField'));
    field.set('Subtype', name(TYPE_TO_SUBTYPE[f.type]));
    field.set('N', pdfStr(f.displayName));
    if (f.order !== undefined) field.set('O', f.order);
    field.set('V', f.visible ?? true);
    field.set('E', f.editable ?? false);
    schema.set(f.name, field);
  }
  col.set('Schema', schema);

  if (settings.sortBy !== undefined) {
    const sort: PdfDict = new Map<string, PdfObject>();
    sort.set('Type', name('CollectionSort'));
    sort.set('S', name(settings.sortBy));
    sort.set('A', settings.sortAscending ?? true);
    col.set('Sort', sort);
  }
  if (settings.initialFile !== undefined) col.set('D', pdfStr(settings.initialFile));
  return col;
}

/** Read /Root /Collection into CollectionSettings, or undefined when absent. */
export function readCollection(doc: Document): CollectionSettings | undefined {
  const col = doc.resolve(doc.catalog().get('Collection'));
  if (!isDict(col)) return undefined;

  const viewName = col.get('View');
  const view: CollectionView = isName(viewName) && NAME_TO_VIEW[viewName.name] ? NAME_TO_VIEW[viewName.name] : 'details';

  const fields: CollectionFieldDef[] = [];
  const schema = doc.resolve(col.get('Schema'));
  if (isDict(schema)) {
    for (const [key, raw] of schema) {
      if (key === 'Type') continue;
      const fd = doc.resolve(raw);
      if (!isDict(fd)) continue;
      const sub = fd.get('Subtype');
      const type = isName(sub) && SUBTYPE_TO_TYPE[sub.name] ? SUBTYPE_TO_TYPE[sub.name] : 'string';
      const n = fd.get('N');
      const def: CollectionFieldDef = { name: key, type, displayName: isString(n) ? decodePdfText(n.bytes) : key };
      const o = doc.resolve(fd.get('O'));
      if (typeof o === 'number') def.order = o;
      const v = fd.get('V'); if (typeof v === 'boolean') def.visible = v;
      const e = fd.get('E'); if (typeof e === 'boolean') def.editable = e;
      fields.push(def);
    }
  }
  fields.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const settings: CollectionSettings = { fields, view };
  const sort = doc.resolve(col.get('Sort'));
  if (isDict(sort)) {
    const s = sort.get('S');
    if (isName(s)) settings.sortBy = s.name;
    else if (isArray(s)) { const s0 = doc.resolve(s[0]); if (isName(s0)) settings.sortBy = s0.name; }
    const a = sort.get('A');
    settings.sortAscending = typeof a === 'boolean' ? a : (isArray(a) && typeof a[0] === 'boolean' ? a[0] : true);
  }
  const d = col.get('D');
  if (isString(d)) settings.initialFile = decodePdfText(d.bytes);
  return settings;
}
```

- [ ] **Step 3b: Add the Document methods**

In `src/document.ts`, add the import after the `./embeddedfile.js` import block:

```typescript
import {
  CollectionSettings, buildCollection, readCollection,
} from './collection.js';
```

Insert after `RemoveAttachment`:

```typescript
  /** The /Root /Collection portfolio presentation settings, or undefined. */
  GetCollection(): CollectionSettings | undefined {
    return readCollection(this);
  }

  /** Write (or replace) the /Root /Collection portfolio settings. Throws on an
   *  invalid schema before mutating the document. */
  SetCollection(settings: CollectionSettings): void {
    const col = buildCollection(settings); // validates first
    this.catalog().set('Collection', this.allocObject(col));
    this.markModified();
  }

  /** Remove /Root /Collection. Returns false when none was present. */
  RemoveCollection(): boolean {
    const catalog = this.catalog();
    if (catalog.get('Collection') === undefined) return false;
    catalog.delete('Collection');
    this.markModified();
    return true;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/portfolio.test.ts test/embedded-files.test.ts` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/collection.ts src/document.ts test/portfolio.test.ts
git commit -m "feat(portfolio): /Collection schema/view/sort + Document API"
```

---

### Task 3: Public exports + README + full suite

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything produced above.
- Produces: public exports for `Attachment` (value), `CollectionSettings`, `CollectionFieldDef`, `CollectionFieldType`, `CollectionView`.

- [ ] **Step 1: Update the exports**

In `src/index.ts`, replace the current line
`export type { Attachment, AttachmentOptions } from './embeddedfile.js';`
with:

```typescript
export { Attachment } from './embeddedfile.js';
export type { AttachmentOptions } from './embeddedfile.js';
export type { CollectionSettings, CollectionFieldDef, CollectionFieldType, CollectionView } from './collection.js';
```

- [ ] **Step 2: Verify exports compile**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Update README**

In `README.md`, update the embedded-files Features bullet to mention portfolios, and add an API-overview snippet. Add this after the existing "Embedded files / attachments" feature bullet:

```markdown
- **Portfolios (collections)** — `SetCollection` / `GetCollection` /
  `RemoveCollection` author the `/Root /Collection` presentation layer over the
  attachments: a column schema (built-in `filename` / `size` / dates plus custom
  `string` / `date` / `number` fields), view mode (`details` / `tile` /
  `hidden`), sort field, and initial document. Per-file custom values are set on
  the attachment handle via `Attachment.SetField(name, value)`.
```

Add a usage snippet in the "Embedded files / attachments" section:

```typescript
// Turn attachments into a portfolio with custom columns.
const a = doc.AddAttachment('q2.csv', bytes, { mimeType: 'text/csv' });
a.SetField('reviewer', 'Alice');
a.SetField('approved', new Date());
doc.SetCollection({
  fields: [
    { name: 'name', type: 'filename', displayName: 'File', order: 0 },
    { name: 'reviewer', type: 'string', displayName: 'Reviewer', order: 1 },
    { name: 'approved', type: 'date', displayName: 'Approved', order: 2 },
  ],
  view: 'details',
  sortBy: 'approved',
});
```

In the API-overview table, add rows alongside the attachment row:

```markdown
| `doc.GetCollection()` / `doc.SetCollection(settings)` / `doc.RemoveCollection()` | Read / write / remove the `/Collection` portfolio (schema, view, sort, initial file) |
| `attachment.GetField(name)` / `attachment.SetField(name, value)` / `attachment.RemoveField(name)` | Per-file portfolio custom field values (`/CI`); value is `string \| number \| Date` |
```

Match the README's existing prose style and table formatting.

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full vitest suite green (no regressions; `test/embedded-files.test.ts` still passes after the Attachment class refactor).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat(portfolio): export collection API and document in README"
```

---

## Notes for the implementer

- **Confirmed APIs** — `Document.resolve`, `Document.catalog()`, `Document.allocObject`, `Document.markModified()` are all used cross-module today (e.g. `embeddedfile.ts`, `annotation.ts`); use them as-is. `buildBlankPage` is in `test/helpers/build-annot-target.ts`.
- **No `/Length` / serializer work** — `/Collection` is plain dicts; the existing serializer handles nested direct dicts and renumbers the one indirect object `SetCollection` allocates.
- **Mark-sweep retention** — `/Root /Collection` is reachable from the catalog, and each filespec's `/CI` hangs off a filespec already retained via `/Names /EmbeddedFiles`; both survive `Save()` with no extra handling.
- **Name collision** — in `embeddedfile.ts`, `name` (from `./types.js`) is already imported; the `Attachment.SetField` parameter is deliberately named `field` (not `name`) to avoid shadowing it.
- **`Attachment` is now a value export** — `document.ts` already imports it from `./embeddedfile.js`; once it is a class the same import yields the constructor. Only `index.ts` needs the `export type` → `export` change.
