# Embedded Files / Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read/write support for embedded files — document-level attachments (`/Names /EmbeddedFiles` tree) and `FileAttachment` annotations — to the library.

**Architecture:** A new `src/embeddedfile.ts` module owns all `/Filespec` ↔ `/EmbeddedFile` plumbing (build, read, name-tree upsert/remove, `/AF` maintenance). `document.ts` and `annotation.ts`/`page.ts` are thin delegators, mirroring how `outline.ts` backs the named-destination API and `annotation.ts` backs the annotation API. The name tree reuses `collectNameTree`/`flatNameNode` from `outline.ts`; mark-sweep save retains any filespec reachable from `/Root /Names` or a page `/Annots`, so no serializer change is needed.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, `node:zlib` (`deflateSync`) for compression, `node:crypto` (via the existing `md5` helper) for the checksum. Zero new runtime dependencies.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — all relative imports carry the `.js` extension.
- **TDD** — every task writes a failing test first, then minimal code to pass.
- **MD5 `/CheckSum` is computed over the UNCOMPRESSED bytes** (deliberate; see spec).
- **Upsert-on-duplicate-name** — `AddAttachment` with an existing name overwrites, matching `SetNamedDestination`.
- **Run `npm run typecheck` and `npx vitest run test/embedded-files.test.ts` green before completing each task; full `npm test` green before the final task closes.**

Spec: `docs/superpowers/specs/2026-06-26-embedded-files-attachments-design.md`

## File Structure

- **Create** `src/embeddedfile.ts` — the `AttachmentOptions`/`Attachment` types and all filespec logic: `buildFilespec`, `readFilespec`, `readFilespecBytes`, `readAttachments`, `filespecName`, `upsertEmbeddedFile`, `removeEmbeddedFile`.
- **Modify** `src/document.ts` — add `GetAttachments` / `AddAttachment` / `RemoveAttachment`, delegating to `embeddedfile.ts`.
- **Modify** `src/annotation.ts` — add `FileAttachmentAnnotation` class, the `FileAttachment` case in `wrapAnnotation`, `FileAttachmentOptions`, and `addFileAttachment`.
- **Modify** `src/page.ts` — add `Page.AddFileAttachment` delegating to `addFileAttachment`.
- **Modify** `src/index.ts` — export the new public types/classes.
- **Create** `test/helpers/build-attachment-pdf.ts` — raw fixture with a nested `/EmbeddedFiles` Kids tree (read-path coverage).
- **Create** `test/embedded-files.test.ts` — all tests.
- **Modify** `README.md` — Features list + API overview.

---

### Task 1: Write primitive — `buildFilespec`

**Files:**
- Create: `src/embeddedfile.ts`
- Test: `test/embedded-files.test.ts`

**Interfaces:**
- Consumes: `md5` from `./crypto.js`; `inflateStream` from `./flate.js`; `formatPdfDate` from `./metadata.js`; `name`, `encodePdfText`, tagged-object shapes from `./types.js`; `deflateSync` from `node:zlib`.
- Produces:
  - `interface AttachmentOptions { mimeType?: string; description?: string; compress?: boolean; creationDate?: Date; modDate?: Date }`
  - `function buildFilespec(bytes: Uint8Array, fileName: string, opts: AttachmentOptions, alloc: (o: PdfObject) => PdfRef): PdfDict` — allocates the `/EmbeddedFile` stream via `alloc`, returns the (not-yet-allocated) `/Filespec` dict.

- [ ] **Step 1: Write the failing test**

Append to `test/embedded-files.test.ts` (create the file with this content):

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildFilespec, type AttachmentOptions,
} from '../src/embeddedfile.js';
import { md5 } from '../src/crypto.js';
import { inflateStream } from '../src/flate.js';
import { decodePdfText } from '../src/metadata.js';
import {
  isStream, isName, isString, isRef, isDict, type PdfRef, type PdfObject, type PdfStream,
} from '../src/types.js';

/** Collect objects an `alloc` callback receives, handing back sequential refs. */
function fakeAlloc() {
  const objs: PdfObject[] = [];
  const alloc = (o: PdfObject): PdfRef => {
    objs.push(o);
    return { kind: 'ref', num: objs.length, gen: 0 };
  };
  return { objs, alloc };
}

