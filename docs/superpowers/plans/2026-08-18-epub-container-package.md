# EPUB 3 container and package writer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.ToEpub(options?)` returns a valid, single-chapter EPUB 3 archive.

**Architecture:** Four tasks. Two prepare the shared HTML serializer (XHTML-compatible markup, then an injectable image sink); one adds `epub.ts`, a pure OCF+OPF writer that never imports `document.js`; one adds `epubexport.ts`, the only module that reads a `Document`, plus the public entry point and docs.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import specifiers), vitest, `node:zlib` and `node:crypto` only. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-epub-container-package-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import carries a `.js` extension, e.g. `import { writeZip } from './zip.js';`.
- **TDD.** Write the failing test, run it, watch it fail for the right reason, then implement. Never write production code first.
- **Both gates green before any commit:** `npm run typecheck` and `npm test`.
- **CHANGELOG.md is updated in the same commit as a user-visible change**, under `## [Unreleased]`.
- **Errors:** throw only `PdfParseError`, `UnsupportedFeatureError` or `InvalidPasswordError` from `errors.ts`. `ToEpub` throws none of them — it degrades.
- **Determinism:** no clock, no randomness, anywhere in this feature. Two runs over one input must produce byte-identical archives.
- Target a single test file with `npx vitest run test/<name>.test.ts`.

---

### Task 1: XHTML-compatible markup in the shared serializer

The five sites from the spec. The self-closing form and spelled-out boolean attributes are valid HTML5 too, so there is one dialect and no flag.

**Files:**
- Modify: `src/htmlsemantic.ts` (the `<img>` pair in `figureHtml`, the `<input>` in the list-item helper)
- Modify: `src/tablemodel.ts` (two `<br>` sites)
- Test: `test/html-xhtml.test.ts` (create)
- Update: `test/__snapshots__/html-identity.test.ts.snap`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature changes. Later tasks rely only on the fact that `semanticBody`'s output parses as XML.

- [ ] **Step 1: Write the failing test**

Create `test/html-xhtml.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseXml } from '../src/xml.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';

/** The body markup, wrapped in a single root so a fragment can be parsed. */
function parsesAsXml(fragment: string): boolean {
  try {
    parseXml(new TextEncoder().encode(`<root>${fragment}</root>`));
    return true;
  } catch {
    return false;
  }
}

describe('semantic HTML is well-formed XHTML', () => {
  it('self-closes void elements in a figure', () => {
    const html = Document.Open(buildUntaggedHtmlPdf()).ToHtml({ fragment: true });
    expect(html).not.toMatch(/<img[^>]*[^/]>/);
    expect(parsesAsXml(html)).toBe(true);
  });

  it('self-closes the <br> in a table cell', () => {
    const html = Document.Open(buildTaggedTablePdf()).ToHtml({ fragment: true });
    expect(html).not.toContain('<br>');
    expect(parsesAsXml(html)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-xhtml.test.ts`
Expected: FAIL. The figure case fails on the `<img ...>` regex; the table case fails on `toContain('<br>')` if that fixture has a multi-line cell, and otherwise passes — that is fine, the figure case is the one that must go red here.

- [ ] **Step 3: Make the four `htmlsemantic.ts` edits**

In `src/htmlsemantic.ts`, `figureHtml`:

```typescript
  if (!hrefs.length) return fig.tagged ? `<img alt="${alt}"/>` : '';
  // A figure is described once. Repeating /Alt on each part of a composite
  // would have a screen reader announce the same description N times.
  return hrefs.map((h, i) => `<img src="${h}" alt="${i === 0 ? alt : ''}"/>`).join('');
```

And the task-list `<input>` (search for `type="checkbox"`):

```typescript
`<input type="checkbox" disabled="disabled"${item.checked ? ' checked="checked"' : ''}/>`
```

- [ ] **Step 4: Make the two `tablemodel.ts` edits**

Replace each `.replace(/\n/g, '<br>')` with `.replace(/\n/g, '<br/>')`. There are exactly TWO — one in `toHtml`'s cell loop and one in the `toMarkdown` path. A third `<br>` sits in a COMMENT just above the second; update its text so the comment does not contradict the code, but do not count it as a site. The Markdown one emits inline HTML into a GFM cell, where `<br/>` is equally valid.

- [ ] **Step 5: Run the new test to verify it passes**

