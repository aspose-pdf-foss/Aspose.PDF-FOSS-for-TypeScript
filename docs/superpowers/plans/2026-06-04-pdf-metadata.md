# PDF Metadata Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `getMetadata`/`setMetadata`/`clearMetadata` and `save()` to `Document`, operating on the `/Info` dictionary (standard + custom fields) and persisting changes via an incremental update.

**Architecture:** Metadata read/write is pure-function logic in a new `src/metadata.ts` (string/date codecs, `/Info` ↔ `Metadata` mapping). `Document` holds an in-memory working copy of `/Info` and a small state flag; `save()` delegates to a new `src/incremental.ts` that appends a changed `/Info` object + a classic xref section with `/Prev` back to the original. Existing PDF-value serialization is extracted from `writer.ts` into a shared `src/serialize.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-04-pdf-metadata-design.md`
**Issue:** aspose-pdf-foss-for-ts-w98

---

## File Structure

- Create `src/serialize.ts` — PDF value/object serialization (moved from `writer.ts`).
- Modify `src/writer.ts` — import serialization from `serialize.ts`.
- Modify `src/types.ts` — add `isString` type guard.
- Create `src/metadata.ts` — `Metadata`/`MetadataUpdate` types, string & date codecs, `/Info` mapping.
- Modify `src/document.ts` — metadata state, `getMetadata`/`setMetadata`/`clearMetadata`/`save`.
- Create `src/incremental.ts` — incremental-update writer.
- Modify `src/index.ts` — export `Document`, `Metadata`, `MetadataUpdate`.
- Modify `test/helpers/build-pdf.ts` — optional `/Info` dict in fixtures.
- Create `test/metadata.test.ts` — codec + mapping unit tests.
- Create `test/incremental.test.ts` — incremental writer unit tests.
- Create `test/document-metadata.test.ts` — `Document` integration + save round-trip.

---

## Task 1: Extract serialization into `src/serialize.ts`

Pure refactor. The existing `test/writer.test.ts` is the safety net — no new test.

**Files:**
- Create: `src/serialize.ts`
- Modify: `src/writer.ts:1-3` (imports) and remove its local serialization helpers
- Modify: `src/types.ts` (add `isString`)

- [ ] **Step 1: Create `src/serialize.ts`**

```ts
import { PdfObject, PdfDict, PdfArray, PdfStream, isRef, isName, isDict, isArray, isStream } from './types.js';

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export function serializeObject(o: PdfObject): Uint8Array {
  if (isStream(o)) return serializeStream(o);
  return enc(serializeValue(o));
}

export function serializeValue(o: PdfObject): string {
  if (o === null) return 'null';
  if (typeof o === 'boolean') return o ? 'true' : 'false';
  if (typeof o === 'number') return String(o);
  if (isRef(o)) return `${o.num} ${o.gen} R`;
  if (isName(o)) return `/${escapeName(o.name)}`;
  if (isArray(o)) return `[${(o as PdfArray).map(serializeValue).join(' ')}]`;
  if (isDict(o)) return serializeDict(o);
  if ((o as any).kind === 'string') return serializeString((o as any).bytes);
  throw new Error('cannot serialize object');
}

export function serializeDict(d: PdfDict): string {
  let s = '<<';
  for (const [k, v] of d) s += ` /${escapeName(k)} ${serializeValue(v)}`;
  return s + ' >>';
}

function serializeStream(s: PdfStream): Uint8Array {
  const dict: PdfDict = new Map(s.dict);
  dict.set('Length', s.raw.length); // recompute to match verbatim payload
  const head = enc(serializeDict(dict) + '\nstream\n');
  const tail = enc('\nendstream');
  const out = new Uint8Array(head.length + s.raw.length + tail.length);
  out.set(head, 0); out.set(s.raw, head.length); out.set(tail, head.length + s.raw.length);
  return out;
}

export function escapeName(n: string): string {
  let out = '';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) out += '#' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

export function serializeString(bytes: Uint8Array): string {
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b === 10) s += '\\n';
    else if (b === 13) s += '\\r';
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}
```

- [ ] **Step 2: Replace `src/writer.ts` serialization with imports**

Change the top of `src/writer.ts` from:

```ts
import { PdfObject, PdfDict, PdfArray, PdfStream, isRef, isName, isDict, isArray, isStream } from './types.js';

const enc = (s: string) => new TextEncoder().encode(s);
```

to:

```ts
import { PdfObject, PdfDict, isDict } from './types.js';
import { enc, serializeObject } from './serialize.js';
```

Then delete these now-duplicated functions from `writer.ts` (they live in `serialize.ts` now): `serializeObject`, `serializeValue`, `serializeDict`, `serializeStream`, `escapeName`, `serializeString`. Keep `writeSinglePagePdf` unchanged — it already calls `enc(...)` and `serializeObject(...)`, which are now imported.

- [ ] **Step 3: Add `isString` guard to `src/types.ts`**

After the existing `isStream` export, add:

```ts
export const isString = (o: MaybeObj): o is PdfString => !!o && typeof o === 'object' && (o as any).kind === 'string';
```

- [ ] **Step 4: Run the existing suite to verify no regression**

Run: `npx vitest run`
Expected: PASS (all existing tests green, including `test/writer.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/serialize.ts src/writer.ts src/types.ts
git commit -m "refactor: extract PDF serialization into serialize.ts"
```

---

## Task 2: String codecs in `src/metadata.ts`

**Files:**
- Create: `src/metadata.ts`
- Test: `test/metadata.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/metadata.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodePdfText, decodePdfText } from '../src/metadata.js';

describe('pdf text codecs', () => {
  it('round-trips ASCII as latin1 (no BOM)', () => {
    const bytes = encodePdfText('Hello');
    expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111]);
    expect(decodePdfText(bytes)).toBe('Hello');
  });

  it('encodes non-ASCII as UTF-16BE with BOM and round-trips', () => {
    const bytes = encodePdfText('Café—Ω');
    expect(bytes[0]).toBe(0xfe);
    expect(bytes[1]).toBe(0xff);
    expect(decodePdfText(bytes)).toBe('Café—Ω');
  });

  it('decodes latin1 when no BOM present', () => {
    expect(decodePdfText(new Uint8Array([0x41, 0x42]))).toBe('AB');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/metadata.test.ts`
Expected: FAIL — cannot resolve `../src/metadata.js`.

- [ ] **Step 3: Create `src/metadata.ts` with the codecs**

```ts
/** Decode a PDF text-string's bytes: UTF-16BE when a FE FF BOM is present, else Latin1. */
export function decodePdfText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Encode a JS string for a PDF text string: Latin1 when pure ASCII, else UTF-16BE with FE FF BOM. */
export function encodePdfText(s: string): Uint8Array {
  let ascii = true;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) { ascii = false; break; }
  if (ascii) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xfe; out[1] = 0xff;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = (c >> 8) & 0xff;
    out[2 + i * 2 + 1] = c & 0xff;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metadata.ts test/metadata.test.ts
git commit -m "feat: PDF text string codecs (latin1/UTF-16BE)"
```

---

## Task 3: Date codecs in `src/metadata.ts`

**Files:**
- Modify: `src/metadata.ts`
- Test: `test/metadata.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/metadata.test.ts`:

```ts
import { formatPdfDate, parsePdfDate } from '../src/metadata.js';

describe('pdf date codecs', () => {
  it('formats a Date as a UTC PDF date string', () => {
    const d = new Date(Date.UTC(2024, 5, 3, 12, 30, 45)); // 2024-06-03T12:30:45Z
    expect(formatPdfDate(d)).toBe("D:20240603123045+00'00'");
  });

  it('parses a Z-suffixed PDF date to a Date', () => {
    const d = parsePdfDate('D:20240603123045Z');
    expect(d instanceof Date).toBe(true);
    expect((d as Date).toISOString()).toBe('2024-06-03T12:30:45.000Z');
  });

  it('parses an offset PDF date to the correct UTC instant', () => {
    const d = parsePdfDate("D:20240603123045+05'00'");
    expect((d as Date).toISOString()).toBe('2024-06-03T07:30:45.000Z');
  });

  it('returns the raw string when unparseable', () => {
    expect(parsePdfDate('not a date')).toBe('not a date');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/metadata.test.ts`
Expected: FAIL — `formatPdfDate`/`parsePdfDate` not exported.

- [ ] **Step 3: Add the date codecs to `src/metadata.ts`**

```ts
/** Format a Date as a PDF date string in UTC, e.g. D:20240603123045+00'00'. */
export function formatPdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}

/** Parse a PDF date string to a Date; returns the raw string when it can't be parsed. */
export function parsePdfDate(s: string): Date | string {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(s);
  if (!m) return s;
  const y = +m[1], mo = +(m[2] ?? '1'), d = +(m[3] ?? '1');
  const h = +(m[4] ?? '0'), mi = +(m[5] ?? '0'), se = +(m[6] ?? '0');
  let ms = Date.UTC(y, mo - 1, d, h, mi, se);
  if (m[8]) { // signed offset: wall-clock is local, so UTC = local - offset
    const offsetMin = (+m[9] * 60 + +(m[10] ?? '0')) * (m[8] === '-' ? -1 : 1);
    ms -= offsetMin * 60000;
  }
  const date = new Date(ms);
  return isNaN(date.getTime()) ? s : date;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metadata.ts test/metadata.test.ts
git commit -m "feat: PDF date parse/format codecs"
```

---

## Task 4: Metadata types + `/Info` mapping in `src/metadata.ts`

**Files:**
- Modify: `src/metadata.ts`
- Test: `test/metadata.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/metadata.test.ts`:

```ts
import { readMetadata, applyUpdate, MetadataUpdate } from '../src/metadata.js';
import { PdfDict, PdfObject, isString } from '../src/types.js';

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const identity = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);

describe('readMetadata', () => {
  it('maps standard keys to fields and others to custom', () => {
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', str('Hello')],
      ['Author', str('Ada')],
      ['CreationDate', str('D:20240603123045Z')],
      ['MyField', str('v1')],
    ]);
    const meta = readMetadata(info, identity);
    expect(meta.title).toBe('Hello');
    expect(meta.author).toBe('Ada');
    expect((meta.creationDate as Date).toISOString()).toBe('2024-06-03T12:30:45.000Z');
    expect(meta.custom).toEqual({ MyField: 'v1' });
  });

  it('returns empty metadata for undefined info', () => {
    expect(readMetadata(undefined, identity)).toEqual({ custom: {} });
  });
});

describe('applyUpdate', () => {
  it('merges set fields, leaves undefined, deletes on null', () => {
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', str('Old')],
      ['Author', str('Ada')],
    ]);
    const update: MetadataUpdate = { title: 'New', author: null, subject: undefined, custom: { K: 'V' } };
    applyUpdate(info, update);
    expect(isString(info.get('Title')) && decodeVal(info.get('Title'))).toBe('New');
    expect(info.has('Author')).toBe(false);
    expect(decodeVal(info.get('K'))).toBe('V');
  });

  it('formats a Date value for date fields', () => {
    const info: PdfDict = new Map<string, PdfObject>();
    applyUpdate(info, { creationDate: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)) });
    expect(decodeVal(info.get('CreationDate'))).toBe("D:20240102030405+00'00'");
  });
});

function decodeVal(o: PdfObject | undefined): string {
  if (!o || (o as any).kind !== 'string') return '';
  return new TextDecoder('latin1').decode((o as any).bytes);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/metadata.test.ts`
Expected: FAIL — `readMetadata`/`applyUpdate`/`MetadataUpdate` not exported.

- [ ] **Step 3: Add types and mapping to `src/metadata.ts`**

Add this import at the top of `src/metadata.ts`:

```ts
import { PdfDict, PdfObject, isString } from './types.js';
```

Add the types and functions:

```ts
export interface Metadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date | string;
  modDate?: Date | string;
  custom: Record<string, string>;
}

export interface MetadataUpdate {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
  producer?: string | null;
  creationDate?: Date | string | null;
  modDate?: Date | string | null;
  custom?: Record<string, string | null>;
}

/** [Metadata field, /Info key] pairs for the eight standard entries. */
const STANDARD_FIELDS: ReadonlyArray<readonly [keyof Metadata, string]> = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
  ['creationDate', 'CreationDate'],
  ['modDate', 'ModDate'],
];
const DATE_FIELDS = new Set<keyof Metadata>(['creationDate', 'modDate']);

/** Build a Metadata view of an /Info dict. `resolve` dereferences indirect values. */
export function readMetadata(
  info: PdfDict | undefined,
  resolve: (o: PdfObject | undefined) => PdfObject,
): Metadata {
  const meta: Metadata = { custom: {} };
  if (!info) return meta;
  const fieldByKey = new Map(STANDARD_FIELDS.map(([f, k]) => [k, f] as const));
  for (const [key, raw] of info) {
    const val = resolve(raw);
    if (!isString(val)) continue; // metadata values are text strings; ignore anything else
    const text = decodePdfText(val.bytes);
    const field = fieldByKey.get(key);
    if (field) {
      (meta as Record<string, unknown>)[field] = DATE_FIELDS.has(field) ? parsePdfDate(text) : text;
    } else {
      meta.custom[key] = text;
    }
  }
  return meta;
}

/** Merge an update into a working /Info dict in place: undefined leaves, null deletes, value sets. */
export function applyUpdate(info: PdfDict, update: MetadataUpdate): void {
  for (const [field, key] of STANDARD_FIELDS) {
    const v = (update as Record<string, string | Date | null | undefined>)[field];
    if (v === undefined) continue;
    if (v === null) { info.delete(key); continue; }
    const text = DATE_FIELDS.has(field) && v instanceof Date ? formatPdfDate(v) : String(v);
    info.set(key, { kind: 'string', bytes: encodePdfText(text) });
  }
  if (update.custom) {
    for (const [k, v] of Object.entries(update.custom)) {
      if (v === null) info.delete(k);
      else info.set(k, { kind: 'string', bytes: encodePdfText(v) });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metadata.ts test/metadata.test.ts
git commit -m "feat: /Info <-> Metadata mapping (read + merge update)"
```

---

## Task 5: `/Info` support in the `buildClassicPdf` test helper

**Files:**
- Modify: `test/helpers/build-pdf.ts`
- Test: `test/helpers/build-pdf.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `test/helpers/build-pdf.test.ts`:

```ts
import { Document } from '../../src/document.js';

describe('buildClassicPdf with /Info', () => {
  it('embeds an Info dict reachable from the trailer', () => {
    const pdf = buildClassicPdf(1, { info: { Title: 'Hi', Author: 'Ada' } });
    const doc = Document.open(pdf);
    const info = doc.resolve(doc.trailer.get('Info'));
    expect(info instanceof Map).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/helpers/build-pdf.test.ts`
Expected: FAIL — `buildClassicPdf` takes one argument; `/Info` not present.

- [ ] **Step 3: Add the `info` option to `buildClassicPdf`**

In `test/helpers/build-pdf.ts`, change the signature and Info/trailer handling. Replace:

```ts
export function buildClassicPdf(pageCount: number): Uint8Array {
```

with:

```ts
export function buildClassicPdf(pageCount: number, opts: { info?: Record<string, string> } = {}): Uint8Array {
```

After the line `const maxObj = 2 + pageCount * 2;` replace it with:

```ts
  let maxObj = 2 + pageCount * 2;
  let infoNum: number | undefined;
  if (opts.info) {
    infoNum = maxObj + 1;
    maxObj = infoNum;
    const body = Object.entries(opts.info)
      .map(([k, v]) => `/${k} (${v.replace(/([()\\])/g, '\\$1')})`)
      .join(' ');
    objects[infoNum] = `<< ${body} >>`;
  }
```

Then change the trailer line:

```ts
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
```

to:

```ts
  const infoEntry = infoNum ? ` /Info ${infoNum} 0 R` : '';
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R${infoEntry} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
```

(The offsets loop and `xref` generation already iterate `1..maxObj`, so the new Info object is included automatically.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/helpers/build-pdf.test.ts`
Expected: PASS (existing one-arg `buildClassicPdf(2)` test still green).

- [ ] **Step 5: Commit**

```bash
git add test/helpers/build-pdf.ts test/helpers/build-pdf.test.ts
git commit -m "test: add optional /Info dict to buildClassicPdf helper"
```

---

## Task 6: `Document` state + `getMetadata`

**Files:**
- Modify: `src/document.ts`
- Test: `test/document-metadata.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/document-metadata.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';

describe('Document.getMetadata', () => {
  it('reads standard and custom fields from /Info', () => {
    const pdf = buildClassicPdf(1, { info: { Title: 'Hi', Author: 'Ada', Custom1: 'X' } });
    const meta = Document.open(pdf).getMetadata();
    expect(meta.title).toBe('Hi');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ Custom1: 'X' });
  });

  it('returns empty metadata when there is no /Info', () => {
    const meta = Document.open(buildClassicPdf(1)).getMetadata();
    expect(meta).toEqual({ custom: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: FAIL — `getMetadata` is not a function.

- [ ] **Step 3: Add state + `getMetadata` to `src/document.ts`**

Add imports at the top of `src/document.ts`:

```ts
import { Metadata, MetadataUpdate, readMetadata, applyUpdate } from './metadata.js';
```

Add private fields inside the class (after the existing `objStmCache` field):

```ts
  private infoState: 'unchanged' | 'modified' | 'cleared' = 'unchanged';
  private infoWork?: PdfDict;
```

Add these methods to the class:

```ts
  /** Current /Info dict honoring pending edits: working copy, file dict, or none when cleared. */
  private currentInfo(): PdfDict | undefined {
    if (this.infoState === 'cleared') return undefined;
    if (this.infoState === 'modified') return this.infoWork;
    const info = this.resolve(this.trailer.get('Info'));
    return isDict(info) ? info : undefined;
  }

  getMetadata(): Metadata {
    return readMetadata(this.currentInfo(), (o) => this.resolve(o));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/document-metadata.test.ts
git commit -m "feat: Document.getMetadata"
```

---

## Task 7: `setMetadata` + `clearMetadata`

**Files:**
- Modify: `src/document.ts`
- Test: `test/document-metadata.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/document-metadata.test.ts`:

```ts
describe('Document.setMetadata / clearMetadata', () => {
  it('merges updates and preserves untouched fields', () => {
    const doc = Document.open(buildClassicPdf(1, { info: { Title: 'Old', Author: 'Ada' } }));
    doc.setMetadata({ title: 'New', custom: { K: 'V' } });
    const meta = doc.getMetadata();
    expect(meta.title).toBe('New');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ K: 'V' });
  });

  it('deletes a field when set to null', () => {
    const doc = Document.open(buildClassicPdf(1, { info: { Title: 'Old', Author: 'Ada' } }));
    doc.setMetadata({ author: null });
    expect(doc.getMetadata().author).toBeUndefined();
  });

  it('clearMetadata empties all metadata', () => {
    const doc = Document.open(buildClassicPdf(1, { info: { Title: 'Old' } }));
    doc.clearMetadata();
    expect(doc.getMetadata()).toEqual({ custom: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: FAIL — `setMetadata`/`clearMetadata` not functions.

- [ ] **Step 3: Add the methods to `src/document.ts`**

```ts
  /** Ensure infoWork holds an editable clone of the current /Info, switching to 'modified'. */
  private ensureInfoWork(): PdfDict {
    if (this.infoState !== 'modified' || !this.infoWork) {
      const base = this.infoState === 'cleared' ? null : this.resolve(this.trailer.get('Info'));
      this.infoWork = isDict(base) ? new Map(base) : new Map<string, PdfObject>();
      this.infoState = 'modified';
    }
    return this.infoWork;
  }

  setMetadata(update: MetadataUpdate): void {
    applyUpdate(this.ensureInfoWork(), update);
  }

  clearMetadata(): void {
    this.infoState = 'cleared';
    this.infoWork = undefined;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/document-metadata.test.ts
git commit -m "feat: Document.setMetadata (merge) and clearMetadata"
```

---

## Task 8: Incremental-update writer `src/incremental.ts`

**Files:**
- Create: `src/incremental.ts`
- Test: `test/incremental.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/incremental.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { appendIncremental } from '../src/incremental.js';
import { Document } from '../src/document.js';
import { ref, isDict, isString, PdfObject } from '../src/types.js';

describe('appendIncremental', () => {
  it('appends to the original bytes and re-parses with the new object', () => {
    const original = buildClassicPdf(1, { info: { Title: 'Old' } });
    const doc0 = Document.open(original);
    const infoRef = doc0.trailer.get('Info');
    expect(infoRef && (infoRef as any).kind === 'ref').toBe(true);
    const infoNum = (infoRef as any).num as number;

    const newInfo = new Map<string, PdfObject>([['Title', { kind: 'string', bytes: new TextEncoder().encode('New') }]]);
    const out = appendIncremental(original, {
      objects: new Map([[infoNum, newInfo]]),
      root: ref(1, 0),
      info: infoNum,
      size: 100,
    });

    // original is a byte-prefix of the output
    expect(out.subarray(0, original.length)).toEqual(original);

    const doc = Document.open(out);
    const info = doc.resolve(doc.trailer.get('Info'));
    expect(isDict(info)).toBe(true);
    const title = (info as Map<string, PdfObject>).get('Title');
    expect(isString(title) && new TextDecoder('latin1').decode((title as any).bytes)).toBe('New');
  });

  it('omits /Info from the trailer when info is null', () => {
    const original = buildClassicPdf(1, { info: { Title: 'Old' } });
    const out = appendIncremental(original, { objects: new Map(), root: ref(1, 0), info: null, size: 100 });
    const doc = Document.open(out);
    expect(doc.trailer.get('Info')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/incremental.test.ts`
Expected: FAIL — cannot resolve `../src/incremental.js`.

- [ ] **Step 3: Create `src/incremental.ts`**

```ts
import { PdfObject, PdfRef } from './types.js';
import { PdfParseError } from './errors.js';
import { enc, serializeObject, serializeValue } from './serialize.js';

export interface IncrementalOpts {
  /** Objects to (re)write in the appended section, keyed by object number (written as gen 0). */
  objects: Map<number, PdfObject>;
  /** /Root reference (preserved from the original trailer). */
  root: PdfRef;
  /** /Info: object number to reference, or null to omit /Info from the new trailer. */
  info: number | null;
  /** New /Size value (max object number + 1). */
  size: number;
  /** Original trailer /ID, preserved when provided. */
  id?: PdfObject;
}

/** Append an incremental-update section to `original`, returning the new full PDF bytes. */
export function appendIncremental(original: Uint8Array, opts: IncrementalOpts): Uint8Array {
  const prev = readStartxref(original);
  const chunks: Uint8Array[] = [];
  let length = original.length;
  const push = (b: Uint8Array) => { chunks.push(b); length += b.length; };

  // Start the appended section on a fresh line.
  if (original.length > 0 && original[original.length - 1] !== 0x0a) push(enc('\n'));

  const nums = [...opts.objects.keys()].sort((a, b) => a - b);
  const offsets = new Map<number, number>();
  for (const n of nums) {
    offsets.set(n, length);
    push(enc(`${n} 0 obj\n`));
    push(serializeObject(opts.objects.get(n)!));
    push(enc('\nendobj\n'));
  }

  const xrefStart = length;
  let xref = 'xref\n0 1\n0000000000 65535 f \n';
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    xref += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) xref += `${String(offsets.get(nums[k])!).padStart(10, '0')} 00000 n \n`;
    i = j + 1;
  }
  push(enc(xref));

  let trailer = `trailer\n<< /Size ${opts.size} /Root ${opts.root.num} ${opts.root.gen} R /Prev ${prev}`;
  if (opts.info !== null) trailer += ` /Info ${opts.info} 0 R`;
  if (opts.id !== undefined) trailer += ` /ID ${serializeValue(opts.id)}`;
  trailer += ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(enc(trailer));

  const out = new Uint8Array(length);
  out.set(original, 0);
  let p = original.length;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function readStartxref(buf: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)));
  const idx = tail.lastIndexOf('startxref');
  if (idx < 0) throw new PdfParseError('startxref not found');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new PdfParseError('malformed startxref');
  return parseInt(m[1], 10);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/incremental.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/incremental.ts test/incremental.test.ts
git commit -m "feat: incremental-update PDF writer"
```

---

## Task 9: `Document.save()`

**Files:**
- Modify: `src/document.ts`
- Test: `test/document-metadata.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `test/document-metadata.test.ts`:

```ts
describe('Document.save', () => {
  it('returns original bytes verbatim when nothing changed', () => {
    const pdf = buildClassicPdf(1, { info: { Title: 'X' } });
    const out = Document.open(pdf).save();
    expect(out).toEqual(pdf);
  });

  it('round-trips a metadata edit through save + open', () => {
    const pdf = buildClassicPdf(1, { info: { Title: 'Old', Author: 'Ada' } });
    const doc = Document.open(pdf);
    doc.setMetadata({ title: 'New', custom: { Tag: 'T1' } });
    const out = doc.save();
    expect(out.subarray(0, pdf.length)).toEqual(pdf); // incremental: original preserved

    const meta = Document.open(out).getMetadata();
    expect(meta.title).toBe('New');
    expect(meta.author).toBe('Ada');
    expect(meta.custom).toEqual({ Tag: 'T1' });
  });

  it('round-trips a non-ASCII value', () => {
    const doc = Document.open(buildClassicPdf(1, { info: { Title: 'X' } }));
    doc.setMetadata({ title: 'Café—Ω' });
    expect(Document.open(doc.save()).getMetadata().title).toBe('Café—Ω');
  });

  it('clearMetadata + save yields a document with no metadata', () => {
    const doc = Document.open(buildClassicPdf(1, { info: { Title: 'X' } }));
    doc.clearMetadata();
    expect(Document.open(doc.save()).getMetadata()).toEqual({ custom: {} });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: FAIL — `save` is not a function.

- [ ] **Step 3: Add `save()` to `src/document.ts`**

Add the import for the incremental writer at the top of `src/document.ts`:

```ts
import { appendIncremental } from './incremental.js';
```

(`isRef`, `isDict`, `PdfObject`, and `PdfDict` are already imported in `document.ts:5` — do not re-import them.)

Add the method:

```ts
  /** Serialize the document, applying pending metadata edits via an incremental update. */
  save(): Uint8Array {
    if (this.infoState === 'unchanged') return this.buf;

    const root = this.trailer.get('Root');
    if (!isRef(root)) throw new PdfParseError('cannot save: /Root is not an indirect reference');
    const id = this.trailer.get('ID');

    let maxObjNum = 0;
    for (const n of this.entries.keys()) if (n > maxObjNum) maxObjNum = n;

    if (this.infoState === 'cleared') {
      return appendIncremental(this.buf, { objects: new Map(), root, info: null, size: maxObjNum + 1, id });
    }

    const existingInfo = this.trailer.get('Info');
    let infoNum: number;
    if (isRef(existingInfo)) {
      infoNum = existingInfo.num;
    } else {
      infoNum = maxObjNum + 1;
      maxObjNum = infoNum;
    }
    const objects = new Map<number, PdfObject>([[infoNum, this.infoWork ?? new Map<string, PdfObject>()]]);
    return appendIncremental(this.buf, { objects, root, info: infoNum, size: maxObjNum + 1, id });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/document-metadata.test.ts
git commit -m "feat: Document.save via incremental update"
```

---

## Task 10: Public exports

**Files:**
- Modify: `src/index.ts`
- Test: `test/document-metadata.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `test/document-metadata.test.ts`:

```ts
import * as api from '../src/index.js';

describe('public API exports', () => {
  it('exposes Document from the index', () => {
    expect(typeof (api as any).Document).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: FAIL — `api.Document` is undefined.

- [ ] **Step 3: Add exports to `src/index.ts`**

Append:

```ts
export { Document } from './document.js';
export type { Metadata, MetadataUpdate } from './metadata.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/document-metadata.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/document-metadata.test.ts
git commit -m "feat: export Document and metadata types from index"
```

---

## Task 11: Full verification + close issue

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: completes without errors.

- [ ] **Step 4: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-w98 --reason="Metadata get/set/clear + incremental save implemented with tests"
git pull --rebase
git push
git status   # must show up to date with origin
```

---

## Notes for the implementer

- ESM import paths use the `.js` extension even for `.ts` sources (NodeNext). Follow the existing convention.
- Generation numbers: the incremental writer always writes objects as generation 0 and references `/Info <num> 0 R`. This is correct for the common case where `/Info` is gen 0 or newly allocated; do not add generation handling unless a fixture requires it (YAGNI).
- The degenerate `xref\n0 1\n0000000000 65535 f \n` head with no further subsections (the `cleared` case) is intentional and parses via `readClassicTable`, which loops subsections until `trailer`.
- `readMetadata` ignores non-string `/Info` values rather than throwing; metadata values are always text strings in practice.