describe('buildFilespec', () => {
  const bytes = new TextEncoder().encode('hello attachment');

  it('builds a /Filespec over a compressed /EmbeddedFile stream with /Params', () => {
    const { objs, alloc } = fakeAlloc();
    const fs = buildFilespec(bytes, 'readme.txt', { description: 'A readme', mimeType: 'text/plain' }, alloc);

    expect(isName(fs.get('Type')!) && (fs.get('Type') as any).name).toBe('Filespec');
    expect(isString(fs.get('F')!) && decodePdfText((fs.get('F') as any).bytes)).toBe('readme.txt');
    expect(isString(fs.get('UF')!) && decodePdfText((fs.get('UF') as any).bytes)).toBe('readme.txt');
    expect(isString(fs.get('Desc')!) && decodePdfText((fs.get('Desc') as any).bytes)).toBe('A readme');

    const ef = fs.get('EF') as Map<string, PdfObject>;
    const ref = ef.get('F')!;
    expect(isRef(ref)).toBe(true);
    expect(ef.get('UF')).toBe(ref); // same shared stream object

    const stream = objs[(ref as PdfRef).num - 1] as PdfStream;
    expect(isStream(stream)).toBe(true);
    expect((stream.dict.get('Type') as any).name).toBe('EmbeddedFile');
    expect((stream.dict.get('Subtype') as any).name).toBe('text/plain');
    expect((stream.dict.get('Filter') as any).name).toBe('FlateDecode');

    const params = stream.dict.get('Params') as Map<string, PdfObject>;
    expect(params.get('Size')).toBe(bytes.length);
    expect([...(params.get('CheckSum') as any).bytes]).toEqual([...md5(bytes)]);
    expect(isString(params.get('CreationDate')!)).toBe(true);
    expect(isString(params.get('ModDate')!)).toBe(true);

    expect([...inflateStream(stream)]).toEqual([...bytes]); // round-trips
  });

  it('stores raw bytes with no /Filter when compress is false', () => {
    const { objs, alloc } = fakeAlloc();
    const fs = buildFilespec(bytes, 'a.bin', { compress: false }, alloc);
    const ref = (fs.get('EF') as Map<string, PdfObject>).get('F') as PdfRef;
    const stream = objs[ref.num - 1] as PdfStream;
    expect(stream.dict.get('Filter')).toBeUndefined();
    expect([...stream.raw]).toEqual([...bytes]);
  });

  it('throws on an empty name', () => {
    const { alloc } = fakeAlloc();
    expect(() => buildFilespec(bytes, '', {}, alloc)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/embedded-files.test.ts`
Expected: FAIL — cannot resolve `../src/embeddedfile.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/embeddedfile.ts`:

```typescript
import { deflateSync } from 'node:zlib';
import { PdfDict, PdfObject, PdfRef, PdfStream, name } from './types.js';
import { encodePdfText, formatPdfDate } from './metadata.js';
import { md5 } from './crypto.js';

/** Options shared by document-level attachments and FileAttachment annotations. */
export interface AttachmentOptions {
  /** MIME type written to the embedded stream's /Subtype (e.g. 'application/pdf'). */
  mimeType?: string;
  /** Human-readable description written to the filespec's /Desc. */
  description?: string;
  /** Compress the bytes with FlateDecode on save. Default true. */
  compress?: boolean;
  /** /Params /CreationDate. Default: now. */
  creationDate?: Date;
  /** /Params /ModDate. Default: now. */
  modDate?: Date;
}

const pdfStr = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** Build a /Filespec dict over a freshly allocated /EmbeddedFile stream. The
 *  stream is allocated through `alloc` (its /EF /F and /UF share one object);
 *  the returned /Filespec is NOT allocated — the caller decides where it lives
 *  (name tree value and/or annotation /FS). The /CheckSum is the MD5 of the
 *  UNCOMPRESSED bytes. */
export function buildFilespec(
  bytes: Uint8Array, fileName: string, opts: AttachmentOptions,
  alloc: (o: PdfObject) => PdfRef,
): PdfDict {
  if (typeof fileName !== 'string' || fileName === '')
    throw new RangeError('attachment name must be a non-empty string');
  const compress = opts.compress ?? true;
  const body = compress ? new Uint8Array(deflateSync(Buffer.from(bytes))) : bytes;

  const params: PdfDict = new Map<string, PdfObject>();
  params.set('Size', bytes.length);
  params.set('CheckSum', { kind: 'string', bytes: md5(bytes) });
  params.set('CreationDate', pdfStr(formatPdfDate(opts.creationDate ?? new Date())));
  params.set('ModDate', pdfStr(formatPdfDate(opts.modDate ?? new Date())));

  const streamDict: PdfDict = new Map<string, PdfObject>();
  streamDict.set('Type', name('EmbeddedFile'));
  if (opts.mimeType) streamDict.set('Subtype', name(opts.mimeType));
  if (compress) streamDict.set('Filter', name('FlateDecode'));
  streamDict.set('Params', params);
  const stream: PdfStream = { kind: 'stream', dict: streamDict, raw: body };
  const efRef = alloc(stream);

  const fs: PdfDict = new Map<string, PdfObject>();
  fs.set('Type', name('Filespec'));
  fs.set('F', pdfStr(fileName));
  fs.set('UF', pdfStr(fileName));
  if (opts.description) fs.set('Desc', pdfStr(opts.description));
  fs.set('EF', new Map<string, PdfObject>([['F', efRef], ['UF', efRef]]));
  return fs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/embedded-files.test.ts` then `npm run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/embeddedfile.ts test/embedded-files.test.ts
git commit -m "feat(attach): buildFilespec — /EmbeddedFile stream + /Filespec dict"
```

---

### Task 2: Read primitives — `readFilespec`, `readFilespecBytes`, `readAttachments`, `filespecName`

**Files:**
- Modify: `src/embeddedfile.ts`
- Create: `test/helpers/build-attachment-pdf.ts`
- Test: `test/embedded-files.test.ts`

**Interfaces:**
- Consumes: `collectNameTree` from `./outline.js`; `inflateStream` from `./flate.js`; `parsePdfDate`, `decodePdfText` from `./metadata.js`; `PdfParseError` from `./errors.js`; `Document` (type only) from `./document.js`.
- Produces:
  - `interface Attachment { Name: string; Description?: string; MimeType?: string; Size?: number; CreationDate?: Date; ModDate?: Date; GetBytes(): Uint8Array }`
  - `function filespecName(doc: Document, fs: PdfDict): string`
  - `function readFilespec(doc: Document, fsObj: PdfObject): Attachment | undefined`
  - `function readFilespecBytes(doc: Document, fsObj: PdfObject): Uint8Array`
  - `function readAttachments(doc: Document): Attachment[]` (sorted by Name)

- [ ] **Step 1: Write the failing test**

Create `test/helpers/build-attachment-pdf.ts`:

```typescript
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

/** A PDF whose /Names /EmbeddedFiles is a NESTED tree (intermediate /Kids node →
 *  leaf /Names) carrying one raw (uncompressed) attachment "readme.txt". */
export function buildEmbeddedFileTarget(): Uint8Array {
  const content = 'hello attachment'; // 16 bytes
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 6 0 R >> >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R >>`;
  objects[4] = `<< /Type /EmbeddedFile /Params << /Size ${byteLen(content)} >> /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
  objects[5] = `<< /Type /Filespec /F (readme.txt) /UF (readme.txt) /Desc (A readme) /EF << /F 4 0 R /UF 4 0 R >> >>`;
  objects[6] = `<< /Kids [7 0 R] >>`;
  objects[7] = `<< /Names [(readme.txt) 5 0 R] >>`;
  return assemble(objects, 7, 1);
}
```

Append to `test/embedded-files.test.ts`:

```typescript
import { Document } from '../src/document.js';
import { readAttachments, readFilespecBytes } from '../src/embeddedfile.js';
import { buildEmbeddedFileTarget } from './helpers/build-attachment-pdf.js';

describe('reading embedded files', () => {
  it('reads a nested /EmbeddedFiles Kids tree into Attachment metadata', () => {
    const doc = Document.Open(buildEmbeddedFileTarget());
    const list = readAttachments(doc);
    expect(list.map((a) => a.Name)).toEqual(['readme.txt']);
    const a = list[0];
    expect(a.Description).toBe('A readme');
    expect(a.Size).toBe(16);
    expect(new TextDecoder().decode(a.GetBytes())).toBe('hello attachment');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/embedded-files.test.ts`
Expected: FAIL — `readAttachments` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the top imports of `src/embeddedfile.ts`:

```typescript
import type { Document } from './document.js';
import { isArray, isDict, isName, isRef, isString, isStream } from './types.js';
import { decodePdfText, parsePdfDate } from './metadata.js';
import { inflateStream } from './flate.js';
import { collectNameTree } from './outline.js';
import { PdfParseError } from './errors.js';
```

(Keep the existing `name`, `encodePdfText`, `formatPdfDate`, `md5`, `deflateSync` imports; merge the `./types.js` and `./metadata.js` import lines rather than duplicating them.)

Append to `src/embeddedfile.ts`:

```typescript
/** Metadata view over one embedded file; GetBytes inflates on demand. */
export interface Attachment {
  Name: string;
  Description?: string;
  MimeType?: string;
  Size?: number;
  CreationDate?: Date;
  ModDate?: Date;
  GetBytes(): Uint8Array;
}

/** The filespec's display name, preferring the Unicode /UF over /F. */
export function filespecName(doc: Document, fs: PdfDict): string {
  const uf = fs.get('UF');
  if (isString(uf)) return decodePdfText(uf.bytes);
  const f = fs.get('F');
  if (isString(f)) return decodePdfText(f.bytes);
  return '';
}

/** Decode the embedded bytes of a /Filespec, inflating FlateDecode if present. */
export function readFilespecBytes(doc: Document, fsObj: PdfObject): Uint8Array {
  const fs = doc.resolve(fsObj);
  if (!isDict(fs)) throw new PdfParseError('attachment: /Filespec is not a dictionary');
  const ef = doc.resolve(fs.get('EF'));
  if (!isDict(ef)) throw new PdfParseError('attachment: missing /EF');
  const stream = doc.resolve(ef.get('F') ?? ef.get('UF'));
  if (!isStream(stream)) throw new PdfParseError('attachment: /EF /F is not a stream');
  return stream.dict.get('Filter') === undefined ? stream.raw : inflateStream(stream);
}

/** Decode a /Filespec into an Attachment, or undefined when not a dict. */
export function readFilespec(doc: Document, fsObj: PdfObject): Attachment | undefined {
  const fs = doc.resolve(fsObj);
  if (!isDict(fs)) return undefined;
  const att: Attachment = { Name: filespecName(doc, fs), GetBytes: () => readFilespecBytes(doc, fs) };
  const desc = fs.get('Desc');
  if (isString(desc)) att.Description = decodePdfText(desc.bytes);
  const ef = doc.resolve(fs.get('EF'));
  if (isDict(ef)) {
    const stream = doc.resolve(ef.get('F') ?? ef.get('UF'));
    if (isStream(stream)) {
      const sub = stream.dict.get('Subtype');
      if (isName(sub)) att.MimeType = sub.name;
      const params = doc.resolve(stream.dict.get('Params'));
      if (isDict(params)) {
        const size = doc.resolve(params.get('Size'));
        if (typeof size === 'number') att.Size = size;
        const cd = params.get('CreationDate');
        if (isString(cd)) { const d = parsePdfDate(decodePdfText(cd.bytes)); if (d instanceof Date) att.CreationDate = d; }
        const md = params.get('ModDate');
        if (isString(md)) { const d = parsePdfDate(decodePdfText(md.bytes)); if (d instanceof Date) att.ModDate = d; }
      }
    }
  }
  return att;
}

/** All document-level embedded files from /Root /Names /EmbeddedFiles, sorted. */
export function readAttachments(doc: Document): Attachment[] {
  const names = doc.resolve(doc.catalog().get('Names'));
  if (!isDict(names)) return [];
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get('EmbeddedFiles') ?? null, collected);
  const out: Attachment[] = [];
  for (const [key, v] of collected) {
    const att = readFilespec(doc, v);
    if (att) { if (!att.Name) att.Name = key; out.push(att); }
  }
  return out.sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/embedded-files.test.ts` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/embeddedfile.ts test/helpers/build-attachment-pdf.ts test/embedded-files.test.ts
git commit -m "feat(attach): read /EmbeddedFiles tree into Attachment metadata"
```

---

### Task 3: Name-tree mutation + Document API

**Files:**
- Modify: `src/embeddedfile.ts`
- Modify: `src/document.ts` (add methods near `GetNamedDestinations`, around line 585)
- Test: `test/embedded-files.test.ts`

**Interfaces:**
- Consumes: `buildFilespec`, `readAttachments`, `AttachmentOptions`, `Attachment` (Task 1–2); `flatNameNode`, `collectNameTree` from `./outline.js`; `allocObject`/`catalog`/`resolve` on `Document`.
- Produces:
  - `function upsertEmbeddedFile(doc: Document, key: string, fsRef: PdfRef): void`
  - `function removeEmbeddedFile(doc: Document, key: string): boolean`
  - `Document.GetAttachments(): Attachment[]`
  - `Document.AddAttachment(name: string, bytes: Uint8Array, opts?: AttachmentOptions): void`
  - `Document.RemoveAttachment(name: string): boolean`

- [ ] **Step 1: Write the failing test**

Append to `test/embedded-files.test.ts`:

```typescript
import { buildBlankPage } from './helpers/build-annot-target.js';

describe('Document attachment API', () => {
  const data = new TextEncoder().encode('payload-bytes');

  it('round-trips AddAttachment through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('notes.txt', data, { description: 'my notes', mimeType: 'text/plain' });
    const re = Document.Open(doc.Save());
    const list = re.GetAttachments();
    expect(list.map((a) => a.Name)).toEqual(['notes.txt']);
    expect(list[0].Description).toBe('my notes');
    expect(list[0].MimeType).toBe('text/plain');
    expect(new TextDecoder().decode(list[0].GetBytes())).toBe('payload-bytes');
  });

  it('keeps existing entries when adding a second attachment', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('a.txt', new TextEncoder().encode('A'), {});
    doc.AddAttachment('b.txt', new TextEncoder().encode('B'), {});
    const re = Document.Open(doc.Save());
    expect(re.GetAttachments().map((a) => a.Name)).toEqual(['a.txt', 'b.txt']);
  });

  it('upserts on duplicate name', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('x.txt', new TextEncoder().encode('old'), {});
    doc.AddAttachment('x.txt', new TextEncoder().encode('new'), {});
    const list = Document.Open(doc.Save()).GetAttachments();
    expect(list).toHaveLength(1);
    expect(new TextDecoder().decode(list[0].GetBytes())).toBe('new');
  });

  it('removes an attachment and reports presence', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('gone.txt', data, {});
    expect(doc.RemoveAttachment('gone.txt')).toBe(true);
    expect(doc.RemoveAttachment('gone.txt')).toBe(false);
    expect(Document.Open(doc.Save()).GetAttachments()).toEqual([]);
  });
});
```

Confirm `buildBlankPage` is exported from `test/helpers/build-annot-target.js` (it is — used by `test/annotation.test.ts`). If absent, import it from whichever helper exports a single-blank-page PDF.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/embedded-files.test.ts`
Expected: FAIL — `doc.AddAttachment` is not a function.

- [ ] **Step 3a: Add the tree-mutation helpers to `src/embeddedfile.ts`**

Ensure `flatNameNode` is imported from `./outline.js` (extend the existing `import { collectNameTree } from './outline.js';` to `import { collectNameTree, flatNameNode } from './outline.js';`). Append:

```typescript
/** Add a filespec ref to the catalog's /AF associated-files array (PDF 2.0),
 *  creating it on first use and de-duplicating by object number. */
function addAssociatedFile(doc: Document, fsRef: PdfRef): void {
  const catalog = doc.catalog();
  let af = doc.resolve(catalog.get('AF'));
  if (!isArray(af)) { af = []; catalog.set('AF', af); }
  if (!af.some((r) => isRef(r) && r.num === fsRef.num)) af.push(fsRef);
}

/** Remove a filespec ref from /AF, dropping the array when it empties. */
function removeAssociatedFile(doc: Document, fsRef: PdfRef): void {
  const catalog = doc.catalog();
  const af = doc.resolve(catalog.get('AF'));
  if (!isArray(af)) return;
  const i = af.findIndex((r) => isRef(r) && r.num === fsRef.num);
  if (i >= 0) af.splice(i, 1);
  if (af.length === 0) catalog.delete('AF');
}

/** Upsert `key` → `fsRef` into /Root /Names /EmbeddedFiles (single flat node,
 *  no rebalancing) and register the filespec in /AF. */
export function upsertEmbeddedFile(doc: Document, key: string, fsRef: PdfRef): void {
  if (typeof key !== 'string' || key === '')
    throw new RangeError('attachment name must be a non-empty string');
  const catalog = doc.catalog();
  let names = doc.resolve(catalog.get('Names'));
  if (!isDict(names)) { names = new Map<string, PdfObject>(); catalog.set('Names', names); }
  const entries = new Map<string, PdfObject>();
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get('EmbeddedFiles') ?? null, collected);
  for (const [k, v] of collected) entries.set(k, v);
  entries.set(key, fsRef);
  names.set('EmbeddedFiles', doc.allocObject(flatNameNode(entries)));
  addAssociatedFile(doc, fsRef);
}

/** Remove `key` from /EmbeddedFiles (collapsing empty containers) and from /AF.
 *  Returns false when the name was absent. */
export function removeEmbeddedFile(doc: Document, key: string): boolean {
  const catalog = doc.catalog();
  const names = doc.resolve(catalog.get('Names'));
  if (!isDict(names)) return false;
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get('EmbeddedFiles') ?? null, collected);
  const entries = new Map<string, PdfObject>(collected);
  const removed = entries.get(key);
  if (!entries.delete(key)) return false;
  if (entries.size === 0) {
    names.delete('EmbeddedFiles');
    if (names.size === 0) catalog.delete('Names');
  } else {
    names.set('EmbeddedFiles', doc.allocObject(flatNameNode(entries)));
  }
  if (isRef(removed)) removeAssociatedFile(doc, removed);
  return true;
}
```

- [ ] **Step 3b: Add the Document methods**

In `src/document.ts`, extend the `./embeddedfile.js` usage by adding an import near the other feature-module imports (after the `./outline.js` import block, ~line 22):

```typescript
import {
  AttachmentOptions, Attachment, buildFilespec, readAttachments,
  upsertEmbeddedFile, removeEmbeddedFile,
} from './embeddedfile.js';
```

Insert these methods after `RemoveNamedDestination` (after line ~627, alongside the named-destination API):

```typescript
  /** All document-level embedded files (the /Names /EmbeddedFiles tree), sorted
   *  by name. Each result's GetBytes() decodes the file on demand. */
  GetAttachments(): Attachment[] {
    return readAttachments(this);
  }

  /** Embed `bytes` as an attachment named `name`, upserting it into the
   *  /Names /EmbeddedFiles name tree (overwriting a same-named entry). */
  AddAttachment(name: string, bytes: Uint8Array, opts: AttachmentOptions = {}): void {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('attachment bytes must be a Uint8Array');
    const fs = buildFilespec(bytes, name, opts, (o) => this.allocObject(o));
    upsertEmbeddedFile(this, name, this.allocObject(fs));
  }

  /** Remove the named attachment from the name tree (and /AF). Returns false
   *  when no such attachment exists. */
  RemoveAttachment(name: string): boolean {
    return removeEmbeddedFile(this, name);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/embedded-files.test.ts` then `npm run typecheck`
Expected: PASS (all tests so far); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/embeddedfile.ts src/document.ts test/embedded-files.test.ts
git commit -m "feat(attach): Document GetAttachments/AddAttachment/RemoveAttachment"
```

---

### Task 4: FileAttachment annotation

**Files:**
- Modify: `src/annotation.ts` (new class after `LinkAnnotation` ~line 288; `wrapAnnotation` case ~line 302; `addFileAttachment` near `addStamp` ~line 441)
- Modify: `src/page.ts` (new method near `AddLink` ~line 244)
- Test: `test/embedded-files.test.ts`

**Interfaces:**
- Consumes: `createAnnotation`, `Annotation`, `wrapAnnotation` (existing in `annotation.ts`); `buildFilespec`, `readFilespecBytes`, `filespecName`, `upsertEmbeddedFile`, `AttachmentOptions` from `./embeddedfile.js`; `name`, `isDict`, `isName`, `isString` from `./types.js`; `decodePdfText` from `./metadata.js`; `PdfParseError` from `./errors.js`.
- Produces:
  - `class FileAttachmentAnnotation extends Annotation` with `Icon` (get/set), `FileName` (get), `Description` (get), `GetBytes()`.
  - `interface FileAttachmentOptions extends AttachmentOptions { rect: [number,number,number,number]; name: string; bytes: Uint8Array; icon?: 'PushPin'|'Paperclip'|'Graph'|'Tag'; addToCatalog?: boolean; contents?: string; color?: [number,number,number] }`
  - `function addFileAttachment(doc: Document, page: Page, opts: FileAttachmentOptions): FileAttachmentAnnotation`
  - `Page.AddFileAttachment(opts: FileAttachmentOptions): FileAttachmentAnnotation`

- [ ] **Step 1: Write the failing test**

Append to `test/embedded-files.test.ts`:

```typescript
import { FileAttachmentAnnotation } from '../src/annotation.js';

describe('FileAttachment annotation', () => {
  const bytes = new TextEncoder().encode('annotated file');

  it('places a FileAttachment annotation and reads it back', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const a = page.AddFileAttachment({ rect: [10, 10, 30, 30], name: 'clip.txt', bytes, icon: 'Paperclip' });
    expect(a).toBeInstanceOf(FileAttachmentAnnotation);
    expect(a.Icon).toBe('Paperclip');
    expect(a.FileName).toBe('clip.txt');

    const re = Document.Open(doc.Save());
    const annots = re.Pages[0].Annotations; // getter, not a method
    const fa = annots.find((x) => x.Subtype === 'FileAttachment') as FileAttachmentAnnotation;
    expect(fa).toBeInstanceOf(FileAttachmentAnnotation);
    expect(fa.FileName).toBe('clip.txt');
    expect(new TextDecoder().decode(fa.GetBytes())).toBe('annotated file');
    // annotation-only by default → not in the catalog list
    expect(re.GetAttachments()).toEqual([]);
  });

  it('also lists in the catalog when addToCatalog is true', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddFileAttachment({ rect: [0, 0, 20, 20], name: 'both.txt', bytes, addToCatalog: true });
    const re = Document.Open(doc.Save());
    expect(re.GetAttachments().map((x) => x.Name)).toEqual(['both.txt']);
    expect(new TextDecoder().decode(re.GetAttachments()[0].GetBytes())).toBe('annotated file');
  });

  it('defaults the icon to PushPin', () => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddFileAttachment({ rect: [0, 0, 20, 20], name: 'p.txt', bytes });
    expect(a.Icon).toBe('PushPin');
  });
});
```

The page annotation reader is the getter `page.Annotations` (confirmed in `src/page.ts:186` — `get Annotations(): Annotation[]`), not a method.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/embedded-files.test.ts`
Expected: FAIL — `FileAttachmentAnnotation` is not exported / `AddFileAttachment` is not a function.

- [ ] **Step 3a: Add the class + wrapAnnotation case in `src/annotation.ts`**

Add imports at the top of `annotation.ts` (merge into existing import lines where the module already imports from these paths):

```typescript
import {
  buildFilespec, readFilespecBytes, filespecName, upsertEmbeddedFile,
  type AttachmentOptions,
} from './embeddedfile.js';
import { PdfParseError } from './errors.js';
```

Add the class after `LinkAnnotation` (before `wrapAnnotation`):

```typescript
/** A /FileAttachment annotation: an icon on the page whose /FS embeds a file. */
export class FileAttachmentAnnotation extends Annotation {
  /** The /Name icon key (PushPin, Paperclip, Graph, Tag). */
  get Icon(): string {
    const n = this.Dict.get('Name');
    return isName(n) ? n.name : 'PushPin';
  }
  set Icon(v: string) { this.Dict.set('Name', name(v)); this.touch(); }

  /** The embedded file's display name (from the /FS filespec). */
  get FileName(): string {
    const fs = this.doc.resolve(this.Dict.get('FS'));
    return isDict(fs) ? filespecName(this.doc, fs) : '';
  }

  /** The filespec's /Desc, if any. */
  get Description(): string | undefined {
    const fs = this.doc.resolve(this.Dict.get('FS'));
    if (!isDict(fs)) return undefined;
    const d = fs.get('Desc');
    return isString(d) ? decodePdfText(d.bytes) : undefined;
  }

  /** Decode the embedded bytes. */
  GetBytes(): Uint8Array {
    const fs = this.Dict.get('FS');
    if (fs === undefined) throw new PdfParseError('file attachment: missing /FS');
    return readFilespecBytes(this.doc, fs);
  }
}
```

Add the case in `wrapAnnotation`:

```typescript
    case 'FileAttachment': return new FileAttachmentAnnotation(doc, dict);
```

- [ ] **Step 3b: Add `FileAttachmentOptions` + `addFileAttachment`**

Append near `addStamp` in `annotation.ts`:

```typescript
/** Options for {@link Page.AddFileAttachment}. */
export interface FileAttachmentOptions extends AttachmentOptions {
  /** Annotation rectangle [x1, y1, x2, y2] in PDF user space. */
  rect: [number, number, number, number];
  /** Embedded file name. */
  name: string;
  /** File bytes to embed. */
  bytes: Uint8Array;
  /** Icon key. Default 'PushPin'. */
  icon?: 'PushPin' | 'Paperclip' | 'Graph' | 'Tag';
  /** Also register the file in /Names /EmbeddedFiles so it shows in the
   *  attachments panel (shares one filespec object). Default false. */
  addToCatalog?: boolean;
  /** Optional /Contents note text. */
  contents?: string;
  /** Optional icon color [r, g, b] in 0..1. */
  color?: [number, number, number];
}

/** Create a /FileAttachment annotation on `page` embedding `opts.bytes`. */
export function addFileAttachment(
  doc: Document, page: Page, opts: FileAttachmentOptions,
): FileAttachmentAnnotation {
  if (!(opts.bytes instanceof Uint8Array)) throw new TypeError('file attachment bytes must be a Uint8Array');
  if (typeof opts.name !== 'string' || opts.name === '') throw new RangeError('file attachment name must be a non-empty string');
  const fs = buildFilespec(opts.bytes, opts.name, opts, (o) => doc.allocObject(o));
  const fsRef = doc.allocObject(fs);
  const dict = createAnnotation(doc, page, {
    subtype: 'FileAttachment', rect: opts.rect, color: opts.color, contents: opts.contents,
  });
  dict.set('FS', fsRef);
  dict.set('Name', name(opts.icon ?? 'PushPin'));
  if (opts.addToCatalog) upsertEmbeddedFile(doc, opts.name, fsRef);
  return new FileAttachmentAnnotation(doc, dict);
}
```

- [ ] **Step 3c: Add the Page method**

In `src/page.ts`, add the import (merge with the existing `./annotation.js` import) for `addFileAttachment`, `FileAttachmentOptions`, `FileAttachmentAnnotation`, and add the method near `AddLink`:

```typescript
  /** Embed a file and place a /FileAttachment icon annotation on this page. */
  AddFileAttachment(opts: FileAttachmentOptions): FileAttachmentAnnotation {
    return addFileAttachment(this.doc, this, opts);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/embedded-files.test.ts` then `npm run typecheck`
Expected: PASS (all tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/annotation.ts src/page.ts test/embedded-files.test.ts
git commit -m "feat(attach): FileAttachment annotation + Page.AddFileAttachment"
```

---

### Task 5: Public exports + README + full suite

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything produced above.
- Produces: public exports for `Attachment`, `AttachmentOptions`, `FileAttachmentOptions`, `FileAttachmentAnnotation`.

- [ ] **Step 1: Add the exports**

`src/index.ts` uses explicit named exports. Add a new line for the embeddedfile types, append `FileAttachmentAnnotation` to the existing annotation value-export (line 11), and add `FileAttachmentOptions` to the existing annotation `export type` block (lines 12-15):

```typescript
// new line (place near the other type re-exports):
export type { Attachment, AttachmentOptions } from './embeddedfile.js';
```

```typescript
// line 11 — add FileAttachmentAnnotation:
export { Annotation, TextAnnotation, StampAnnotation, MarkupAnnotation, LinkAnnotation, FileAttachmentAnnotation } from './annotation.js';
```

```typescript
// lines 12-15 — add FileAttachmentOptions to the list:
export type {
  TextNoteOptions, StampAnnotationOptions, MarkupOptions, MarkupType,
  LinkOptions, LinkAction, GoToAction, UriAction, FileAttachmentOptions,
} from './annotation.js';
```

- [ ] **Step 2: Verify exports compile**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Update README**

In `README.md`, add embedded files to the Features list and an API-overview snippet:

```markdown
- **Embedded files / attachments** — embed files at the document level
  (`AddAttachment` / `GetAttachments` / `RemoveAttachment`, surfaced in a
  viewer's attachments panel) or as on-page `FileAttachment` annotations
  (`Page.AddFileAttachment`). Bytes are FlateDecode-compressed by default
  (`compress: false` to store raw); `/Params` carries `/Size`, an MD5
  `/CheckSum`, and creation/modification dates.
```

```typescript
// Document-level attachment
doc.AddAttachment('report.csv', bytes, { mimeType: 'text/csv', description: 'Q2 figures' });
for (const a of doc.GetAttachments()) console.log(a.Name, a.Size, a.GetBytes().length);
doc.RemoveAttachment('report.csv');

// On-page attachment icon
doc.Pages[0].AddFileAttachment({ rect: [72, 700, 92, 720], name: 'note.txt', bytes, icon: 'PushPin' });
```

Match the README's existing section structure and prose style; place the snippet alongside related authoring examples.

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full vitest suite green (no regressions in existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat(attach): export attachment API and document in README"
```

---

## Notes for the implementer

- **`md5` already exists** — `export const md5 = (b) => new Uint8Array(createHash('md5').update(b).digest())` in `src/crypto.ts`. Do not add a new MD5.
- **`/Length` is automatic** — `serializeStream` in `src/serialize.ts` recomputes `/Length` from `raw.length`; never set it in `buildFilespec`.
- **Mark-sweep retention** — a filespec referenced from `/Names /EmbeddedFiles` or a page `/Annots /FS` is reachable from `/Root`, so `Save()` keeps and renumbers it automatically. No serializer change.
- **`compressed: true` save path** — attachments are ordinary stream objects, so `Save({ compressed: true })` and encryption work unchanged; no extra handling needed.
- **Confirmed APIs** — these names were verified against the codebase and are used as-is: `Document.Open` (static), `doc.Save()`, `doc.Pages` (`readonly Pages: Page[]`), `page.Annotations` (getter), `buildBlankPage` (in `test/helpers/build-annot-target.ts`), plus the internals `allocObject`, `catalog`, `resolve`, `pageRef`, `createAnnotation`, `wrapAnnotation`. No further name-guessing should be needed.
```