Run: `npx vitest run test/html-xhtml.test.ts`
Expected: PASS.

- [ ] **Step 6: Inspect the snapshot diff before accepting it**

Run: `npx vitest run test/html-identity.test.ts`
Expected: FAIL, with a diff.

Read the diff. **Every changed line must be one of `<img …>`→`<img …/>`, `<br>`→`<br/>`, or the `<input>` attribute spelling.** If any other line moved, stop — something else changed and this plan does not cover it.

That file's header says "Never regenerate with `vitest -u`". That rule is about not papering over an unexplained diff; this diff is explained, reviewed, and recorded in the spec. Once you have confirmed the diff contains nothing else:

Run: `npx vitest run test/html-identity.test.ts -u`

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: all green. `test/markdown-export.test.ts` may also carry `<br>` snapshots — if it moves, apply the same "only `<br/>` lines changed" inspection before updating.

- [ ] **Step 8: Commit**

```bash
git add src/htmlsemantic.ts src/tablemodel.ts test/html-xhtml.test.ts test/__snapshots__/
git commit -m "refactor(html): XHTML-compatible void elements in the shared serializer

Self-closes <img>, <br> and <input>, and spells out the boolean attributes
disabled and checked. All of it is valid HTML5 as well as valid XHTML, so the
HTML export and the coming EPUB export share ONE dialect rather than a flag or
a second serializer (zwto.1).

html-identity snapshots move once, deliberately: the diff was inspected and
contains nothing but the void-element and attribute spellings."
```

---

### Task 2: An injectable image sink on `semanticBody`

EPUB needs `<img src="images/image1.png"/>`, not a `data:` URI. Mirrors `docxBody`'s existing `DocxImageSink`.

**Files:**
- Modify: `src/htmlsemantic.ts`
- Test: `test/html-image-sink.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export interface HtmlImageSink { href(stream: PdfStream): string | undefined }
  export function semanticBody(
    doc: Document, nodes: DocNode[], images?: HtmlImageSink,
  ): string
  ```
  Task 4 passes a sink; omitting it must keep today's `data:` URI behaviour.

- [ ] **Step 1: Write the failing test**

Create `test/html-image-sink.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDocModel } from '../src/docmodel.js';
import { semanticBody, type HtmlImageSink } from '../src/htmlsemantic.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

describe('semanticBody image sink', () => {
  it('routes every figure image through the sink', () => {
    const doc = Document.Open(buildTextAndImagePage());
    const seen: number[] = [];
    const sink: HtmlImageSink = {
      href: () => { seen.push(1); return 'images/image1.png'; },
    };
    const body = semanticBody(doc, buildDocModel(doc, doc.Pages), sink);
    expect(seen.length).toBeGreaterThan(0);
    expect(body).toContain('src="images/image1.png"');
    expect(body).not.toContain('data:');
  });

  it('falls back to a data: URI with no sink', () => {
    // The companion that proves the sink is what changed the href, rather than
    // the fixture simply having no image.
    const doc = Document.Open(buildTextAndImagePage());
    const body = semanticBody(doc, buildDocModel(doc, doc.Pages));
    expect(body).toContain('src="data:');
  });

  it('drops an image the sink refuses, keeping figureHtml\'s own rule', () => {
    const doc = Document.Open(buildTextAndImagePage());
    const sink: HtmlImageSink = { href: () => undefined };
    const body = semanticBody(doc, buildDocModel(doc, doc.Pages), sink);
    expect(body).not.toContain('<img src=');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-image-sink.test.ts`
Expected: FAIL — `semanticBody` takes two arguments, so the sink is ignored and the first case finds `data:`.

- [ ] **Step 3: Thread the sink through**

In `src/htmlsemantic.ts`, add the type near the top (after the imports), and add a `PdfStream` type import:

```typescript
import type { PdfStream } from './types.js';

/** Resolves a figure's image to an href. Omitted, images inline as data: URIs.
 *
 *  The seam EPUB needs: an EPUB carries its images as package parts, so the
 *  manifest must name a file that exists. Same shape as docxflow.ts's
 *  DocxImageSink, for the same reason. */
export interface HtmlImageSink { href(stream: PdfStream): string | undefined }
```

Give `figureHtml` the sink and use it:

