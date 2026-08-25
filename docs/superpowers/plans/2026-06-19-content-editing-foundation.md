# Content-Editing Foundation (F1 + F2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared content-editing foundation for Phase 4 — an editable per-stream op model with Form-XObject copy-on-write (F1), and a provenance-carrying content walk that maps page-space rectangles to the glyphs/images that occupy them (F2).

**Architecture:** F1 (`editcontent.ts`) wraps a page's `/Contents` as per-stream `ContentOp[]` lists, lets callers replace a stream's ops or copy-on-write an XObject's ops, and commits edits into fresh page-owned stream objects. F2 refactors `text.ts`'s content walker into a reusable visitor that threads the existing CTM/text-state machine across streams and into XObjects, emitting `glyph` and `image` events tagged with a `ContentAddr` (the F1 address). `extractText` becomes a consumer of that visitor; a second consumer, `mapRegions`, returns the events intersecting given rectangles.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

**Spec:** `docs/superpowers/specs/2026-06-19-redaction-editing-design.md` (Foundation section). **Beads:** epic `aspose-pdf-foss-for-ts-638`; Tasks 1–3 deliver child `638.2` (F1), Tasks 4–7 deliver child `638.3` (F2).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins (`zlib`/`crypto`/`fs`). No npm runtime deps.
- ESM + NodeNext, `strict` TypeScript; every import specifier carries a `.js` extension.
- Live-mutation model: edits act on the live object map; `Save()` renumbers reachable objects and never mutates inputs. Never mutate a possibly-shared input stream — allocate a new object for edited content.
- TDD: each unit lands with a failing vitest test first, then minimal code; fixtures are built programmatically by `test/helpers/` builders.
- Errors are the public types in `src/errors.ts` (`PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`); arg/shape validation throws `TypeError`.
- Run `npm run typecheck` and `npm test` green before considering a task done; target one file with `npx vitest run test/<name>.test.ts`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Shared types (defined in Task 1, consumed throughout)

```ts
// src/editcontent.ts
/** Address of an operator within a page's content. */
export interface ContentAddr {
  /** XObject resource-name chain descended from the page; [] = top-level page content. */
  readonly path: readonly string[];
  /** Index into the page's /Contents array. Always 0 when path is non-empty (an XObject has one stream). */
  readonly streamIndex: number;
  /** Index of the operator within that parsed stream. */
  readonly opIndex: number;
}
```

## File Structure

| File | New? | Responsibility |
|---|---|---|
| `src/editcontent.ts` | new | `EditableContent` + `ContentAddr`: per-stream op model, XObject COW, commit |
| `src/font.ts` | modify | add `TextFont.decodeGlyphs` (per-code records: text, em-width, byte span, word-space flag) |
| `src/text.ts` | modify | refactor `walk` into a `visitContent` visitor emitting glyph/image events with `ContentAddr`; reimplement `extractText` as a consumer; add `mapRegions` |
| `src/index.ts` | modify | export `EditableContent`, `ContentAddr`, and the F2 region API |
| `test/editcontent.test.ts` | new | F1 tests |
| `test/font-glyphs.test.ts` | new | `decodeGlyphs` tests |
| `test/content-map.test.ts` | new | F2 visitor + `mapRegions` tests |
| `test/helpers/build-edit-pdf.ts` | new | fixtures: multi-stream page, page with a (shared) Form XObject drawing text |

---

### Task 1: F1 — read content as per-stream op lists

**Files:**
- Create: `src/editcontent.ts`
- Create: `test/helpers/build-edit-pdf.ts`
- Test: `test/editcontent.test.ts`

**Interfaces:**
- Consumes: `Document` (`src/document.ts`), `Page` (`src/page.ts`), `parseContentStream` (`src/content.ts`), `inflateStream` (`src/flate.ts`), type guards from `src/types.ts`.
- Produces:
  - `interface ContentAddr` (above).
  - `class EditableContent { constructor(doc: Document, page: Page); readonly streamCount: number; topOps(streamIndex: number): readonly ContentOp[]; }`

- [ ] **Step 1: Add the multi-stream fixture helper**

Create `test/helpers/build-edit-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function serialize(objects: Record<number, string>, maxObj: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(s: string): string {
  return `<< /Length ${byteLen(s)} >>\nstream\n${s}\nendstream`;
}

/** One page whose /Contents is an array of the given streams, with a Helvetica /F1. */
export function buildMultiStreamPage(streams: string[]): Uint8Array {
  const refs = streams.map((_, i) => `${5 + i} 0 R`).join(' ');
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents [${refs}] >>`,
    4: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  };
  streams.forEach((s, i) => { objects[5 + i] = streamObj(s); });
  return serialize(objects, 4 + streams.length);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/editcontent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EditableContent } from '../src/editcontent.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

