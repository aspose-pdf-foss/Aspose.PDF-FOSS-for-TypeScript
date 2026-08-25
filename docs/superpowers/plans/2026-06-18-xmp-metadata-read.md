# XMP Metadata Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the document-level XMP packet at `/Root /Metadata` into a structured `XmpMetadata` (Dublin Core, XMP basic, PDF schema), exposed via `Document.GetXmp()`, using a dependency-free XML scan.

**Architecture:** A new `src/xmp.ts` provides `readXmp(bytes): XmpMetadata` — it decodes the packet bytes to text (handling a UTF-8/UTF-16 BOM) and extracts known schema properties with a small set of regex helpers (RDF `Alt`/`Seq`/`Bag` containers via their `rdf:li` items; scalars via element content or compact attributes). Parsing is lenient: unparseable fields are skipped, never thrown, and the original packet text is returned in `raw`. `Document.GetXmp()` resolves the `/Root /Metadata` stream, Flate-decodes it via the existing `inflateStream`, and calls `readXmp`, returning `{}` when no packet exists.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Node built-ins only — **no XML library**.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins; XMP is parsed with a lightweight scan, no XML parser.
- **ESM + NodeNext** — every relative import specifier carries the `.js` extension.
- **Strict TypeScript** — `npm run typecheck` must stay green.
- **Lenient reads** — malformed or partial XMP never throws; unparseable fields are skipped and `raw` always holds the decoded packet text.
- **This is the read side only** — `Document.SetXmp`, `buildXmp`, the `/Info`↔XMP mirror, and `XmpUpdate` belong to the follow-up write issue (`82q`). Do **not** implement them here.
- **Dates** — `xmp:CreateDate` / `xmp:ModifyDate` parse via ISO-8601 `new Date(...)`, falling back to the raw string when unparseable (mirrors `parsePdfDate`'s contract).
- **TDD** — failing test first, watch it fail, implement minimally, watch it pass, commit. Run `npm run typecheck` before any commit that changes types.
- Target a single test file with `npx vitest run test/xmp.test.ts`; full suite with `npm test`.

## Foundation already shipped (consume, do not rebuild)

- `src/flate.ts`: `function inflateStream(s: PdfStream): Uint8Array` — returns `s.raw` when there is no filter, inflates a single `FlateDecode` (+ predictor), throws `UnsupportedFeatureError` for other filters. XMP packets are conventionally uncompressed, so this returns the packet bytes directly.
- `src/document.ts`: `catalog(): PdfDict`, `resolve(o)`, `isStream` (already imported in `document.ts`), and `GetMetadata(): Metadata` (the `/Info` analogue this sits beside). `Document` already imports `Metadata, MetadataUpdate, readMetadata, applyUpdate` from `./metadata.js`.
- `src/metadata.ts`: `parsePdfDate` shows the "Date | string fallback" convention to mirror for XMP dates.
- `src/types.ts`: `PdfStream`, `isStream`.
- Test fixtures: `test/helpers/build-annot-target.ts` exports `buildBlankPage()` (a one-page PDF whose catalog has **no** `/Metadata`).

## XmpMetadata shape (read subset; full interface per design spec)

```ts
interface XmpMetadata {
  title?: string;                 // dc:title (Alt → first item)
  authors?: string[];             // dc:creator (Seq, ordered)
  description?: string;           // dc:description (Alt → first item)
  subjects?: string[];            // dc:subject (Bag)
  keywords?: string;              // pdf:Keywords
  creatorTool?: string;           // xmp:CreatorTool
  producer?: string;              // pdf:Producer
  createDate?: Date | string;     // xmp:CreateDate
  modifyDate?: Date | string;     // xmp:ModifyDate
  rights?: string;                // dc:rights (Alt → first item)
  raw?: string;                   // original packet text, preserved on read
}
```

The write-only `XmpUpdate` type is **out of scope** (issue `82q`).

---

### Task 1: `src/xmp.ts` — `XmpMetadata` + `readXmp`

The parser, tested directly against crafted packet strings (no PDF needed).

**Files:**
- Create: `src/xmp.ts`
- Create: `test/xmp.test.ts`

**Interfaces:**
- Produces:
  - `export interface XmpMetadata { … }` (as above).
  - `export function readXmp(bytes: Uint8Array): XmpMetadata`.

- [ ] **Step 1: Write the failing test**

Create `test/xmp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readXmp } from '../src/xmp.js';

const enc = (s: string) => new TextEncoder().encode(s);

const FULL = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Annual &amp; Report</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li><rdf:li>John Roe</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li>A &lt;summary&gt;</rdf:li></rdf:Alt></dc:description>
   <dc:subject><rdf:Bag><rdf:li>finance</rdf:li><rdf:li>2024</rdf:li></rdf:Bag></dc:subject>
   <dc:rights><rdf:Alt><rdf:li>(c) Aspose</rdf:li></rdf:Alt></dc:rights>
   <pdf:Keywords>finance, 2024</pdf:Keywords>
   <pdf:Producer>Aspose.PDF</pdf:Producer>
   <xmp:CreatorTool>Aspose Authoring</xmp:CreatorTool>
   <xmp:CreateDate>2024-06-03T12:30:45Z</xmp:CreateDate>
   <xmp:ModifyDate>2024-06-04T08:00:00Z</xmp:ModifyDate>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

describe('readXmp', () => {
  it('parses dc / xmp / pdf properties from a full packet', () => {
    const m = readXmp(enc(FULL));
    expect(m.title).toBe('Annual & Report');
    expect(m.authors).toEqual(['Jane Doe', 'John Roe']);     // ordered Seq
    expect(m.description).toBe('A <summary>');
    expect(m.subjects).toEqual(['finance', '2024']);          // Bag
    expect(m.rights).toBe('(c) Aspose');
    expect(m.keywords).toBe('finance, 2024');
    expect(m.producer).toBe('Aspose.PDF');
    expect(m.creatorTool).toBe('Aspose Authoring');
    expect(m.createDate).toBeInstanceOf(Date);
    expect((m.createDate as Date).toISOString()).toBe('2024-06-03T12:30:45.000Z');
    expect(m.modifyDate).toBeInstanceOf(Date);
    expect(m.raw).toContain('<x:xmpmeta');
  });

  it('parses compact attribute (rdf:Description ... pdf:Producer="...") form', () => {
    const packet = `<x:xmpmeta><rdf:RDF><rdf:Description rdf:about="" ` +
      `pdf:Producer="Compact" xmp:CreateDate="2020-01-02T03:04:05Z"/></rdf:RDF></x:xmpmeta>`;
    const m = readXmp(enc(packet));
    expect(m.producer).toBe('Compact');
    expect(m.createDate).toBeInstanceOf(Date);
  });

  it('keeps an unparseable date as the raw string', () => {
    const packet = `<rdf:Description><xmp:CreateDate>not-a-date</xmp:CreateDate></rdf:Description>`;
    expect(readXmp(enc(packet)).createDate).toBe('not-a-date');
  });

  it('reads malformed XMP leniently (no throw) and preserves raw', () => {
    const packet = `<x:xmpmeta><rdf:RDF><rdf:Description><dc:title><rdf:Alt>`; // truncated
    const m = readXmp(enc(packet));
    expect(m.title).toBeUndefined();
    expect(m.raw).toBe(packet);
  });

  it('decodes a UTF-8 BOM and returns {} of fields for an empty packet', () => {
    const m = readXmp(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('<x:xmpmeta></x:xmpmeta>')]));
    expect(m.title).toBeUndefined();
    expect(m.raw).toBe('<x:xmpmeta></x:xmpmeta>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/xmp.test.ts`
Expected: FAIL — cannot find module `../src/xmp.js`.

- [ ] **Step 3: Create `src/xmp.ts`**

```ts
/** Structured view of a document's XMP packet (read side). */
export interface XmpMetadata {
  title?: string;                 // dc:title
  authors?: string[];             // dc:creator (ordered)
  description?: string;           // dc:description
  subjects?: string[];            // dc:subject
  keywords?: string;              // pdf:Keywords
  creatorTool?: string;           // xmp:CreatorTool
  producer?: string;              // pdf:Producer
  createDate?: Date | string;     // xmp:CreateDate
  modifyDate?: Date | string;     // xmp:ModifyDate
  rights?: string;                // dc:rights
  /** Original decoded packet text, preserved for round-tripping. */
  raw?: string;
}

/** Decode packet bytes to text, honoring a UTF-8 or UTF-16 BOM (default UTF-8). */
function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return s;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Unescape the five XML predefined entities plus numeric character references.
 *  `&amp;` is resolved last so escaped entities are not double-decoded. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Inner text of the first `<prop ...>…</prop>` element, or undefined. `prop`
 *  is a controlled schema literal (e.g. 'dc:title'), so no regex-escaping. */
function matchBlock(xml: string, prop: string): string | undefined {
  const m = new RegExp(`<${prop}(?:\\s[^>]*)?>([\\s\\S]*?)</${prop}>`).exec(xml);
  return m ? m[1] : undefined;
}

/** All `<rdf:li>…</rdf:li>` item texts within a container block. */
function liItems(block: string): string[] {
  const re = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(unescapeXml(m[1].trim()));
  return out;
}

/** First item of an rdf:Alt-style language container (falls back to bare text). */
function altText(xml: string, prop: string): string | undefined {
  const block = matchBlock(xml, prop);
  if (block === undefined) return undefined;
  const items = liItems(block);
  if (items.length) return items[0];
  const inner = block.trim();
  return inner.length && !inner.includes('<') ? unescapeXml(inner) : undefined;
}

/** All items of an rdf:Seq/rdf:Bag container, or undefined. */
function listItems(xml: string, prop: string): string[] | undefined {
  const block = matchBlock(xml, prop);
  if (block === undefined) return undefined;
  const items = liItems(block);
  return items.length ? items : undefined;
}

/** A scalar property: element text (no child markup), else a compact attribute. */
function scalar(xml: string, prop: string): string | undefined {
  const block = matchBlock(xml, prop);
  if (block !== undefined && !block.includes('<')) return unescapeXml(block.trim());
  const m = new RegExp(`\\b${prop}\\s*=\\s*"([^"]*)"|\\b${prop}\\s*=\\s*'([^']*)'`).exec(xml);
  if (m) return unescapeXml(m[1] ?? m[2] ?? '');
  return undefined;
}