```typescript
function figureHtml(doc: Document, fig: DocFigure, images?: HtmlImageSink): string {
  const alt = escapeHtml(fig.alt);
  const hrefs: string[] = [];
  for (const s of fig.images) {
    const href = images ? images.href(s) : imageHref(doc, s, [0, 0, 0]);
    if (href) hrefs.push(href);
  }
```

Thread it from `semanticBody` down through `nodeHtml` to `figureHtml`. Add the parameter to each function on that path; do not add a module-level variable.

```typescript
export function semanticBody(
  doc: Document, nodes: DocNode[], images?: HtmlImageSink,
): string {
  return nodes.map((n) => nodeHtml(doc, n, images)).filter((s) => s).join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/html-image-sink.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Verify the HTML export did not move**

Run: `npx vitest run test/html-identity.test.ts`
Expected: PASS with no snapshot change. The sink is optional and `html.ts` does not pass one, so this must be byte-identical. If it moved, the fallback branch is wrong.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run typecheck && npm test
git add src/htmlsemantic.ts test/html-image-sink.test.ts
git commit -m "feat(html): optional image sink on semanticBody

An EPUB carries its images as package parts, so its manifest must name files
that exist rather than inline data: URIs. Same seam docxflow.ts already takes
as DocxImageSink. Omitted, the data: URI path is unchanged and html-identity
is unmoved (zwto.1)."
```

---

### Task 3: `epub.ts` — the OCF and OPF writer

Pure. Never imports `document.js`, `page.js`, or any PDF object module, so every rule below is testable from hand-built part lists.

**Files:**
- Create: `src/epub.ts`
- Test: `test/epub-package.test.ts` (create)

**Interfaces:**
- Consumes: `writeZip`, `ZipEntry` from `./zip.js`.
- Produces:
  ```typescript
  export interface EpubPart {
    path: string;        // relative to the OPF's directory, e.g. 'content.xhtml'
    bytes: Uint8Array;
    mediaType: string;
    id: string;          // manifest id, unique across the package
    properties?: string; // e.g. 'nav'
    spine?: boolean;     // true => appears in the spine, in array order
  }
  export interface EpubMetadata {
    identifier: string;
    title: string;
    language: string;
    author?: string;
  }
  export function writeEpub(parts: EpubPart[], meta: EpubMetadata): Uint8Array;
  export const EPUB_DIR = 'EPUB';
  ```

- [ ] **Step 1: Write the failing test**

Create `test/epub-package.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { writeEpub, type EpubPart, type EpubMetadata } from '../src/epub.js';
import { parseXml } from '../src/xml.js';
import { unzip, entry, textOf } from './helpers/unzip.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

const META: EpubMetadata = {
  identifier: 'urn:uuid:test', title: 'T', language: 'und',
};

/** A minimal valid package: one nav document and one content document. */
function parts(): EpubPart[] {
  return [
    {
      path: 'nav.xhtml', bytes: utf8('<html/>'), mediaType: 'application/xhtml+xml',
      id: 'nav', properties: 'nav',
    },
    {
      path: 'content.xhtml', bytes: utf8('<html/>'),
      mediaType: 'application/xhtml+xml', id: 'c1', spine: true,
    },
  ];
}

describe('writeEpub', () => {
  it('puts a STORED mimetype first, at the sniffable offset', () => {
    // The one rule a "are all the parts present" test cannot see: a reader
    // identifies an EPUB by reading the media type at byte 38 without
    // inflating anything. 30 bytes of local header + the 8-byte name.
    const bytes = writeEpub(parts(), META);
    const zip = unzip(bytes);
    expect(zip[0].path).toBe('mimetype');
    expect(zip[0].method).toBe('store');
    const at38 = new TextDecoder().decode(bytes.slice(38, 38 + 20));
    expect(at38).toBe('application/epub+zip');
  });

  it('points container.xml at an OPF that exists', () => {
    const zip = unzip(writeEpub(parts(), META));
    const container = textOf(zip, 'META-INF/container.xml');
    const full = /full-path="([^"]+)"/.exec(container)?.[1];
    expect(full).toBe('EPUB/package.opf');
    expect(entry(zip, full!)).toBeDefined();
  });

  it('resolves every manifest href to a part', () => {
    const zip = unzip(writeEpub(parts(), META));
    const opf = textOf(zip, 'EPUB/package.opf');
    const hrefs = [...opf.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2);
    for (const h of hrefs) expect(entry(zip, `EPUB/${h}`)).toBeDefined();
  });

  it('resolves every spine idref to a manifest item', () => {
    const zip = unzip(writeEpub(parts(), META));
    const opf = textOf(zip, 'EPUB/package.opf');
    const ids = new Set([...opf.matchAll(/<item [^>]*id="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...opf.matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);
    expect(refs).toEqual(['c1']);
    for (const r of refs) expect(ids.has(r)).toBe(true);
  });

  it('marks exactly one manifest item as the nav document', () => {
    const opf = textOf(unzip(writeEpub(parts(), META)), 'EPUB/package.opf');
    expect([...opf.matchAll(/properties="nav"/g)]).toHaveLength(1);
  });

  it('emits an OPF and a container that parse as XML', () => {
    const zip = unzip(writeEpub(parts(), META));
    expect(() => parseXml(entry(zip, 'EPUB/package.opf')!.bytes)).not.toThrow();
    expect(() => parseXml(entry(zip, 'META-INF/container.xml')!.bytes)).not.toThrow();
  });

  it('escapes metadata that would otherwise break the OPF', () => {
    const opf = textOf(unzip(writeEpub(parts(), {
      ...META, title: 'A & B <c>',
    })), 'EPUB/package.opf');
    expect(opf).toContain('A &amp; B &lt;c&gt;');
    expect(() => parseXml(new TextEncoder().encode(opf))).not.toThrow();
  });

  it('omits dc:creator when there is no author', () => {
    const opf = textOf(unzip(writeEpub(parts(), META)), 'EPUB/package.opf');
    expect(opf).not.toContain('dc:creator');
  });

  it('is byte-reproducible', () => {
    expect(writeEpub(parts(), META)).toEqual(writeEpub(parts(), META));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/epub-package.test.ts`
