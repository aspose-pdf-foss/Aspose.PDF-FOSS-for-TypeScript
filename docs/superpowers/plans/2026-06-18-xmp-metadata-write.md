# XMP Metadata Write / Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write the document-level XMP packet at `/Root /Metadata` from structured input via `Document.SetXmp(update)`, and keep `/Info` and XMP consistent by auto-mirroring shared fields in both directions (`SetMetadata` → XMP, `SetXmp` → `/Info`).

**Architecture:** `src/xmp.ts` gains `buildXmp(meta): string` (a well-formed packet with XML escaping), an `XmpUpdate` type, a `mergeXmp(current, update)` helper (null deletes, drops `raw`), and two pure mirror mappers (`mirrorMetaToXmp` / `mirrorXmpToMeta`) bridging the `/Info` `Metadata` shape and `XmpMetadata`. `Document` gains a private `installXmp(meta)` that builds the packet and installs a `/Type /Metadata /Subtype /XML` stream off the catalog, a public `SetXmp(update)`, and a mirror step inside `SetMetadata`. Both write paths funnel through `installXmp` + `applyUpdate` exactly once each, so they never recurse. `Save()`'s mark-sweep serializes the new stream with no serializer change.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Node built-ins only — no XML library.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins; XMP is built/parsed with a lightweight scan, no XML library.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension.
- **Strict TypeScript** — `npm run typecheck` must stay green.
- **No serializer change** — the new `/Metadata` stream is a normal object reachable from `/Root`; `Save()` mark-sweep picks it up. The stream is **uncompressed** (no `/Filter`).
- **Live-mutation model** — install replaces the catalog `/Metadata` ref; the old stream object becomes unreferenced and is dropped by the next `Save()` mark-sweep.
- **No recursion in the mirror** — `SetMetadata` and `SetXmp` each write `/Info` once (`applyUpdate`) and XMP once (`installXmp`); neither calls the other.
- **TDD** — failing test first, watch it fail, implement minimally, watch it pass, commit. Run `npm run typecheck` before any commit that changes types.
- Target a single test file with `npx vitest run test/xmp.test.ts`; full suite with `npm test`.

## Foundation already shipped (consume, do not rebuild)

From `src/xmp.ts` (shipped by `rwn`):
- `interface XmpMetadata { title?; authors?; description?; subjects?; keywords?; creatorTool?; producer?; createDate?; modifyDate?; rights?; raw? }`.
- `function readXmp(bytes: Uint8Array): XmpMetadata` — used by tests to verify `buildXmp` round-trips.
- Module-private `decodeText`, `unescapeXml`, etc. (not needed here).

From `src/metadata.ts`:
- `interface Metadata { title?; author?; subject?; keywords?; creator?; producer?; creationDate?; modDate?; custom }`.
- `interface MetadataUpdate { title?; author?; subject?; keywords?; creator?; producer?; creationDate?; modDate?; custom? }` — each scalar is `string | null` (dates `Date | string | null`); `null` deletes.
- `function applyUpdate(info: PdfDict, update: MetadataUpdate): void` — writes `/Info` (handles dates + custom).

From `src/document.ts`:
- `GetXmp(): XmpMetadata`, `GetMetadata(): Metadata`, `catalog(): PdfDict`, `resolve(o)`, `allocObject(obj): PdfRef`, `ensureInfo(): PdfDict` (private), `SetMetadata(update)` (currently `applyUpdate(ensureInfo(), update)` only), `isStream`, `name`, `ref` (imported). `inflateStream`, `readXmp`, `XmpMetadata` already imported.

From `src/types.ts`: `PdfStream`, `isStream`, `name`.

Test fixtures: `test/helpers/build-xmp-pdf.ts` exports `buildXmpPdf(packet)`; `test/helpers/build-annot-target.ts` exports `buildBlankPage()`. `test/xmp.test.ts` already defines the `FULL` packet constant and imports `Document`, `buildXmpPdf`, `buildBlankPage`.

## The /Info ↔ XMP mirror (shared fields)