describe('EditableContent — read', () => {
  it('exposes each /Contents stream as its own op list', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 12 Tf 72 144 Td (Hi) Tj ET',
      '1 0 0 RG 10 10 m 20 20 l S',
    ]));
    const ec = new EditableContent(doc, doc.Pages[0]);
    expect(ec.streamCount).toBe(2);
    expect(ec.topOps(0).map((o) => o.operator)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'ET']);
    expect(ec.topOps(1).map((o) => o.operator)).toEqual(['RG', 'm', 'l', 'S']);
  });

  it('reports zero streams for a page with no /Contents', () => {
    const doc = Document.Open(buildMultiStreamPage([]));
    const ec = new EditableContent(doc, doc.Pages[0]);
    expect(ec.streamCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/editcontent.test.ts`
Expected: FAIL — cannot find module `../src/editcontent.js`.

- [ ] **Step 4: Write minimal implementation**

Create `src/editcontent.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfObject, PdfStream, isArray, isStream, isRef } from './types.js';
import { ContentOp, parseContentStream } from './content.js';
import { inflateStream } from './flate.js';

/** Address of an operator within a page's content. */
export interface ContentAddr {
  readonly path: readonly string[];
  readonly streamIndex: number;
  readonly opIndex: number;
}

/** The resolved stream objects of a page's /Contents, in order. */
function contentStreams(doc: Document, page: Page): PdfStream[] {
  const c = doc.resolve(page.Dict.get('Contents'));
  const out: PdfStream[] = [];
  if (isStream(c)) out.push(c);
  else if (isArray(c)) for (const e of c) { const s = doc.resolve(e); if (isStream(s)) out.push(s); }
  return out;
}

/** Editable per-stream view of a page's content (Phase 4 foundation, F1). */
export class EditableContent {
  private readonly doc: Document;
  private readonly page: Page;
  private readonly streams: PdfStream[];
  private readonly parsed: (ContentOp[] | undefined)[]; // lazily parsed per stream

  constructor(doc: Document, page: Page) {
    this.doc = doc;
    this.page = page;
    this.streams = contentStreams(doc, page);
    this.parsed = new Array(this.streams.length).fill(undefined);
  }

  get streamCount(): number { return this.streams.length; }

  topOps(streamIndex: number): readonly ContentOp[] {
    const cached = this.parsed[streamIndex];
    if (cached) return cached;
    const s = this.streams[streamIndex];
    if (!s) throw new RangeError(`no content stream at index ${streamIndex}`);
    const ops = parseContentStream(inflateStream(s));
    this.parsed[streamIndex] = ops;
    return ops;
  }
}
```

Note: `isRef`/`PdfObject` are imported for use in later tasks; if the linter flags them as unused now, keep only what this task references and re-add in Task 2.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/editcontent.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/editcontent.ts test/editcontent.test.ts test/helpers/build-edit-pdf.ts
git commit -m "feat(638.2): EditableContent reads /Contents as per-stream op lists

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: F1 — edit top-level streams and commit

**Files:**
- Modify: `src/editcontent.ts`
- Test: `test/editcontent.test.ts`

**Interfaces:**
- Consumes: `serializeContentStream` (`src/content.ts`), `Document.allocObject` (returns `PdfRef`), `streamOf` (`src/pagecontent.ts`).
- Produces:
  - `EditableContent.setTopOps(streamIndex: number, ops: ContentOp[]): void`
  - `EditableContent.commit(): void` — writes modified streams into fresh page-owned stream objects and rebuilds `/Contents`.

- [ ] **Step 1: Write the failing test**

Append to `test/editcontent.test.ts`:

```ts
import { serializeContentStream } from '../src/content.js';

describe('EditableContent — edit + commit', () => {
  it('replaces a stream\'s ops and writes them back into /Contents', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 12 Tf 72 144 Td (secret) Tj ET',
    ]));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    const ops = ec.topOps(0).filter((o) => o.operator !== 'Tj'); // drop the show op
    ec.setTopOps(0, ops);
    ec.commit();

    const reopened = Document.Open(doc.Save());
    const text = new TextDecoder().decode(reopened.Pages[0].Contents);
    expect(text).not.toContain('secret');
    expect(text).toContain('Td'); // surrounding ops preserved
  });

  it('leaves unmodified streams untouched', () => {
    const doc = Document.Open(buildMultiStreamPage(['(a) Tj', '(b) Tj']));
    const page = doc.Pages[0];
    const before = page.Dict.get('Contents');
    const ec = new EditableContent(doc, page);
    ec.commit(); // no edits
    expect(page.Dict.get('Contents')).toBe(before); // identical reference: nothing rewritten
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/editcontent.test.ts`
Expected: FAIL — `setTopOps`/`commit` are not functions.

- [ ] **Step 3: Write minimal implementation**

In `src/editcontent.ts`, add a `dirty` set and the two methods. Import additions at top:

```ts
import { ContentOp, parseContentStream, serializeContentStream } from './content.js';
import { streamOf } from './pagecontent.js';
import { PdfRef } from './types.js';
```

Add a field and methods to the class:

```ts
  private readonly dirty = new Set<number>();

  setTopOps(streamIndex: number, ops: ContentOp[]): void {
    if (streamIndex < 0 || streamIndex >= this.streams.length)
      throw new RangeError(`no content stream at index ${streamIndex}`);
    this.parsed[streamIndex] = ops.slice();
    this.dirty.add(streamIndex);
  }

  commit(): void {
    if (this.dirty.size === 0) return;
    // Resolve the current /Contents to an ordered list of refs (one per stream).
    const refs = this.contentRefs();
    for (const i of this.dirty) {
      const bytes = serializeContentStream(this.parsed[i]!);
      refs[i] = this.doc.allocObject(streamOf(bytes)); // fresh page-owned object
    }
    this.page.Dict.set('Contents', refs);
    this.dirty.clear();
  }

  /** Current /Contents as a stream-ref array aligned with `this.streams`. */
  private contentRefs(): PdfRef[] {
    const c = this.page.Dict.get('Contents');
    const out: PdfRef[] = [];
    if (isRef(c)) out.push(c);
    else if (isArray(c)) for (const e of c) if (isRef(e)) out.push(e);
    return out;
  }
```

The second test (no edits → identical reference) passes because `commit()` returns early when nothing is dirty.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/editcontent.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npx vitest run test/editcontent.test.ts`
Expected: no type errors; all pass.

- [ ] **Step 6: Commit**

```bash
git add src/editcontent.ts test/editcontent.test.ts
git commit -m "feat(638.2): EditableContent.setTopOps + commit (page-owned write-back)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: F1 — copy-on-write a Form XObject's ops

**Files:**
- Modify: `src/editcontent.ts`
- Modify: `test/helpers/build-edit-pdf.ts`
- Test: `test/editcontent.test.ts`

**Interfaces:**
- Consumes: `ensureOwnResources`, `ensureOwnSubdict` (`src/pagecontent.ts`), `name`/`isName`/`isDict` (`src/types.ts`).
- Produces:
  - `EditableContent.xobjectOps(path: readonly string[]): readonly ContentOp[]` — clones each XObject along `path` on first access (COW), repointing the page's own resources to the clones; returns the deepest XObject's ops.
  - `EditableContent.setXobjectOps(path: readonly string[], ops: ContentOp[]): void`
  - `commit()` also writes back COW'd XObject streams.

- [ ] **Step 1: Add a shared-XObject fixture**

Append to `test/helpers/build-edit-pdf.ts`:

```ts
/** Two pages that both draw the SAME Form XObject /Fm0, which shows text via /F1.
 *  Proves copy-on-write isolation: editing page 1 must not change page 2. */
export function buildSharedXObjectPages(): Uint8Array {
  const fm = 'BT /F1 12 Tf 0 0 Td (shared) Tj ET';
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`,
    4: `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm0 6 0 R >> >> /Contents 5 0 R >>`,
    5: streamObj('q 1 0 0 1 50 50 cm /Fm0 Do Q'),
    6: `<< /Type /XObject /Subtype /Form /BBox [0 0 100 20] ` +
       `/Resources << /Font << /F1 7 0 R >> >> /Length ${byteLenOf(fm)} >>\nstream\n${fm}\nendstream`,
    7: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  };
  return serialize(objects, 7);
}

function byteLenOf(s: string): number { return new TextEncoder().encode(s).length; }
```

(`byteLenOf` mirrors the file's existing `byteLen`; reuse `byteLen` if already in scope.)

- [ ] **Step 2: Write the failing test**

Append to `test/editcontent.test.ts`:

```ts
import { buildSharedXObjectPages } from './helpers/build-edit-pdf.js';

describe('EditableContent — XObject copy-on-write', () => {
  it('edits a shared Form XObject for one page without touching the other', () => {
    const doc = Document.Open(buildSharedXObjectPages());
    const ec = new EditableContent(doc, doc.Pages[0]);

    const ops = ec.xobjectOps(['Fm0']).filter((o) => o.operator !== 'Tj');
    ec.setXobjectOps(['Fm0'], ops);
    ec.commit();

    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('shared'); // edited page
    expect(re.Pages[1].GetText()).toContain('shared');      // untouched page
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/editcontent.test.ts -t "copy-on-write"`
Expected: FAIL — `xobjectOps` is not a function.

- [ ] **Step 4: Write minimal implementation**

In `src/editcontent.ts` add imports and the COW machinery:

```ts
import { ensureOwnResources, ensureOwnSubdict, streamOf } from './pagecontent.js';
import { PdfDict, PdfStream, isDict, isName, name } from './types.js';
```

Add a map of COW'd XObject edits keyed by the joined path, plus the methods:

```ts
  // path.join('\0') -> { stream: the page-owned clone, ops: parsed/edited ops, dirty }
  private readonly xobj = new Map<string, { stream: PdfStream; ops: ContentOp[]; dirty: boolean }>();

  xobjectOps(path: readonly string[]): readonly ContentOp[] {
    return this.cowXObject(path).ops;
  }

  setXobjectOps(path: readonly string[], ops: ContentOp[]): void {
    const e = this.cowXObject(path);
    e.ops = ops.slice();
    e.dirty = true;
  }

  /** Clone each XObject along `path` (once), repointing the page's own resources,
   *  and return the deepest clone's parsed-op entry. */
  private cowXObject(path: readonly string[]): { stream: PdfStream; ops: ContentOp[]; dirty: boolean } {
    const key = path.join('\0');
    const hit = this.xobj.get(key);
    if (hit) return hit;
    if (path.length === 0) throw new RangeError('xobjectOps requires a non-empty path');

    // Walk the resource chain from the page, cloning each level.
    let resources: PdfDict = ensureOwnResources(this.doc, this.page);
    let clone: PdfStream | undefined;
    for (const nm of path) {
      const xobjDict = ensureOwnSubdict(this.doc, resources, 'XObject');
      const cur = this.doc.resolve(xobjDict.get(nm));
      if (!isStream(cur)) throw new RangeError(`XObject /${nm} not found`);
      // Clone the stream (shallow dict copy + shared raw bytes) and repoint the name.
      const cloned: PdfStream = { kind: 'stream', dict: new Map(cur.dict), raw: cur.raw };
      xobjDict.set(nm, this.doc.allocObject(cloned));
      clone = cloned;
      const childRes = this.doc.resolve(cloned.dict.get('Resources'));
      if (isDict(childRes)) { const copy = new Map(childRes); cloned.dict.set('Resources', copy); resources = copy; }
      else resources = new Map();
    }
    const entry = { stream: clone!, ops: parseContentStream(inflateStream(clone!)), dirty: false };
    this.xobj.set(key, entry);
    return entry;
  }
```

Extend `commit()` to flush XObject edits (before the early-return guard is reached, account for them):

```ts
  commit(): void {
    // Flush COW'd XObject streams.
    for (const e of this.xobj.values()) {
      if (!e.dirty) continue;
      e.stream.raw = serializeContentStream(e.ops);
      e.stream.dict.delete('Filter');        // we wrote raw (uncompressed) bytes
      e.stream.dict.set('Length', e.stream.raw.length);
      e.dirty = false;
    }
    // Flush top-level streams.
    if (this.dirty.size > 0) {
      const refs = this.contentRefs();
      for (const i of this.dirty) {
        const bytes = serializeContentStream(this.parsed[i]!);
        refs[i] = this.doc.allocObject(streamOf(bytes));
      }
      this.page.Dict.set('Contents', refs);
      this.dirty.clear();
    }
  }
```

Note: the clone's `/Length`/`/Filter` are rewritten because we replace `raw` with freshly serialized, uncompressed bytes. `name`/`isName` are imported for use by F2 consumers in later tasks; remove from this task's imports if the linter flags them as unused and re-add in Task 7.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/editcontent.test.ts`
Expected: PASS (5 tests). The page-2 assertion confirms COW isolation.

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: no type errors; entire suite green (no regressions).

- [ ] **Step 7: Commit**

```bash
git add src/editcontent.ts test/editcontent.test.ts test/helpers/build-edit-pdf.ts
git commit -m "feat(638.2): EditableContent XObject copy-on-write + commit flush

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: F2 — per-glyph decode on TextFont

**Files:**
- Modify: `src/font.ts`
- Test: `test/font-glyphs.test.ts`

**Interfaces:**
- Consumes: existing `TextFont` internals (`codeWidth`, `simple`, `toUnicode`, width lookup).
- Produces:
  - `interface Glyph { text: string; width: number; byteStart: number; byteLen: number; isWordSpace: boolean; }`
  - `TextFont.decodeGlyphs(bytes: Uint8Array): Glyph[]` — one record per character code, `width` in em units (glyph-space/1000), excluding Tc/Tw.

- [ ] **Step 1: Write the failing test**

Create `test/font-glyphs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { TextFont } from '../src/font.js';
import { inflateStream } from '../src/flate.js';
import { isDict, isStream } from '../src/types.js';
import { buildSimpleTextPdfWithWidths } from './helpers/build-text-pdf.js';

function fontOf(doc: Document): TextFont {
  const res = doc.Pages[0].Resources!;
  const fonts = doc.resolve(res.get('Font')) as Map<string, any>;
  const fd = doc.resolve(fonts.get('F1'));
  if (!isDict(fd)) throw new Error('no font');
  return new TextFont(fd, (o) => doc.resolve(o), (s) => inflateStream(s as any));
}

describe('TextFont.decodeGlyphs', () => {
  it('emits one record per code with byte spans and em widths', () => {
    // 'AB' = codes 65,66; widths give A=500, B=750 (firstChar 65).
    const doc = Document.Open(buildSimpleTextPdfWithWidths('BT (AB) Tj ET', 65, [500, 750]));
    const glyphs = fontOf(doc).decodeGlyphs(new TextEncoder().encode('AB'));
    expect(glyphs.map((g) => g.text)).toEqual(['A', 'B']);
    expect(glyphs.map((g) => g.byteStart)).toEqual([0, 1]);
    expect(glyphs.map((g) => g.byteLen)).toEqual([1, 1]);
    expect(glyphs.map((g) => g.width)).toEqual([0.5, 0.75]);
  });

  it('flags the space code as a word space', () => {
    const doc = Document.Open(buildSimpleTextPdfWithWidths('BT (A B) Tj ET', 32, []));
    const glyphs = fontOf(doc).decodeGlyphs(new TextEncoder().encode('A B'));
    expect(glyphs.map((g) => g.isWordSpace)).toEqual([false, true, false]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-glyphs.test.ts`
Expected: FAIL — `decodeGlyphs` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/font.ts`, add the exported `Glyph` interface above the class and a method on `TextFont` that mirrors `decodeRun`'s per-code loop but records each glyph:

```ts
export interface Glyph {
  text: string;
  width: number;       // em units (glyph-space / 1000), excluding Tc/Tw
  byteStart: number;   // offset of this code within the show string
  byteLen: number;     // bytes consumed (codeWidth)
  isWordSpace: boolean;
}
```

```ts
  /** Decode bytes into one record per character code (positions, em-widths). */
  decodeGlyphs(bytes: Uint8Array): Glyph[] {
    const out: Glyph[] = [];
    const w = this.codeWidth;
    for (let i = 0; i + w <= bytes.length || (w === 1 && i < bytes.length); i += w) {
      let code = 0;
      for (let k = 0; k < w; k++) code = (code << 8) | (bytes[i + k] ?? 0);
      let text = '';
      const u = this.toUnicode?.lookup(code);
      if (u !== undefined) text = u;
      else if (!this.isType0 && this.simple) { const s = this.simple[code & 0xff]; if (s !== undefined) text = s; }
      const width = this.hasWidths ? (this.widths?.get(code) ?? this.defaultWidth) / 1000 : 0.5;
      out.push({ text, width, byteStart: i, byteLen: w, isWordSpace: w === 1 && code === 0x20 });
    }
    return out;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/font-glyphs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Regression — existing text tests still pass**

Run: `npx vitest run test/text.test.ts test/font.test.ts`
Expected: PASS (no behavior change to `decodeRun`).

- [ ] **Step 6: Commit**

```bash
git add src/font.ts test/font-glyphs.test.ts
git commit -m "feat(638.3): TextFont.decodeGlyphs — per-glyph positions and widths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: F2 — refactor the walker into a glyph-emitting visitor

**Files:**
- Modify: `src/text.ts`
- Test: `test/content-map.test.ts`

This task changes how `extractText` is implemented **without changing its output**. The gate is that the entire existing `test/text.test.ts` stays green.

**Interfaces:**
- Consumes: `EditableContent`-style addressing via `ContentAddr` (`src/editcontent.ts`), `TextFont.decodeGlyphs` (Task 4), the existing matrix helpers in `text.ts`.
- Produces:
  - `interface GlyphEvent { addr: ContentAddr; quad: [number, number, number, number]; text: string; }` — `quad` = device-space `[x0, y0, x1, y1]` baseline box of the glyph (x0/x1 from the advancing pen, y0/y1 from baseline + effective font size).
  - `function visitContent(doc: Document, page: Page, visitor: { glyph?(e: GlyphEvent): void }): void` — walks each content stream of the page in order (threading state across them) and into Form XObjects, tagging events with `ContentAddr`.
  - `extractText(doc, page): string` is reimplemented to call `visitContent` and assemble glyph events into the existing line output.

- [ ] **Step 1: Write the failing test (provenance + position)**

Create `test/content-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, GlyphEvent } from '../src/text.js';
import { buildMultiStreamPage, buildSharedXObjectPages } from './helpers/build-edit-pdf.js';

function collect(doc: Document, pageIndex = 0): GlyphEvent[] {
  const events: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[pageIndex], { glyph: (e) => events.push(e) });
  return events;
}

describe('visitContent — glyph provenance', () => {
  it('tags each glyph with its stream + op index and device position', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 72 100 Td (Hi) Tj ET']));
    const events = collect(doc);
    expect(events.map((e) => e.text).join('')).toBe('Hi');
    expect(events[0].addr).toEqual({ path: [], streamIndex: 0, opIndex: 3 }); // the Tj op
    expect(events[0].quad[0]).toBeCloseTo(72, 1);   // pen x at start
    expect(events[0].quad[1]).toBeCloseTo(100, 1);  // baseline y
    expect(events[1].quad[0]).toBeGreaterThan(events[0].quad[0]); // H advances before i
  });

  it('descends into a Form XObject and records the path', () => {
    const doc = Document.Open(buildSharedXObjectPages());
    const events = collect(doc);
    expect(events.map((e) => e.text).join('')).toBe('shared');
    expect(events[0].addr.path).toEqual(['Fm0']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/content-map.test.ts`
Expected: FAIL — `visitContent`/`GlyphEvent` not exported from `text.ts`.

- [ ] **Step 3: Refactor `text.ts`**

Add the event type and a visitor that mirrors the existing `walk` state machine but (a) parses each content stream separately while threading state, (b) carries a `ContentAddr` path/streamIndex/opIndex, and (c) emits a `GlyphEvent` per glyph using `decodeGlyphs`. Reimplement `extractText` on top of it.

Concretely:

```ts
import type { ContentAddr } from './editcontent.js';

export interface GlyphEvent {
  addr: ContentAddr;
  quad: [number, number, number, number]; // device-space [x0,y0,x1,y1]
  text: string;
}

export interface ContentVisitor { glyph?(e: GlyphEvent): void; }

export function visitContent(doc: Document, page: Page, visitor: ContentVisitor): void {
  const fontCache = new Map<PdfDict, TextFont>();
  const streams = contentStreamBytes(doc, page);            // Uint8Array[] in /Contents order
  const st = newState();
  const ctmStack: Matrix[] = [];
  let curCtm: Matrix = IDENTITY;
  // State (st, curCtm, ctmStack) threads across streams: build one shared walker context.
  for (let si = 0; si < streams.length; si++) {
    visitStream(doc, streams[si], page.Resources, { path: [], streamIndex: si },
      { st, ctmStack, getCtm: () => curCtm, setCtm: (m) => { curCtm = m; } },
      visitor, fontCache, 0, new Set());
  }
}
```

Where `visitStream` is the per-stream loop adapted from the current `walk`'s `switch`, with these changes:

- It iterates `parseContentStream(bytes)` with the op index `oi`; on `Tj`/`TJ`/`'`/`"` it calls `emitGlyphs(...)` instead of `show`/`showArray`.
- `emitGlyphs` decodes the show string with `st.font.decodeGlyphs(bytes)`, and for each glyph computes its device quad from the current text matrix (start pen) and the advance after that glyph (end pen), exactly as `emitRunBetween` does for whole runs — then advances `st.tm`. For a `TJ` array it walks elements, applying numeric shifts between strings and setting `addr.opIndex = oi`, `elementIndex` carried internally (not needed by `GlyphEvent`, but used in Task 7's hit grouping via byteRange; keep `opIndex` only on `GlyphEvent`).
- On `Do` into a Form XObject, recurse with `addr = { path: [...path, nm], streamIndex: 0 }` over the XObject's single inflated stream, sharing the same `st`/ctm context (push/pop CTM like today).

Then reimplement `extractText`:

```ts
export function extractText(doc: Document, page: Page): string {
  const runs: Run[] = [];
  visitContent(doc, page, {
    glyph: (e) => {
      if (!e.text) return;
      runs.push({ x: e.quad[0], endX: e.quad[2], y: e.quad[1], text: e.text, size: e.quad[3] - e.quad[1] });
    },
  });
  return assembleLines(runs);
}
```

Add a `contentStreamBytes(doc, page): Uint8Array[]` helper returning each `/Contents` stream inflated separately (mirror `EditableContent`'s `contentStreams` + `inflateStream`). Keep the existing exported helpers (`mul`, `apply`, etc.) unchanged.

> Implementation note: extract a small `runFromGlyphs` so the per-glyph quad math is shared with `emitRunBetween`; do not duplicate the matrix algebra. The y-extent of `quad` uses `st.rise` for `y0` and `rise + fontSize*vscale` for `y1`, so `size = y1 - y0` reproduces today's run `size`.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run test/content-map.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Regression gate — extraction output unchanged**

Run: `npx vitest run test/text.test.ts`
Expected: PASS — every existing extraction test still green. If any fail, the refactor changed observable output; fix `extractText`/`emitGlyphs` until green before continuing.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Note: `text.ts` now imports a type from `editcontent.ts`; ensure no circular runtime import — `ContentAddr` is a type-only import, so use `import type`.)

- [ ] **Step 7: Commit**

```bash
git add src/text.ts test/content-map.test.ts
git commit -m "refactor(638.3): text walker -> visitContent glyph events; extractText consumes it

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: F2 — emit image-placement events

**Files:**
- Modify: `src/text.ts`
- Test: `test/content-map.test.ts`

**Interfaces:**
- Produces:
  - `interface ImageEvent { addr: ContentAddr; quad: [number, number, number, number]; kind: 'xobject' | 'inline'; }`
  - `ContentVisitor` gains `image?(e: ImageEvent): void`.
  - Image-XObject `Do` (Subtype `/Image`) and inline `BI…EI` ops emit an `ImageEvent` whose `quad` is the unit square `[0,0,1,1]` mapped through the current CTM (PDF images are painted on the unit square).

- [ ] **Step 1: Write the failing test**

Append to `test/content-map.test.ts`:

```ts
import { ImageEvent } from '../src/text.js';
import { buildImageOnlyPdf } from './helpers/build-text-pdf.js';

describe('visitContent — image placement', () => {
  it('emits an image event with the device-space placement box', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // 'q 100 0 0 100 50 50 cm /Im0 Do Q'
    const images: ImageEvent[] = [];
    visitContent(doc, doc.Pages[0], { image: (e) => images.push(e) });
    expect(images).toHaveLength(1);
    expect(images[0].kind).toBe('xobject');
    expect(images[0].quad).toEqual([50, 50, 150, 150]); // unit square * cm
    expect(images[0].addr).toEqual({ path: [], streamIndex: 0, opIndex: 2 }); // the Do op
  });
});
```

Note: `buildImageOnlyPdf` has an empty `/Resources` with no `/XObject`, so `Do` resolves to no stream. Update that helper to register an `/Im0` image XObject (Subtype `/Image`, a 1x1 sample) so the `Do` resolves; keep its existing "no text" guarantee. Make this edit in Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/content-map.test.ts -t "image placement"`
Expected: FAIL — no `image` events emitted.

- [ ] **Step 3: Implement image events**

In `test/helpers/build-text-pdf.ts`, give `buildImageOnlyPdf` a real image XObject:

```ts
export function buildImageOnlyPdf(): Uint8Array {
  const stream = `q 100 0 0 100 50 50 cm /Im0 Do Q`;
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ` +
       `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream`,
  };
  return serialize(objects, 5);
}
```

In `src/text.ts`:

- Add the `ImageEvent` interface and `image?` to `ContentVisitor`.
- In the `Do` case, resolve the XObject; if its `/Subtype` is `/Image`, emit an `ImageEvent` with `quad = bboxOfUnitSquare(curCtm)` and `kind: 'xobject'` (do **not** recurse). Keep the existing Form-XObject recursion path for `/Form`.
- Add a `BI` case (the op carries `inlineImage`): emit `ImageEvent` with the same unit-square box and `kind: 'inline'`.

```ts
function bboxOfUnitSquare(ctm: Matrix): [number, number, number, number] {
  const pts = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)];
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/content-map.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Regression**

Run: `npx vitest run test/text.test.ts test/image-embed.test.ts`
Expected: PASS — image embedding and extraction unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/text.ts test/content-map.test.ts test/helpers/build-text-pdf.ts
git commit -m "feat(638.3): visitContent emits image-placement events (xobject + inline)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: F2 — `mapRegions` consumer

**Files:**
- Modify: `src/text.ts`
- Modify: `src/index.ts`
- Test: `test/content-map.test.ts`

**Interfaces:**
- Produces:
  - `type Rect = [number, number, number, number]; // [x0,y0,x1,y1], normalized`
  - `interface RegionHits { glyphs: GlyphEvent[]; images: ImageEvent[]; }`
  - `function mapRegions(doc: Document, page: Page, rects: Rect[]): RegionHits` — returns the glyph and image events whose device-space `quad` intersects any rect (axis-aligned overlap; touching edges count as intersecting).
  - Public exports from `index.ts`: `EditableContent`, `ContentAddr`, `visitContent`, `GlyphEvent`, `ImageEvent`, `mapRegions`, `Rect`, `RegionHits`.

- [ ] **Step 1: Write the failing test**

Append to `test/content-map.test.ts`:

```ts
import { mapRegions } from '../src/text.js';

describe('mapRegions', () => {
  it('returns only the glyphs inside the given rectangle', () => {
    // Two words far apart on one line; redact a rect around the first only.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (AA) Tj 200 0 Td (BB) Tj ET']));
    const hits = mapRegions(doc, doc.Pages[0], [[45, 95, 75, 115]]);
    expect(hits.glyphs.map((g) => g.text).join('')).toBe('AA');
    expect(hits.images).toHaveLength(0);
  });

  it('catches an image overlapping the rectangle', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // image at [50,50,150,150]
    const hits = mapRegions(doc, doc.Pages[0], [[140, 140, 160, 160]]); // clips a corner
    expect(hits.images).toHaveLength(1);
    expect(hits.glyphs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/content-map.test.ts -t "mapRegions"`
Expected: FAIL — `mapRegions` not exported.

- [ ] **Step 3: Implement `mapRegions`**

In `src/text.ts`:

```ts
export type Rect = [number, number, number, number];
export interface RegionHits { glyphs: GlyphEvent[]; images: ImageEvent[]; }

function norm(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}
function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export function mapRegions(doc: Document, page: Page, rects: Rect[]): RegionHits {
  const rs = rects.map(norm);
  const glyphs: GlyphEvent[] = [];
  const images: ImageEvent[] = [];
  visitContent(doc, page, {
    glyph: (e) => { if (rs.some((r) => intersects(e.quad, r))) glyphs.push(e); },
    image: (e) => { if (rs.some((r) => intersects(e.quad, r))) images.push(e); },
  });
  return { glyphs, images };
}
```

In `src/index.ts`, add the public exports:

```ts
export { EditableContent } from './editcontent.js';
export type { ContentAddr } from './editcontent.js';
export { visitContent, mapRegions } from './text.js';
export type { GlyphEvent, ImageEvent, Rect, RegionHits } from './text.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/content-map.test.ts`
Expected: PASS (all groups).

- [ ] **Step 5: Full suite + typecheck + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/` builds (confirms the new public exports type-check as `.d.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/text.ts src/index.ts test/content-map.test.ts
git commit -m "feat(638.3): mapRegions consumer + public foundation exports

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Closing the foundation issues

- [ ] **Update README** — under the API overview, note the new low-level building blocks are internal-facing for Phase 4 (no user-facing redaction API yet); keep public-facing docs honest. Commit as `docs:`.
- [ ] **Close beads issues** once both are green:

```bash
npm run typecheck && npm test   # must be green
bd close aspose-pdf-foss-for-ts-638.2 --reason "EditableContent: per-stream op model, edit/commit, XObject copy-on-write. Tests in test/editcontent.test.ts."
bd close aspose-pdf-foss-for-ts-638.3 --reason "visitContent provenance walk (glyph+image events, ContentAddr), decodeGlyphs, mapRegions; extractText reimplemented as a consumer. Tests in test/content-map.test.ts, test/font-glyphs.test.ts."
```

This unblocks the redaction track (R1/R2 consume `mapRegions` + `EditableContent`) and the search track (S1 consumes `mapRegions`).

## Self-review notes (verified against the spec's Foundation section)

- **F1 read/edit/commit** → Tasks 1–2. **XObject COW** → Task 3, with the shared-XObject fixture proving page-2 isolation (the spec's explicit guarantee).
- **F2 provenance walk with glyph + image events and `ContentAddr`** → Tasks 5–6; **per-glyph geometry** depends on `decodeGlyphs` → Task 4. **`extractText` as a consumer (single walker)** → Task 5, gated by the existing `text.test.ts`. **`mapRegions`** → Task 7.
- **Type consistency:** `ContentAddr` is defined once in `editcontent.ts` (Task 1) and imported as a type by `text.ts` (Task 5); `GlyphEvent`/`ImageEvent`/`Rect`/`RegionHits` are defined in `text.ts` and re-exported from `index.ts` (Task 7). `decodeGlyphs`/`Glyph` names are stable across Tasks 4–5.
- **Out of scope (correctly):** glyph removal/serialization (R1), image removal (R2), replacement encoding (S2) — those live in the track plans that depend on this foundation.