Expected: FAIL — cannot resolve `../src/epub.js`.

- [ ] **Step 3: Implement `src/epub.ts`**

```typescript
import { writeZip, type ZipEntry } from './zip.js';

/** The content directory, and the OPF's own directory. Manifest hrefs are
 *  relative to it, exactly as an OOXML relationship target is relative to its
 *  source part's directory — the same trap, in a second format. */
export const EPUB_DIR = 'EPUB';

const OPF_PATH = `${EPUB_DIR}/package.opf`;
const MIMETYPE = 'application/epub+zip';

/** A fixed modification date, for the same reason zip.ts fixes its timestamps:
 *  two runs over one input must give identical bytes. EPUB 3 wants a
 *  dcterms:modified, and the clock would make every archive unique. */
const MODIFIED = '1980-01-01T00:00:00Z';

/** One file in the package, plus what the OPF must say about it. */
export interface EpubPart {
  /** Path relative to the OPF's directory, e.g. 'content.xhtml'. */
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  /** Manifest id. Unique across the package. */
  id: string;
  /** EPUB 3 manifest properties, e.g. 'nav'. */
  properties?: string;
  /** True when this is a content document in reading order. Spine order is
   *  array order. */
  spine?: boolean;
}

export interface EpubMetadata {
  identifier: string;
  title: string;
  language: string;
  author?: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** XML text escaping. The five predefined entities are all XML defines, which
 *  is why nothing here may emit a named entity such as &nbsp;. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

function containerXml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<container version="1.0" '
    + 'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    + '<rootfiles>\n'
    + `<rootfile full-path="${OPF_PATH}" `
    + 'media-type="application/oebps-package+xml"/>\n'
    + '</rootfiles>\n</container>\n';
}

function packageOpf(parts: EpubPart[], meta: EpubMetadata): string {
  const items = parts.map((p) =>
    `<item id="${esc(p.id)}" href="${esc(p.path)}" `
    + `media-type="${esc(p.mediaType)}"`
    + (p.properties ? ` properties="${esc(p.properties)}"` : '')
    + '/>').join('\n');
  const spine = parts.filter((p) => p.spine)
    .map((p) => `<itemref idref="${esc(p.id)}"/>`).join('\n');
  const creator = meta.author
    ? `<dc:creator>${esc(meta.author)}</dc:creator>\n` : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
    + 'unique-identifier="pub-id">\n'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
    + `<dc:identifier id="pub-id">${esc(meta.identifier)}</dc:identifier>\n`
    + `<dc:title>${esc(meta.title)}</dc:title>\n`
    + `<dc:language>${esc(meta.language)}</dc:language>\n`
    + creator
    + `<meta property="dcterms:modified">${MODIFIED}</meta>\n`
    + '</metadata>\n'
    + `<manifest>\n${items}\n</manifest>\n`
    + `<spine>\n${spine}\n</spine>\n`
    + '</package>\n';
}

/** Assemble an EPUB 3 archive.
 *
 *  **Invariant:** `mimetype` is the FIRST entry and is STORED. A reader
 *  identifies an EPUB by reading the media type at a fixed byte offset without
 *  inflating anything; deflate it or emit it second and the file is still a
 *  valid ZIP holding all the right parts, and simply stops being recognisable
 *  as an EPUB.
 *
 *  **Invariant:** a manifest href is relative to the OPF's own directory, not
 *  to the archive root. Getting it wrong yields a package whose parts all exist
 *  and whose links all dangle — every symptom points at the target while the
 *  fault is in the base. */
export function writeEpub(parts: EpubPart[], meta: EpubMetadata): Uint8Array {
  const seen = new Set<string>();
  for (const p of parts) {
    if (seen.has(p.id)) throw new TypeError(`duplicate manifest id ${p.id}`);
    seen.add(p.id);
  }

  const entries: ZipEntry[] = [
    { path: 'mimetype', bytes: utf8(MIMETYPE), method: 'store' },
    { path: 'META-INF/container.xml', bytes: utf8(containerXml()) },
    { path: OPF_PATH, bytes: utf8(packageOpf(parts, meta)) },
  ];
  for (const p of parts) {
    entries.push({ path: `${EPUB_DIR}/${p.path}`, bytes: p.bytes });
  }
  return writeZip(entries);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/epub-package.test.ts`