| Logical field   | `Metadata` (/Info) field | `XmpMetadata` field | Projection notes |
|-----------------|--------------------------|---------------------|------------------|
| title           | `title`                  | `title`             | 1:1 string |
| author          | `author` (scalar)        | `authors` (list)    | meta→xmp: split on `,`; xmp→meta: join with `, ` |
| subject         | `subject`                | `description`       | `/Subject` ↔ `dc:description` |
| keywords        | `keywords`               | `keywords`          | `pdf:Keywords` |
| creator (tool)  | `creator`                | `creatorTool`       | `xmp:CreatorTool` |
| producer        | `producer`               | `producer`          | `pdf:Producer` |
| creationDate    | `creationDate`           | `createDate`        | `xmp:CreateDate` |
| modDate         | `modDate`                | `modifyDate`        | `xmp:ModifyDate` |

XMP-only fields (`subjects` = `dc:subject`, `rights` = `dc:rights`) are **not** mirrored into `/Info`; `/Info` custom keys are **not** mirrored into XMP.

---

### Task 1: `buildXmp` + `XmpUpdate` + `mergeXmp` + mirror mappers (`src/xmp.ts`)

Pure functions, tested directly (no `Document`).

**Files:**
- Modify: `src/xmp.ts` (add the builder, update type, merge, and two mirror mappers + their imports)
- Modify: `test/xmp.test.ts` (add `buildXmp` / `mergeXmp` describe blocks)

**Interfaces:**
- Consumes: `XmpMetadata` (same module), `MetadataUpdate` from `./metadata.js`.
- Produces:
  - `export type XmpUpdate = { [K in keyof Omit<XmpMetadata, 'raw'>]?: XmpMetadata[K] | null }`
  - `export function buildXmp(meta: XmpMetadata): string`
  - `export function mergeXmp(current: XmpMetadata, update: XmpUpdate): XmpMetadata`
  - `export function mirrorMetaToXmp(u: MetadataUpdate): XmpUpdate`
  - `export function mirrorXmpToMeta(u: XmpUpdate): MetadataUpdate`

- [ ] **Step 1: Write the failing test**

In `test/xmp.test.ts`, extend the top import:

```ts
import { readXmp, buildXmp, mergeXmp } from '../src/xmp.js';
```

Append these describe blocks:

```ts
describe('buildXmp', () => {
  it('round-trips a full metadata object through readXmp', () => {
    const meta = {
      title: 'T & U', authors: ['A', 'B'], description: 'D', subjects: ['x', 'y'],
      rights: 'R', keywords: 'k1, k2', producer: 'P', creatorTool: 'C',
      createDate: new Date('2024-06-03T12:30:45.000Z'),
      modifyDate: new Date('2024-06-04T08:00:00.000Z'),
    };
    const back = readXmp(new TextEncoder().encode(buildXmp(meta)));
    expect(back.title).toBe('T & U');
    expect(back.authors).toEqual(['A', 'B']);
    expect(back.description).toBe('D');
    expect(back.subjects).toEqual(['x', 'y']);
    expect(back.rights).toBe('R');
    expect(back.keywords).toBe('k1, k2');
    expect(back.producer).toBe('P');
    expect(back.creatorTool).toBe('C');
    expect(back.createDate).toEqual(new Date('2024-06-03T12:30:45.000Z'));
    expect(back.modifyDate).toEqual(new Date('2024-06-04T08:00:00.000Z'));
  });

  it('escapes XML special characters', () => {
    const xml = buildXmp({ title: '<a> & "b"' });
    expect(xml).toContain('&lt;a&gt; &amp; &quot;b&quot;');
    expect(readXmp(new TextEncoder().encode(xml)).title).toBe('<a> & "b"');
  });

  it('omits absent fields', () => {
    const xml = buildXmp({ title: 'only' });
    expect(xml).not.toContain('pdf:Producer');
    expect(xml).not.toContain('dc:creator');
  });
});

describe('mergeXmp', () => {
  it('applies value sets, null deletes, and drops raw', () => {
    const merged = mergeXmp({ title: 'old', producer: 'P', raw: 'RAW' }, { title: 'new', producer: null });
    expect(merged.title).toBe('new');
    expect(merged.producer).toBeUndefined();
    expect(merged.raw).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/xmp.test.ts`
Expected: FAIL — `buildXmp` / `mergeXmp` are not exported.

- [ ] **Step 3: Add the builder, update type, merge, and mirror mappers to `src/xmp.ts`**