/** Parse an ISO-8601 date, or keep the raw string when unparseable. */
function parseXmpDate(s: string): Date | string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d;
}

/** Parse an XMP packet's bytes into a structured XmpMetadata. Lenient: missing
 *  or malformed fields are skipped, never thrown; `raw` holds the packet text. */
export function readXmp(bytes: Uint8Array): XmpMetadata {
  const raw = decodeText(bytes);
  const meta: XmpMetadata = { raw };

  const title = altText(raw, 'dc:title'); if (title !== undefined) meta.title = title;
  const authors = listItems(raw, 'dc:creator'); if (authors) meta.authors = authors;
  const description = altText(raw, 'dc:description'); if (description !== undefined) meta.description = description;
  const subjects = listItems(raw, 'dc:subject'); if (subjects) meta.subjects = subjects;
  const rights = altText(raw, 'dc:rights'); if (rights !== undefined) meta.rights = rights;
  const keywords = scalar(raw, 'pdf:Keywords'); if (keywords !== undefined) meta.keywords = keywords;
  const producer = scalar(raw, 'pdf:Producer'); if (producer !== undefined) meta.producer = producer;
  const creatorTool = scalar(raw, 'xmp:CreatorTool'); if (creatorTool !== undefined) meta.creatorTool = creatorTool;
  const createDate = scalar(raw, 'xmp:CreateDate'); if (createDate !== undefined) meta.createDate = parseXmpDate(createDate);
  const modifyDate = scalar(raw, 'xmp:ModifyDate'); if (modifyDate !== undefined) meta.modifyDate = parseXmpDate(modifyDate);

  return meta;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/xmp.test.ts` — Expected: PASS.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/xmp.ts test/xmp.test.ts
git commit -m "feat: readXmp — dependency-free XMP packet parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `Document.GetXmp()` + fixture + exports + docs

Wires the parser to the live `/Root /Metadata` stream and exposes it publicly.

**Files:**
- Create: `test/helpers/build-xmp-pdf.ts` (a one-page PDF whose catalog has a `/Metadata` XML stream)
- Modify: `src/document.ts` (imports + `GetXmp` method)
- Modify: `src/index.ts` (export `XmpMetadata`)
- Modify: `README.md` (Features bullet + API row)
- Modify: `test/xmp.test.ts` (a `Document.GetXmp` describe block)

**Interfaces:**
- Consumes: `readXmp`/`XmpMetadata` (Task 1), `inflateStream`, `Document.catalog`/`resolve`/`isStream`.
- Produces:
  - `export function buildXmpPdf(packet: string): Uint8Array`.
  - `Document.GetXmp(): XmpMetadata`.

- [ ] **Step 1: Write the failing test**

Add these imports at the **top** of `test/xmp.test.ts` (alongside the existing `readXmp` import):

```ts
import { Document } from '../src/document.js';
import { buildXmpPdf } from './helpers/build-xmp-pdf.js';
import { buildBlankPage } from './helpers/build-annot-target.js';
```

Then append this describe block at the end of the file:

```ts
describe('Document.GetXmp', () => {
  it('parses the /Root /Metadata packet', () => {
    const doc = Document.Open(buildXmpPdf(FULL));
    const xmp = doc.GetXmp();
    expect(xmp.title).toBe('Annual & Report');
    expect(xmp.authors).toEqual(['Jane Doe', 'John Roe']);
    expect(xmp.producer).toBe('Aspose.PDF');
    expect(xmp.createDate).toBeInstanceOf(Date);
    expect(xmp.raw).toContain('<x:xmpmeta');
  });

  it('returns {} when there is no /Metadata stream', () => {
    expect(Document.Open(buildBlankPage()).GetXmp()).toEqual({});
  });
});
```

(`FULL` is the packet constant already defined at the top of the file in Task 1.)

- [ ] **Step 2: Create the fixture builder**

Create `test/helpers/build-xmp-pdf.ts`:

```ts
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

/** One page whose catalog carries an uncompressed XMP /Metadata stream. */
export function buildXmpPdf(packet: string): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R >>`;
  objects[4] = `<< /Type /Metadata /Subtype /XML /Length ${byteLen(packet)} >>\nstream\n${packet}\nendstream`;
  return assemble(objects, 4, 1);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/xmp.test.ts`
Expected: FAIL — `doc.GetXmp is not a function`.

- [ ] **Step 4: Add `GetXmp` to `src/document.ts`**

Add the imports (next to the existing metadata/flate-related imports near the top of `document.ts`):

```ts
import { inflateStream } from './flate.js';
import { readXmp, XmpMetadata } from './xmp.js';
```

Add the method immediately after `GetMetadata`:

```ts
  /** The document-level XMP packet at /Root /Metadata as structured data; an
   *  empty object when there is no metadata stream. Read leniently. */
  GetXmp(): XmpMetadata {
    const md = this.resolve(this.catalog().get('Metadata'));
    if (!isStream(md)) return {};
    return readXmp(inflateStream(md));
  }
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npm run typecheck` — Expected: no errors.
Run: `npx vitest run test/xmp.test.ts` — Expected: PASS.

- [ ] **Step 6: Export from `index.ts`**

In `src/index.ts`, add (next to the other metadata exports):

```ts
export type { XmpMetadata } from './xmp.js';
```

- [ ] **Step 7: Update the README**

In `README.md`, change the Metadata feature bullet (line ~22) from:

```
- **Metadata** — `GetMetadata`, `SetMetadata`, `ClearMetadata` for the `/Info` dictionary, including custom keys.
```

to:

```
- **Metadata** — `GetMetadata`, `SetMetadata`, `ClearMetadata` for the `/Info` dictionary, including custom keys; `GetXmp` reads the document-level XMP packet (`/Root /Metadata`).
```

And add an API row immediately after the `doc.GetMetadata()` row:

```
| `doc.GetXmp()` | Read the XMP metadata packet (`/Root /Metadata`) as `XmpMetadata` |
```

- [ ] **Step 8: Run typecheck, full suite, and build**

Run: `npm run typecheck` — Expected: no errors.
Run: `npm test` — Expected: full suite green.
Run: `npm run build` — Expected: clean build (emits `XmpMetadata` to `.d.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/document.ts src/index.ts README.md test/xmp.test.ts test/helpers/build-xmp-pdf.ts
git commit -m "feat: Document.GetXmp reads the /Root /Metadata XMP packet

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes / follow-ups

- **Write side (`82q`):** `SetXmp`, `buildXmp`, `XmpUpdate`, and the `/Info`↔XMP auto-mirror build on this. `readXmp`'s `raw` field is the round-tripping anchor; the `XmpMetadata` interface is already the full shape so the write issue only adds `XmpUpdate` and the builder.
- **Encoding:** `readXmp` decodes UTF-8 (default) and UTF-16 (BOM-detected). Astral-plane characters in UTF-16 are read via 16-bit code units (surrogate pairs survive as a pair) — adequate for typical metadata.
- **Compressed packets:** real-world XMP is almost always stored uncompressed; `inflateStream` still transparently handles a `FlateDecode` packet.