Expected: PASS, all nine.

- [ ] **Step 5: Prove the mimetype assertions are load-bearing**

The repo's rule for fixtures: do not just watch a test go green, break the path and confirm it goes red.

Temporarily change `method: 'store'` to `method: 'deflate'` in `writeEpub`, run `npx vitest run test/epub-package.test.ts`, and confirm the first case fails. Then move the mimetype entry to the end of the array, re-run, and confirm it fails again. **Revert both.** If either mutation leaves the suite green, the assertion is not testing what it claims.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run typecheck && npm test
git add src/epub.ts test/epub-package.test.ts
git commit -m "feat(epub): OCF container and OPF package writer

Pure: imports zip.ts and nothing else, so mimetype placement, manifest/spine
consistency and the OPF grammar are all driven from hand-built part lists
rather than from a built PDF (zwto.1).

The stored, first-entry mimetype is asserted on the archive's RAW bytes at
offset 38 — it is the one rule a structural 'are the parts present' test
cannot see — and both halves were confirmed to go red when broken."
```

---

### Task 4: `epubexport.ts`, `Document.ToEpub`, and the docs

The only module here that reads a `Document`.

**Files:**
- Create: `src/epubexport.ts`
- Modify: `src/document.ts` (add `ToEpub`)
- Modify: `src/index.ts` (export `EpubOptions`)
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`
- Test: `test/epub-export.test.ts` (create)

**Interfaces:**
- Consumes: `writeEpub`, `EpubPart`, `EpubMetadata` from `./epub.js`; `semanticBody`, `HtmlImageSink` from `./htmlsemantic.js`; `buildDocModel` from `./docmodel.js`; `encodeImage`, `imageExtension` from `./imagehref.js`.
- Produces:
  ```typescript
  export interface EpubOptions {
    identifier?: string;
    title?: string;
    language?: string;
    author?: string;
  }
  export function renderEpub(
    doc: Document, pages: Page[], opts: EpubOptions,
  ): Uint8Array;
  ```
  and on `Document`: `ToEpub(options?: EpubOptions): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `test/epub-export.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseXml } from '../src/xml.js';
import { unzip, entry, textOf } from './helpers/unzip.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