At the top of `src/xmp.ts`, add the import:

```ts
import type { MetadataUpdate } from './metadata.js';
```

Append at the end of `src/xmp.ts`:

```ts
/** A partial XMP update: each known field may be set, or `null` to delete. */
export type XmpUpdate = { [K in keyof Omit<XmpMetadata, 'raw'>]?: XmpMetadata[K] | null };

/** Escape the five XML predefined entities (`&` first to avoid double-encoding). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function dateStr(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

/** Emit a well-formed XMP packet for the known dc / xmp / pdf properties. Absent
 *  fields are omitted; `raw` is ignored (the packet is rebuilt from fields). */
export function buildXmp(meta: XmpMetadata): string {
  const lines: string[] = [];
  const alt = (tag: string, v: string) =>
    `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt></${tag}>`;
  const container = (tag: string, kind: 'Seq' | 'Bag', items: string[]) =>
    `   <${tag}><rdf:${kind}>${items.map((i) => `<rdf:li>${escapeXml(i)}</rdf:li>`).join('')}</rdf:${kind}></${tag}>`;
  const simple = (tag: string, v: string) => `   <${tag}>${escapeXml(v)}</${tag}>`;

  if (meta.title !== undefined) lines.push(alt('dc:title', meta.title));
  if (meta.authors && meta.authors.length) lines.push(container('dc:creator', 'Seq', meta.authors));
  if (meta.description !== undefined) lines.push(alt('dc:description', meta.description));
  if (meta.subjects && meta.subjects.length) lines.push(container('dc:subject', 'Bag', meta.subjects));
  if (meta.rights !== undefined) lines.push(alt('dc:rights', meta.rights));
  if (meta.keywords !== undefined) lines.push(simple('pdf:Keywords', meta.keywords));
  if (meta.producer !== undefined) lines.push(simple('pdf:Producer', meta.producer));
  if (meta.creatorTool !== undefined) lines.push(simple('xmp:CreatorTool', meta.creatorTool));
  if (meta.createDate !== undefined) lines.push(simple('xmp:CreateDate', dateStr(meta.createDate)));
  if (meta.modifyDate !== undefined) lines.push(simple('xmp:ModifyDate', dateStr(meta.modifyDate)));

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
${lines.join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Merge `update` over `current`: value sets, `null` deletes; `raw` is dropped. */
export function mergeXmp(current: XmpMetadata, update: XmpUpdate): XmpMetadata {
  const out: XmpMetadata = { ...current };
  delete out.raw;
  for (const key of Object.keys(update) as (keyof XmpUpdate)[]) {
    const v = update[key];
    if (v === undefined) continue;
    if (v === null) delete (out as Record<string, unknown>)[key];
    else (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Split an /Author scalar into ordered author items (drops empty segments). */
function splitAuthors(s: string): string[] {
  return s.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Project the shared fields of an /Info MetadataUpdate onto an XmpUpdate. */
export function mirrorMetaToXmp(u: MetadataUpdate): XmpUpdate {
  const out: XmpUpdate = {};
  if (u.title !== undefined) out.title = u.title;
  if (u.author !== undefined) out.authors = u.author === null ? null : splitAuthors(u.author);
  if (u.subject !== undefined) out.description = u.subject;
  if (u.keywords !== undefined) out.keywords = u.keywords;
  if (u.creator !== undefined) out.creatorTool = u.creator;
  if (u.producer !== undefined) out.producer = u.producer;
  if (u.creationDate !== undefined) out.createDate = u.creationDate;
  if (u.modDate !== undefined) out.modifyDate = u.modDate;
  return out;
}

/** Project the shared fields of an XmpUpdate back onto an /Info MetadataUpdate. */
export function mirrorXmpToMeta(u: XmpUpdate): MetadataUpdate {
  const out: MetadataUpdate = {};
  if (u.title !== undefined) out.title = u.title;
  if (u.authors !== undefined) out.author = u.authors === null ? null : u.authors.join(', ');
  if (u.description !== undefined) out.subject = u.description;
  if (u.keywords !== undefined) out.keywords = u.keywords;
  if (u.creatorTool !== undefined) out.creator = u.creatorTool;
  if (u.producer !== undefined) out.producer = u.producer;
  if (u.createDate !== undefined) out.creationDate = u.createDate;
  if (u.modifyDate !== undefined) out.modDate = u.modifyDate;
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/xmp.test.ts` — Expected: PASS.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/xmp.ts test/xmp.test.ts
git commit -m "feat: buildXmp + XmpUpdate/mergeXmp + /Info mirror mappers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Document.SetXmp` + `installXmp` + `SetMetadata` mirror

Wires the builder/merge/mirror into the document and exposes `SetXmp`.

**Files:**
- Modify: `src/document.ts` (imports + private `installXmp` + `SetXmp` + mirror in `SetMetadata`)
- Modify: `src/index.ts` (export `XmpUpdate`)
- Modify: `README.md` (Features bullet + API row)
- Modify: `test/xmp.test.ts` (Document `SetXmp` + mirror tests)

**Interfaces:**
- Consumes: `buildXmp`, `mergeXmp`, `mirrorMetaToXmp`, `mirrorXmpToMeta`, `XmpUpdate` (Task 1); `applyUpdate`/`ensureInfo`/`GetXmp`/`catalog`/`allocObject`; `PdfStream`, `isStream`, `name`.
- Produces: `Document.SetXmp(update: XmpUpdate): void`; updated `SetMetadata` that also mirrors shared fields into XMP.

- [ ] **Step 1: Write the failing test**

In `test/xmp.test.ts`, append:

```ts
describe('Document.SetXmp', () => {
  it('creates a /Metadata packet readable via GetXmp and surviving Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ title: 'Hello', authors: ['Jane'], rights: 'Mine' });
    expect(doc.GetXmp().title).toBe('Hello');

    const re = Document.Open(doc.Save());
    expect(re.GetXmp().title).toBe('Hello');
    expect(re.GetXmp().authors).toEqual(['Jane']);
    expect(re.GetXmp().rights).toBe('Mine');
  });

  it('merges over the existing packet (null deletes, others preserved)', () => {
    const doc = Document.Open(buildXmpPdf(FULL));
    doc.SetXmp({ title: 'Changed', producer: null });
    const xmp = doc.GetXmp();
    expect(xmp.title).toBe('Changed');
    expect(xmp.producer).toBeUndefined();
    expect(xmp.authors).toEqual(['Jane Doe', 'John Roe']); // preserved from FULL
  });

  it('mirrors shared fields into /Info, leaving XMP-only fields out', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ title: 'T', authors: ['A', 'B'], description: 'Desc', rights: 'R' });
    const meta = doc.GetMetadata();
    expect(meta.title).toBe('T');
    expect(meta.author).toBe('A, B');     // authors joined
    expect(meta.subject).toBe('Desc');    // dc:description -> /Subject
    expect(meta).not.toHaveProperty('rights'); // dc:rights is XMP-only
  });
});

describe('SetMetadata <-> XMP mirror', () => {
  it('SetMetadata writes overlapping fields into XMP, not custom keys', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetMetadata({ title: 'Report', author: 'Jane, John', custom: { Dept: 'R&D' } });
    const xmp = doc.GetXmp();
    expect(xmp.title).toBe('Report');
    expect(xmp.authors).toEqual(['Jane', 'John']);  // /Author split into authors
    expect(xmp.raw).not.toContain('Dept');          // custom keys stay /Info-only
  });

  it('does not create an XMP packet when only custom /Info keys change', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetMetadata({ custom: { Dept: 'R&D' } });
    expect(doc.GetXmp()).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/xmp.test.ts`
Expected: FAIL — `doc.SetXmp is not a function`.

- [ ] **Step 3: Add imports + `installXmp` + `SetXmp` + `SetMetadata` mirror to `src/document.ts`**

Extend the xmp import line:

```ts
import { readXmp, buildXmp, mergeXmp, mirrorMetaToXmp, mirrorXmpToMeta, XmpMetadata, XmpUpdate } from './xmp.js';
```

Ensure `PdfStream` is in the `./types.js` import (add it if missing):

```ts
import { PdfObject, PdfDict, PdfRef, PdfStream, isRef, isDict, isStream, isName, isArray, isString, ref, name } from './types.js';
```

Add a private installer immediately after `GetXmp`:

```ts
  /** Build the XMP packet for `meta` and install it as the catalog's /Metadata
   *  stream (uncompressed). Replaces any existing packet; the old object is
   *  dropped by the next Save() mark-sweep. */
  private installXmp(meta: XmpMetadata): void {
    const bytes = new TextEncoder().encode(buildXmp(meta));
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Metadata')], ['Subtype', name('XML')],
    ]);
    const stream: PdfStream = { kind: 'stream', dict, raw: bytes };
    this.catalog().set('Metadata', this.allocObject(stream));
  }
```

Replace `SetMetadata` with the mirroring version:

```ts
  SetMetadata(update: MetadataUpdate): void {
    applyUpdate(this.ensureInfo(), update);
    const xmpUpdate = mirrorMetaToXmp(update);
    if (Object.keys(xmpUpdate).length === 0) return; // no shared fields → leave XMP alone
    const merged = mergeXmp(this.GetXmp(), xmpUpdate);
    const hadXmp = isStream(this.resolve(this.catalog().get('Metadata')));
    // Avoid materializing an empty packet from a pure-delete on a doc with no XMP.
    if (hadXmp || hasXmpField(merged)) this.installXmp(merged);
  }

  /** Set/replace the document XMP packet from `update` (merged over the current
   *  packet; `null` deletes a field), mirroring shared fields back into /Info. */
  SetXmp(update: XmpUpdate): void {
    this.installXmp(mergeXmp(this.GetXmp(), update));
    applyUpdate(this.ensureInfo(), mirrorXmpToMeta(update));
  }
```

Add this module-level helper near the top of `src/document.ts` (after the imports, beside the other free helpers):

```ts
/** True when `meta` carries at least one known (non-raw) XMP field. */
function hasXmpField(meta: XmpMetadata): boolean {
  return Object.entries(meta).some(([k, v]) => k !== 'raw' && v !== undefined);
}
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/xmp.test.ts` — Expected: PASS.

- [ ] **Step 5: Export from `index.ts`**

In `src/index.ts`, change:

```ts
export type { XmpMetadata } from './xmp.js';
```

to:

```ts
export type { XmpMetadata, XmpUpdate } from './xmp.js';
```

- [ ] **Step 6: Update the README**

In `README.md`, change the Metadata feature bullet to mention writing XMP:

```
- **Metadata** — `GetMetadata`, `SetMetadata`, `ClearMetadata` for the `/Info` dictionary, including custom keys; `GetXmp` / `SetXmp` read and write the document-level XMP packet (`/Root /Metadata`), auto-synced with the shared `/Info` fields.
```

And add an API row immediately after the `doc.GetXmp()` row:

```
| `doc.SetXmp(update)` | Write/merge the XMP packet (`null` deletes); mirrors shared fields to `/Info` |
```

- [ ] **Step 7: Run typecheck, full suite, and build**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm test` — Expected: full suite green (including the existing `SetMetadata` metadata tests, which still pass since `/Info` writes are unchanged and XMP is only added for shared fields).
Run: `npm run build` — Expected: clean build (emits `XmpUpdate` to `.d.ts`).

- [ ] **Step 8: Commit**

```bash
git add src/document.ts src/index.ts README.md test/xmp.test.ts
git commit -m "feat: Document.SetXmp + /Info<->XMP auto-mirror

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes / follow-ups

- **`ClearMetadata` is unchanged** (still `/Info`-only). Clearing XMP too could be a future enhancement; left out to preserve existing behavior and tests.
- **`buildXmp` rebuilds from structured fields** and does not preserve unknown/custom XMP schemas present in a read packet's `raw`. This matches the design spec's "v1 reads/writes the known schemas; raw preserved for round-tripping but not structurally edited beyond those schemas."
- **Dates:** `SetXmp` mirrors a `Date` `createDate` to `/Info` via `applyUpdate` (proper `D:` format); a pre-formatted ISO **string** is stored verbatim. Prefer `Date` values for clean `/Info` dates.
- **Author mapping is heuristic:** `/Author` splits on `,` to `dc:creator` items and joins with `, ` on the way back, so a single author with a comma in their name is not perfectly preserved. Acceptable per spec.
- This is the last Phase 3 leaf — closing it completes epic `tum`.