describe('Document.ToEpub', () => {
  it('produces a package whose manifest resolves', () => {
    const zip = unzip(Document.Open(buildTaggedPdf()).ToEpub());
    const opf = textOf(zip, 'EPUB/package.opf');
    for (const m of opf.matchAll(/href="([^"]+)"/g)) {
      expect(entry(zip, `EPUB/${m[1]}`)).toBeDefined();
    }
  });

  it('emits content documents that parse as XML', () => {
    const zip = unzip(Document.Open(buildTaggedPdf()).ToEpub());
    for (const path of ['EPUB/content.xhtml', 'EPUB/nav.xhtml']) {
      expect(() => parseXml(entry(zip, path)!.bytes)).not.toThrow();
    }
  });

  it('writes images as parts, not data: URIs', () => {
    const zip = unzip(Document.Open(buildTextAndImagePage()).ToEpub());
    const content = textOf(zip, 'EPUB/content.xhtml');
    expect(content).not.toContain('data:');
    expect(content).toMatch(/src="images\/image1\.(png|jpg)"/);
    expect(zip.some((e) => e.path.startsWith('EPUB/images/'))).toBe(true);
  });

  it('defaults dc:language to und rather than claiming English', () => {
    // A missing dc:language makes the file invalid, so something must be
    // written -- but 'en' would state a fact the PDF never stated.
    const opf = textOf(unzip(Document.Open(buildTaggedPdf()).ToEpub()),
      'EPUB/package.opf');
    expect(opf).toContain('<dc:language>und</dc:language>');
  });

  it('takes the identifier from options when given', () => {
    const opf = textOf(unzip(Document.Open(buildTaggedPdf())
      .ToEpub({ identifier: 'urn:isbn:123' })), 'EPUB/package.opf');
    expect(opf).toContain('urn:isbn:123');
  });

  it('is byte-reproducible', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.ToEpub()).toEqual(doc.ToEpub());
  });

  it('does not throw on a document with no structure at all', () => {
    const doc = Document.Open(buildTextAndImagePage());
    expect(() => doc.ToEpub()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/epub-export.test.ts`
Expected: FAIL — `ToEpub` is not a function.

- [ ] **Step 3: Implement `src/epubexport.ts`**

```typescript
import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { PdfStream } from './types.js';
import { isArray, isString } from './types.js';
import { buildDocModel } from './docmodel.js';
import { semanticBody, type HtmlImageSink } from './htmlsemantic.js';
import { encodeImage, imageExtension } from './imagehref.js';
import { writeEpub, type EpubPart, type EpubMetadata } from './epub.js';

/** Options for {@link Document.ToEpub}. */
export interface EpubOptions {
  /** dc:identifier. Defaults to the trailer /ID, then a hash of the content. */
  identifier?: string;
  /** dc:title. Defaults to the /Info title, then ''. */
  title?: string;
  /** dc:language. Defaults to Document.Lang, then 'und'. */
  language?: string;
  /** dc:creator. Defaults to the /Info author, then omitted. */
  author?: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const hex = (b: Uint8Array): string =>
  [...b].map((n) => n.toString(16).padStart(2, '0')).join('');

/** An XHTML 1.1 document shell. EPUB content documents must be well-formed
 *  XML, which is why the body producer self-closes its void elements. */
function xhtml(title: string, lang: string, body: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml" '
    + `xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(lang)}">\n`
    + `<head><title>${esc(title)}</title></head>\n`
    + `<body>\n${body}\n</body>\n</html>\n`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

/** The trailer /ID as a urn, or undefined. The PDF's own claim to identity,
 *  which Save() preserves across a round trip. */
function idFromTrailer(doc: Document): string | undefined {
  const id = doc.resolve(doc.trailer.get('ID'));
  if (!isArray(id) || id.length < 1) return undefined;
  const first = doc.resolve(id[0]);
  if (!isString(first) || first.bytes.length === 0) return undefined;
  return `urn:uuid:${hex(first.bytes)}`;
}

/** Render every page to one EPUB archive. */
export function renderEpub(
  doc: Document, pages: Page[], opts: EpubOptions,
): Uint8Array {
  const parts: EpubPart[] = [];

  // Image identity is the hash of the ENCODED BYTES, not the PdfStream object:
  // a merged document holds distinct stream objects with identical content.
  // mdexport.ts's rule, reused rather than re-derived.
  const seen = new Map<string, string>();
  const images: HtmlImageSink = {
    href(stream: PdfStream): string | undefined {
      const enc = encodeImage(doc, stream, [0, 0, 0]);
      if (!enc) return undefined;
      const key = createHash('sha256').update(enc.bytes).digest('hex');
      const hit = seen.get(key);
      if (hit) return hit;
      const n = seen.size + 1;
      const path = `images/image${n}.${imageExtension(enc.mediaType)}`;
      parts.push({
        path, bytes: enc.bytes, mediaType: enc.mediaType, id: `img${n}`,
      });
      seen.set(key, path);
      return path;
    },
  };

  let body = '';
  try {
    body = semanticBody(doc, buildDocModel(doc, pages), images);
  } catch {
    // Degrade: emit whatever was produced, as ToDocx and ToHtml do. A
    // half-written EPUB that opens beats an exception.
  }

  const meta = doc.GetMetadata();
  const title = opts.title ?? meta.title ?? '';
  // 'und', not 'en': a missing dc:language makes the file invalid so something
  // must be written, but claiming English states a fact the PDF never did.
  const language = opts.language ?? doc.Lang ?? 'und';
  const author = opts.author ?? meta.author;

  const content = xhtml(title, language, body);
  const nav = xhtml(title, language,
    '<nav epub:type="toc" id="toc">\n'
    + `<ol><li><a href="content.xhtml">${esc(title || 'Start')}</a></li></ol>\n`
    + '</nav>');

  parts.push({
    path: 'nav.xhtml', bytes: utf8(nav),
    mediaType: 'application/xhtml+xml', id: 'nav', properties: 'nav',
  });
  parts.push({
    path: 'content.xhtml', bytes: utf8(content),
    mediaType: 'application/xhtml+xml', id: 'content', spine: true,
  });

  const identifier = opts.identifier ?? idFromTrailer(doc)
    ?? `urn:sha256:${createHash('sha256').update(content).digest('hex')}`;

  const epubMeta: EpubMetadata = { identifier, title, language };
  if (author) epubMeta.author = author;
  return writeEpub(parts, epubMeta);
}
```

- [ ] **Step 4: Add `ToEpub` to `Document`**

In `src/document.ts`, import beside the DOCX import:

```typescript
import { renderEpub, type EpubOptions } from './epubexport.js';
```

Re-export the option type where the other export option types are re-exported:

```typescript
export type { EpubOptions } from './epubexport.js';
```

And add the method next to `ToDocx`:

```typescript
  /** Render every page to one EPUB 3 archive.
   *
   *  Reflows over the same model ToHtml, ToMarkdown and ToDocx read, as a
   *  single content document; chapter splitting is future work. Images travel
   *  inside the package, so there is no assets variant. Never throws. */
  ToEpub(options?: EpubOptions): Uint8Array {
    return renderEpub(this, this.Pages, options ?? {});
  }
```

There is deliberately no `Page.ToEpub`: a book is a document, and a one-page EPUB is not a thing anyone wants.

- [ ] **Step 5: Export from `src/index.ts`**

Add `EpubOptions` to the type exports, beside `DocxOptions`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/epub-export.test.ts`
Expected: PASS, all seven.

- [ ] **Step 7: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: all green, with no snapshot movement anywhere.

- [ ] **Step 8: Update the three docs**

`README.md` — add a Features bullet after the DOCX one, in the same voice:

```markdown
- **Export (PDF → EPUB)** — `doc.ToEpub(options?)` writes a valid EPUB 3 archive as `Uint8Array`, over the same neutral model the HTML, Markdown and DOCX exports read. The archive carries an OCF container (a stored, first-entry `mimetype`, so readers can identify the file without inflating it), an OPF package document with metadata, manifest and spine, a navigation document, one XHTML content document, and each distinct image as its own part. `dc:identifier` comes from an option, else the PDF's own trailer `/ID`, else a hash of the content — every branch deterministic, so two exports of one input are byte-identical. `dc:language` defaults to `und` rather than `en`: something must be written or the file is invalid, but claiming English would state a fact the PDF never did. Chapter splitting and a full TOC are future work; the navigation document is valid and minimal.
```

Add a Limitations bullet:

```markdown
- **EPUB export is single-chapter** — `ToEpub` emits the whole document as one XHTML content document with a minimal navigation document, so a reader shows one long chapter rather than a chapter list. Splitting at headings with a real TOC is future work. Structural conformance to EPUB 3 is tested; no CI here can open a reader, so opening in Calibre or iBooks is unverified, exactly as Word compatibility is for the DOCX export.
```

`CLAUDE.md` — add a module bullet after the DOCX entries:

```markdown
- **epub.ts**, **epubexport.ts** — EPUB 3 export (`Document.ToEpub`), the fourth
  serializer over `docmodel.ts`. `epub.ts` is the OCF container and OPF package
  writer and is pure — it imports `zip.ts` and nothing else, so mimetype
  placement, manifest/spine consistency and the OPF grammar are testable from
  hand-built part lists; `epubexport.ts` is the only module here that reads a
  `Document`, the split `svgdraw.ts`/`svgembed.ts` already make.
  **Invariant:** `mimetype` is the FIRST entry and is STORED. A reader
  identifies an EPUB by reading `application/epub+zip` at byte 38 without
  inflating anything, so deflating it or emitting it second leaves a valid ZIP
  holding all the right parts that is no longer recognisable as an EPUB. It is
  the one rule a structural "are the parts present" test cannot see, which is
  why it is asserted on the archive's raw bytes.
  **Invariant:** a manifest href is relative to the OPF's own directory, not the
  archive root — the same trap `ooxml.ts` records for a relationship target.
  **Invariant:** every identifier branch is deterministic (option, then the
  trailer `/ID`, then a hash of the content). `zip.ts` fixes its timestamps so
  two runs give identical bytes, and a generated UUID would undo that for the
  whole format.
  **Invariant:** `dc:language` defaults to `und`, never `en`. A missing language
  makes the file invalid so something must be written, but claiming English
  states a fact the document never did — the refusal to invent that also keeps
  `<strong>` out of the HTML export.
  **Invariant:** content documents are XHTML, which is why `htmlsemantic.ts`
  self-closes its void elements for BOTH exports rather than behind a flag. One
  dialect, valid as HTML5 and as XHTML, cannot drift between the two consumers.
```

`CHANGELOG.md` — add under `### Added`, as the newest entry:

```markdown
- **PDF to EPUB export** — `doc.ToEpub(options?)` writes a valid EPUB 3 archive over the same neutral model the HTML, Markdown and DOCX exports read: an OCF container, an OPF package document, a navigation document, one XHTML content document and each distinct image as its own part. The `mimetype` entry is stored and first, which is what lets a reader identify the file at a fixed byte offset without inflating it — the one rule a "are all the parts present" test cannot see, so it is asserted on the raw archive bytes. `dc:identifier` resolves from an option, then the PDF's own trailer `/ID`, then a hash of the content, every branch deterministic, so two exports of one input are byte-identical; `dc:language` defaults to `und` rather than `en`, because a missing language makes the file invalid but claiming English would state a fact the PDF never did. Chapter splitting and a full TOC are future work. Structural conformance to EPUB 3 is tested; as with Word and the DOCX export, no CI here can open a reader. (`zwto.1`)
```

- [ ] **Step 9: Commit**

```bash
git add src/epub.ts src/epubexport.ts src/document.ts src/index.ts \
        test/epub-export.test.ts README.md CLAUDE.md CHANGELOG.md
git commit -m "feat(epub): Document.ToEpub — a valid single-chapter EPUB 3

The fourth serializer over docmodel.ts, after HTML, Markdown and DOCX. Content
comes from semanticBody through the image sink added for this, so an image
becomes a package part rather than a data: URI and the manifest names files
that exist.

dc:identifier resolves option -> trailer /ID -> hash of the content, all three
deterministic, because zip.ts fixes its timestamps so two runs give identical
bytes and a generated UUID would undo that for the whole format. dc:language
defaults to 'und': a missing language makes the file invalid so something must
be written, but claiming 'en' states a fact the PDF never did.

Chapter splitting and a real TOC are zwto.2; opening it in Calibre is zwto.3
and cannot be checked here, exactly as Word cannot be for ToDocx (zwto.1)."
```

---

## Done when

- `npm run typecheck` and `npm test` are green.
- `doc.ToEpub()` returns an archive whose manifest and spine fully resolve and whose XHTML parses.
- `test/html-identity.test.ts` moved exactly once, in Task 1, for the void-element spellings only.
- `README.md`, `CLAUDE.md` and `CHANGELOG.md` describe the feature.
- `bd close aspose-pdf-foss-for-ts-zwto.1` with a reason recording what shipped and what was measured.
