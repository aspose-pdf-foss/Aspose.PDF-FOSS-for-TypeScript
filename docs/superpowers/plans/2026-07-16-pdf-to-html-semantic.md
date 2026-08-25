# PDF → HTML export, Phase 1 (semantic mode) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `Page.ToHtml()` / `Document.ToHtml()` in `semantic` mode — reflowable HTML driven by the tagged structure tree when present, and by font-size-rank heuristics when not.

**Architecture:** Composition over new machinery. Three existing private helpers are lifted to shared homes so the exporter reuses them rather than copying (`deviceGray` → `colorspace.ts`, the `imageHref` family → `imagehref.ts`, `headingRanks` → `textrank.ts`), `StructElement` gains an ordered `Nodes` accessor so a renderer can walk interleaved text and child elements, and `htmlsemantic.ts` maps that onto HTML. `html.ts` owns the document shell and mode dispatch.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. No runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-16-pdf-to-html-export-design.md`
Issue: `aspose-pdf-foss-for-ts-hdx`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every relative import specifier carries the `.js` extension (e.g. `import { Page } from './page.js'`).
- **Strict TypeScript.** `npm run typecheck` must pass.
- **TDD:** test first, watch it fail, then implement.
- **`ToHtml` never throws** — matching `renderPageToSvg`, which catches and degrades to whatever was emitted.
- **Phase 1 ships `mode: 'semantic'` only.** `mode: 'fixed'` throws `UnsupportedFeatureError`.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` (`errors.ts`).
- Run `npm run typecheck` and `npm test` before closing the issue; both must be green.
- Target one test file with `npx vitest run test/<name>.test.ts`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/colorspace.ts` | Modify | Gains exported `deviceGray()` (de-duplicates 2 existing copies) |
| `src/pagerender.ts` | Modify | Drops its private `deviceGray`, imports it |
| `src/svgrender.ts` | Modify | Drops its private `deviceGray` + `imageHref` family, imports them |
| `src/imagehref.ts` | Create | Image XObject → `data:` URI (DCT passthrough, else PNG re-encode) |
| `src/textrank.ts` | Create | Font-size → heading-level ranking (`roundSize`, `dominantSize`, `headingRanks`) |
| `src/autotag.ts` | Modify | Drops those three private helpers, imports them |
| `src/struct.ts` | Modify | Gains `StructElement.Nodes` — ordered kids as elements + text runs |
| `src/html.ts` | Create | Entry points, document shell, `escapeHtml`, mode dispatch |
| `src/htmlsemantic.ts` | Create | Tagged StructTree walk; untagged heuristic fallback |
| `src/page.ts` | Modify | `Page.ToHtml` |
| `src/document.ts` | Modify | `Document.ToHtml` |
| `src/index.ts` | Modify | Export `HtmlOptions` |
| `test/html.test.ts` | Create | All Phase 1 tests |
| `test/helpers/build-html-fixtures.ts` | Create | Untagged fixture builder |
| `README.md` | Modify | Features, API overview, Limitations |

Deferred to Phase 2 (do **not** build here): `src/htmlfixed.ts`, `src/htmlfont.ts`, exporting `SvgSink`. Semantic mode emits no font styling at all — CSS font mapping is a fixed-mode concern, and inlining it would fight reflowability.

---

### Task 1: Lift `deviceGray` to `colorspace.ts`

Pure de-duplication, no behavior change. `deviceGray` is currently copy-pasted in `pagerender.ts` and `svgrender.ts`; Task 2 would add a third copy. Land it first so Task 2 imports rather than copies.

**Files:**
- Modify: `src/colorspace.ts`
- Modify: `src/pagerender.ts:100`
- Modify: `src/svgrender.ts:50`

**Interfaces:**
- Produces: `deviceGray(): ColorConverter` exported from `src/colorspace.ts`.

- [ ] **Step 1: Add the exported helper to `colorspace.ts`**

Append to `src/colorspace.ts`:

```ts
/** The DeviceGray converter: one component, replicated to R=G=B. */
export function deviceGray(): ColorConverter {
  return {
    components: 1,
    toRgb: (c) => { const v = Math.round((c[0] ?? 0) * 255); return [v, v, v]; },
    initial: () => [0, 0, 0],
  };
}
```

- [ ] **Step 2: Remove the copy in `pagerender.ts`**

Delete the private `function deviceGray(): ColorConverter { ... }` at `src/pagerender.ts:100`, and add `deviceGray` to the existing `./colorspace.js` import in that file.

- [ ] **Step 3: Remove the copy in `svgrender.ts`**

Delete the private `function deviceGray(): ColorConverter { ... }` at `src/svgrender.ts:50`, and add `deviceGray` to the existing `./colorspace.js` import in that file.

- [ ] **Step 4: Verify nothing changed**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; the full suite passes exactly as before (this task is behavior-preserving — any failure means the lift was not faithful).

- [ ] **Step 5: Commit**

```bash
git add src/colorspace.ts src/pagerender.ts src/svgrender.ts
git commit -m "refactor(hdx): lift deviceGray into colorspace.ts"
```

---

### Task 2: Lift the `imageHref` family into `src/imagehref.ts`

`SvgSink.imageHref` and its three collaborators are needed by the semantic exporter for `<img>` data URIs. They reach only for `this.doc`, so they lift cleanly as free functions taking `doc` first. `SvgSink` keeps a thin wrapper so its call sites are unchanged.

**Files:**
- Create: `src/imagehref.ts`
- Modify: `src/svgrender.ts:181-248`

**Interfaces:**
- Consumes: `deviceGray()` from `./colorspace.js` (Task 1).
- Produces: `imageHref(doc: Document, stream: PdfStream, fill: Rgb): string | undefined` from `src/imagehref.ts`. Returns a `data:` URI, or `undefined` when the image cannot be decoded. Never throws.

- [ ] **Step 1: Create `src/imagehref.ts`**

Move the four methods verbatim from `SvgSink`, converting `this.doc` to a `doc` parameter. Behavior must be identical.

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isName } from './types.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace, deviceGray, Rgb } from './colorspace.js';
import { ImageInfo } from './image.js';
import { encodePng, pngDataUri } from './pngencode.js';

function num(doc: Document, o: PdfObject | undefined): number {
  const v = doc.resolve(o);
  return typeof v === 'number' ? v : 0;
}

function isIndexedColorSpace(doc: Document, csObj: PdfObject | undefined): boolean {
  const r0 = doc.resolve(csObj);
  if (isArray(r0) && r0.length) {
    const h = doc.resolve(r0[0]);
    return isName(h) && (h.name === 'Indexed' || h.name === 'I');
  }
  return false;
}

function samplesToPng(
  doc: Document, dict: PdfDict, samples: Uint8Array, width: number, height: number,
): Uint8Array | undefined {
  const r = (o: PdfObject | undefined) => doc.resolve(o);
  const infl = (s: { dict: PdfDict; raw: Uint8Array }) => inflateStream(s as Parameters<typeof inflateStream>[0]);
  const bpc = num(doc, dict.get('BitsPerComponent')) || 8;
  if (bpc !== 8) return undefined;
  const csObj = dict.get('ColorSpace');
  const isIndexedCs = isIndexedColorSpace(doc, csObj);
  const cs = csObj !== undefined ? resolveColorSpace(csObj, r, infl) : deviceGray();
  const nc = cs.components;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let out: Rgb;
    if (isIndexedCs) out = cs.toRgb([samples[i] ?? 0]);
    else {
      const comps: number[] = [];
      for (let k = 0; k < nc; k++) comps.push((samples[i * nc + k] ?? 0) / 255);
      out = cs.toRgb(comps);
    }
    rgb[i * 3] = out[0]; rgb[i * 3 + 1] = out[1]; rgb[i * 3 + 2] = out[2];
  }
  return encodePng(width, height, rgb, 'rgb');
}

function maskHref(bits: Uint8Array, width: number, height: number, fill: Rgb): string {
  const rowBytes = Math.ceil(width / 8);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (bits[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const i = (y * width + x) * 4;
      const paint = bit === 0;
      rgba[i] = fill[0]; rgba[i + 1] = fill[1]; rgba[i + 2] = fill[2];
      rgba[i + 3] = paint ? 255 : 0;
    }
  }
  return pngDataUri(encodePng(width, height, rgba, 'rgba'));
}

/** An image XObject as a `data:` URI: DCTDecode passes through as JPEG, an
 *  /ImageMask is painted with `fill`, everything decodable is re-encoded to PNG.
 *  Returns undefined when the image cannot be decoded. Never throws. */
export function imageHref(doc: Document, stream: PdfStream, fill: Rgb): string | undefined {
  const info = new ImageInfo(doc, '', stream);
  const filter = info.Filter;
  if (filter === 'DCTDecode' || filter === 'DCT') {
    return `data:image/jpeg;base64,${Buffer.from(info.RawData).toString('base64')}`;
  }
  try {
    const width = info.Width, height = info.Height;
    if (!width || !height) return undefined;
    const samples = info.Decode();
    const dict = stream.dict;
    if (doc.resolve(dict.get('ImageMask')) === true) return maskHref(samples, width, height, fill);
    const png = samplesToPng(doc, dict, samples, width, height);
    return png ? pngDataUri(png) : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: Replace the originals in `svgrender.ts` with a wrapper**

Delete the private `imageHref`, `samplesToPng`, `isIndexedColorSpace`, and `maskHref` methods from `SvgSink` (`src/svgrender.ts:181-248`). Add the import:

```ts
import { imageHref } from './imagehref.js';
```

and give `SvgSink` a wrapper so its existing call in `image()` is untouched:

```ts
  private imageHref(stream: PdfStream, fill: Rgb): string | undefined {
    return imageHref(this.doc, stream, fill);
  }
```

Remove any imports in `svgrender.ts` that are now unused (`ImageInfo`, `encodePng`, and `pngDataUri` are likely unused — `typecheck` under `noUnusedLocals` will tell you; delete only what it flags).

- [ ] **Step 3: Verify nothing changed**

Run: `npm run typecheck && npx vitest run test/svgrender.test.ts`
Expected: typecheck clean; every SVG test passes unchanged, including the JPEG and Flate image cases (`jpegImagePdf`, `flateImagePdf`). This task is behavior-preserving.

- [ ] **Step 4: Commit**

```bash
git add src/imagehref.ts src/svgrender.ts
git commit -m "refactor(hdx): lift imageHref family into imagehref.ts"
```

---

### Task 3: Lift `headingRanks` into `src/textrank.ts`

**Files:**
- Create: `src/textrank.ts`
- Modify: `src/autotag.ts:37-67`
- Test: `test/textrank.test.ts`

**Interfaces:**
- Produces, from `src/textrank.ts`:
  - `roundSize(s: number): number` — rounds to the nearest half point.
  - `dominantSize(block: TextBlock): number` — the size bucket holding the most characters in that block.
  - `headingRanks(doc: Document): Map<number, number>` — rounded font size → heading level 1–6. The size with the most characters document-wide is body text and is absent from the map; larger distinct sizes rank descending.

- [ ] **Step 1: Write the failing test**

Create `test/textrank.test.ts`. `buildHtmlPdf` does not exist yet — this test uses the existing SVG fixture builder, which can place arbitrary content with a Helvetica resource.

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf, HELV_RESOURCES } from './helpers/build-svg-fixtures.js';
import { headingRanks, roundSize } from '../src/textrank.js';

describe('textrank', () => {
  it('rounds sizes to the nearest half point', () => {
    expect(roundSize(12)).toBe(12);
    expect(roundSize(12.2)).toBe(12);
    expect(roundSize(12.3)).toBe(12.5);
  });

  it('ranks larger sizes as headings and omits body text', () => {
    // Body text at 12pt dominates by character count; 24pt and 18pt are headings.
    const content = [
      'BT /F1 24 Tf 50 350 Td (Big) Tj ET',
      'BT /F1 18 Tf 50 320 Td (Med) Tj ET',
      'BT /F1 12 Tf 50 290 Td (body body body body body body) Tj ET',
    ].join('\n');
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 400, 400], content, resources: HELV_RESOURCES }));
    const ranks = headingRanks(doc);
    expect(ranks.get(24)).toBe(1);
    expect(ranks.get(18)).toBe(2);
    expect(ranks.has(12)).toBe(false); // body text is not a heading
  });
});
```

Check the `buildSvgPdf` signature in `test/helpers/build-svg-fixtures.ts` before writing; if its resources parameter is named differently, match the existing call style used in `test/svgrender.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/textrank.test.ts`
Expected: FAIL — cannot resolve `../src/textrank.js`.

- [ ] **Step 3: Create `src/textrank.ts`**

Move the three helpers verbatim out of `src/autotag.ts` (lines ~37–67), exporting each:

```ts
import type { Document } from './document.js';
import type { TextBlock } from './text.js';

/** Round a font size to the nearest half point so near-identical sizes bucket together. */
export function roundSize(s: number): number { return Math.round(s * 2) / 2; }

/** The size bucket with the most characters among a block's fragments. */
export function dominantSize(block: TextBlock): number {
  const chars = new Map<number, number>();
  for (const line of block.lines) for (const f of line.fragments) {
    const sz = roundSize(f.fontSize);
    chars.set(sz, (chars.get(sz) ?? 0) + f.text.length);
  }
  let best = 0, bestC = -1;
  for (const [sz, c] of chars) if (c > bestC) { bestC = c; best = sz; }
  return best;
}

/** Heading-size → level map (largest = H1, capped at H6), from every fragment
 *  across the document: the size with the most characters is body text; larger
 *  distinct sizes become headings. */
export function headingRanks(doc: Document): Map<number, number> {
  const chars = new Map<number, number>();
  for (const page of doc.Pages) for (const block of page.GetStructuredText()) {
    for (const line of block.lines) for (const f of line.fragments) {
      const sz = roundSize(f.fontSize);
      chars.set(sz, (chars.get(sz) ?? 0) + f.text.length);
    }
  }
  let bodySize = 0, bodyChars = -1;
  for (const [sz, c] of chars) if (c > bodyChars) { bodyChars = c; bodySize = sz; }
  const larger = [...chars.keys()].filter((s) => s > bodySize + 0.5).sort((a, b) => b - a);
  const ranks = new Map<number, number>();
  larger.forEach((s, i) => ranks.set(s, Math.min(i + 1, 6)));
  return ranks;
}
```

- [ ] **Step 4: Import them back in `autotag.ts`**

Delete `roundSize`, `dominantSize`, and `headingRanks` from `src/autotag.ts` and add:

```ts
import { dominantSize, headingRanks, roundSize } from './textrank.js';
```

Drop any of the three from the import that `typecheck` reports as unused.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/textrank.test.ts && npx vitest run test/autotag.test.ts`
Expected: both PASS. The autotag suite is the regression gate for the lift.

- [ ] **Step 6: Commit**

```bash
git add src/textrank.ts src/autotag.ts test/textrank.test.ts
git commit -m "refactor(hdx): lift headingRanks into textrank.ts"
```

---

### Task 4: Add `StructElement.Nodes`

The tagged walk must preserve **interleaving** of an element's own text and its child elements — a `Link` inside a `P` is ordinary, and the existing public API loses that order (`Children` returns elements only, `ContentItems` returns MCIDs only). Without this, mixed-content text is dropped and the round-trip criterion in Task 8 cannot pass. `struct.ts` already walks `/K` in order privately via `kids()`; this exposes it in the form a renderer needs.

**Files:**
- Modify: `src/struct.ts`
- Test: `test/struct.test.ts` (append)

**Interfaces:**
- Produces, from `src/struct.ts`:
  - `export type StructTextNode = { kind: 'text'; text: string; page: Page }`
  - `export type StructNode = StructElement | StructTextNode`
  - `StructElement.Nodes: StructNode[]` — direct kids in `/K` order. MCID and MCR kids resolve to their text; OBJR kids are skipped (no text contribution, matching `GetText`).

- [ ] **Step 1: Write the failing test**

Append to `test/struct.test.ts`:

```ts
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';

describe('StructElement.Nodes', () => {
  it('returns child elements and text runs in /K order, with each text run\'s page', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const root = doc.GetStructTree()!;
    const document = root.Children[0];          // Document (obj 8)
    const sect = document.Children[0];          // Sect (obj 13), spans both pages
    const nodes = sect.Nodes;
    expect(nodes).toHaveLength(2);              // P on page 1, P on page 2
    expect(nodes.every((n) => n instanceof StructElement)).toBe(true);

    const p1 = sect.Children[0];
    const textNodes = p1.Nodes;
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0]).toMatchObject({ kind: 'text', text: 'Page one body' });
    expect((textNodes[0] as { page: unknown }).page).toBe(doc.Pages[0]);
  });

  it('skips OBJR kids', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const root = doc.GetStructTree()!;
    const figure = root.Children[0].Children[1]; // Figure (obj 14), /K is an OBJR
    expect(figure.Nodes).toEqual([]);
  });
});
```

Add `StructElement` to the existing `../src/struct.js` import in that file if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct.test.ts`
Expected: FAIL — `sect.Nodes` is undefined.

- [ ] **Step 3: Implement `Nodes`**

Add to `src/struct.ts`, above the `StructElement` class:

```ts
/** A run of text contributed directly by a structure element, with the page it sits on. */
export interface StructTextNode { kind: 'text'; text: string; page: Page }

/** A structure element's direct kid: a child element or a run of its own text. */
export type StructNode = StructElement | StructTextNode;
```

Add this accessor to `StructElement`, next to `ContentItems`. It mirrors `GetText`'s traversal exactly, but yields nodes instead of concatenating, and does not recurse:

```ts
  /** This element's direct kids in /K (reading) order: child elements and its
   *  own text runs, interleaved as authored. OBJR kids are skipped — they carry
   *  no text, matching `GetText`. Unlike `Children` + `ContentItems`, this
   *  preserves the order between the two, which a renderer needs. */
  get Nodes(): StructNode[] {
    const out: StructNode[] = [];
    const ownPage = this.Page;
    const textNode = (page: Page | undefined, mcid: number): void => {
      if (!page) return;
      out.push({ kind: 'text', text: glyphsToText(mcidGlyphs(this.doc, page).get(mcid) ?? []), page });
    };
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        textNode(ownPage, r);
      } else if (isStructElem(this.doc, k)) {
        out.push(new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root));
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        if (isName(type) && type.name === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          const pg = r.get('Pg');
          if (typeof mcid === 'number') textNode(isRef(pg) ? this.doc.pageForRef(pg) : ownPage, mcid);
        }
        // OBJR: no text contribution.
      }
    }
    return out;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/struct.test.ts`
Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 5: Commit**

```bash
git add src/struct.ts test/struct.test.ts
git commit -m "feat(hdx): add StructElement.Nodes for ordered kid traversal"
```

---

### Task 5: `html.ts` shell + API wiring (walking skeleton)

Land the public API end-to-end with an empty body, so the shell, escaping, options, and both entry points are testable before any content generation exists.

**Files:**
- Create: `src/html.ts`
- Modify: `src/page.ts`, `src/document.ts`, `src/index.ts`
- Test: `test/html.test.ts`

**Interfaces:**
- Produces:
  - `HtmlOptions` (from `src/html.ts`, re-exported as a type from `index.ts`): `{ mode?: 'semantic' | 'fixed'; box?: 'crop' | 'media'; annotations?: boolean; fragment?: boolean; title?: string }`
  - `escapeHtml(s: string): string` — escapes `&`, `<`, `>`, `"`.
  - `renderPageToHtml(doc: Document, page: Page, opts?: HtmlOptions): string`
  - `renderDocumentToHtml(doc: Document, opts?: HtmlOptions): string`
  - `Page.ToHtml(options?: HtmlOptions): string`
  - `Document.ToHtml(options?: HtmlOptions): string`
- Consumes in Task 6/7: `escapeHtml`, and the `bodyFor` seam described in Step 3.

- [ ] **Step 1: Write the failing test**

Create `test/html.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { escapeHtml } from '../src/html.js';

describe('ToHtml — shell', () => {
  it('returns a standalone HTML document', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    const html = doc.Pages[0].ToHtml();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('omits the shell for fragment: true', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    const html = doc.Pages[0].ToHtml({ fragment: true });
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toContain('<html');
  });

  it('uses the title option, escaped', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    expect(doc.ToHtml({ title: 'A & B' })).toContain('<title>A &amp; B</title>');
  });

  it('rejects the unimplemented fixed mode', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    expect(() => doc.ToHtml({ mode: 'fixed' })).toThrow(UnsupportedFeatureError);
  });

  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/html.test.ts`
Expected: FAIL — cannot resolve `../src/html.js`.

- [ ] **Step 3: Create `src/html.ts`**

`bodyFor` is the seam Tasks 6 and 7 fill in; it returns `''` for now.

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { UnsupportedFeatureError } from './errors.js';

/** Options for {@link Page.ToHtml} and {@link Document.ToHtml}. */
export interface HtmlOptions {
  /** Reflowable semantic markup, or positioned page reproduction.
   *  Default 'semantic'. 'fixed' is not implemented yet and throws. */
  mode?: 'semantic' | 'fixed';
  /** Which page box defines the page size. Default 'crop'. 'fixed' mode only. */
  box?: 'crop' | 'media';
  /** Composite annotation and form-field /AP appearances. Default true. */
  annotations?: boolean;
  /** Emit only body markup, without the doctype/head/CSS shell. Default false. */
  fragment?: boolean;
  /** <title> text. Defaults to the document's /Info /Title, else ''. */
  title?: string;
}

/** Escape a string for use in HTML text or a double-quoted attribute value. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

const CSS = [
  'body{font-family:serif;margin:2em auto;max-width:45em;line-height:1.5}',
  'table{border-collapse:collapse}',
  'td,th{border:1px solid #999;padding:.25em .5em}',
  'img{max-width:100%}',
].join('');

function shell(doc: Document, body: string, opts: HtmlOptions): string {
  const title = opts.title ?? doc.GetMetadata().Title ?? '';
  const lang = doc.Lang;
  const langAttr = lang ? ` lang="${escapeHtml(lang)}"` : '';
  return `<!doctype html>\n<html${langAttr}>\n<head>\n<meta charset="utf-8">\n`
    + `<title>${escapeHtml(title)}</title>\n<style>${CSS}</style>\n</head>\n`
    + `<body>\n${body}\n</body>\n</html>\n`;
}

/** The body markup for `pages`. Filled in by Tasks 6 and 7. */
function bodyFor(doc: Document, pages: Page[], opts: HtmlOptions): string {
  void doc; void pages; void opts;
  return '';
}

function render(doc: Document, pages: Page[], opts: HtmlOptions): string {
  const mode = opts.mode ?? 'semantic';
  if (mode === 'fixed') {
    throw new UnsupportedFeatureError("ToHtml: mode 'fixed' is not implemented yet");
  }
  let body = '';
  try {
    body = bodyFor(doc, pages, opts);
  } catch {
    // Degrade: emit a well-formed shell around whatever was produced. Matches
    // renderPageToSvg, which never throws.
  }
  return opts.fragment ? body : shell(doc, body, opts);
}

/** Render one page to HTML. Never throws (except for an unimplemented mode). */
export function renderPageToHtml(doc: Document, page: Page, opts: HtmlOptions = {}): string {
  return render(doc, [page], opts);
}

/** Render every page to one HTML document. Never throws (except for an unimplemented mode). */
export function renderDocumentToHtml(doc: Document, opts: HtmlOptions = {}): string {
  return render(doc, doc.Pages, opts);
}
```

Confirm the metadata accessor before writing: `doc.GetMetadata()` returning a `Metadata` with `Title` is the expectation (see `src/metadata.ts` and `index.ts`'s `Metadata` export). If the real accessor differs, use the real one and keep the `?? ''` fallback.

- [ ] **Step 4: Wire up `Page.ToHtml`**

In `src/page.ts`, add the import:

```ts
import { renderPageToHtml, HtmlOptions } from './html.js';
```

and the method, next to `ToSvg`:

```ts
  /** Render this page to a standalone HTML document. In the default 'semantic'
   *  mode the output is reflowable markup driven by the tagged structure tree
   *  when the document has one, and by font-size heuristics when it does not.
   *  Pass `fragment: true` for body markup only. */
  ToHtml(options?: HtmlOptions): string {
    return renderPageToHtml(this.doc, this, options);
  }
```

- [ ] **Step 5: Wire up `Document.ToHtml`**

In `src/document.ts`, add the import:

```ts
import { renderDocumentToHtml, HtmlOptions } from './html.js';
```

and the method, next to `GetStructTree`:

```ts
  /** Render every page to one standalone HTML document. See `Page.ToHtml`. */
  ToHtml(options?: HtmlOptions): string {
    return renderDocumentToHtml(this, options);
  }
```

- [ ] **Step 6: Export the option type**

In `src/index.ts`, next to the `SvgOptions` export line:

```ts
export type { HtmlOptions } from './html.js';
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/html.test.ts && npm run typecheck`
Expected: all 5 shell tests PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/html.ts src/page.ts src/document.ts src/index.ts test/html.test.ts
git commit -m "feat(hdx): ToHtml document shell and API wiring"
```

---

### Task 6: Untagged semantic body

**Files:**
- Create: `src/htmlsemantic.ts`
- Create: `test/helpers/build-html-fixtures.ts`
- Modify: `src/html.ts` (replace the `bodyFor` stub)
- Test: `test/html.test.ts` (append)

**Interfaces:**
- Consumes: `escapeHtml` (Task 5); `headingRanks`, `dominantSize` (Task 3); `imageHref` (Task 2).
- Produces: `untaggedBody(doc: Document, pages: Page[], ranks: Map<number, number>): string` from `src/htmlsemantic.ts`.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-html-fixtures.ts`. Mirror the structure of `test/helpers/build-multipage-tagged-pdf.ts` (read it first — same classic-xref assembly, same `enc`/`byteLen` helpers).

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Single-page untagged PDF: one 24pt heading over 12pt body text, Helvetica. */
export function buildUntaggedHtmlPdf(): Uint8Array {
  const content = [
    'BT /F1 24 Tf 50 350 Td (Quarterly Report) Tj ET',
    'BT /F1 12 Tf 50 320 Td (Revenue grew twelve percent this year.) Tj ET',
  ].join('\n');

  const o: string[] = [];
  o[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  o[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  o[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`;
  o[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  o[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  const maxObj = 5;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${o[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

Copy the exact xref/trailer tail from `build-multipage-tagged-pdf.ts` rather than trusting the sketch above — match that file byte-for-byte in its assembly, changing only the objects.

- [ ] **Step 2: Write the failing test**

Append to `test/html.test.ts`:

```ts
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';

describe('ToHtml — untagged semantic', () => {
  it('ranks the larger size as a heading and body text as a paragraph', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<h1>Quarterly Report</h1>');
    expect(html).toContain('<p>Revenue grew twelve percent this year.</p>');
  });

  it('escapes text content', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).not.toContain('<script');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/html.test.ts`
Expected: FAIL — body is empty, so `<h1>` is missing.

- [ ] **Step 4: Create `src/htmlsemantic.ts`**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { Rect, TextBlock } from './text.js';
import type { Table } from './tablemodel.js';
import { dominantSize } from './textrank.js';
import { imageHref } from './imagehref.js';
import { escapeHtml } from './html.js';

/** True when the center of `box` lies inside `region`. */
function centerInside(box: Rect, region: Rect): boolean {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const x0 = Math.min(region[0], region[2]), x1 = Math.max(region[0], region[2]);
  const y0 = Math.min(region[1], region[3]), y1 = Math.max(region[1], region[3]);
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

/** A block's text as one escaped run; internal line breaks become spaces, since
 *  semantic output reflows. */
function blockHtml(block: TextBlock, ranks: Map<number, number>): string {
  const text = escapeHtml(block.text.replace(/\n/g, ' ')).trim();
  if (!text) return '';
  const level = ranks.get(dominantSize(block));
  return level ? `<h${level}>${text}</h${level}>` : `<p>${text}</p>`;
}

function imagesHtml(doc: Document, page: Page): string {
  const out: string[] = [];
  for (const img of page.Images) {
    const href = imageHref(doc, img.Stream, [0, 0, 0]);
    if (href) out.push(`<img src="${href}" alt="">`);
  }
  return out.join('\n');
}

/** Body markup for untagged pages: heading/paragraph blocks, tables, images. */
export function untaggedBody(doc: Document, pages: Page[], ranks: Map<number, number>): string {
  const out: string[] = [];
  for (const page of pages) {
    const tables: Table[] = page.GetTables();
    const blocks = page.GetStructuredText();
    for (const block of blocks) {
      // A block absorbed by a table is emitted as part of that table, not twice.
      if (tables.some((t) => centerInside(block.quad, t.quad))) continue;
      const html = blockHtml(block, ranks);
      if (html) out.push(html);
    }
    for (const t of tables) out.push(t.toHtml());
    const imgs = imagesHtml(doc, page);
    if (imgs) out.push(imgs);
  }
  return out.join('\n');
}
```

`page.Images` and `ImageInfo`'s stream accessor: check `src/image.ts` and `src/page.ts` for the real names. `ImageInfo.stream` is **private** — you will need to either add a public `Stream` getter to `ImageInfo` or use `collectImages`; prefer adding `get Stream(): PdfStream { return this.stream; }` to `ImageInfo`, which is the smaller change and mirrors its existing public `Dict` getter. Commit that with this task.

- [ ] **Step 5: Replace the `bodyFor` stub in `html.ts`**

```ts
import { untaggedBody } from './htmlsemantic.js';
import { headingRanks } from './textrank.js';
```

```ts
function bodyFor(doc: Document, pages: Page[], opts: HtmlOptions): string {
  void opts;
  return untaggedBody(doc, pages, headingRanks(doc));
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/html.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/htmlsemantic.ts src/html.ts src/image.ts test/html.test.ts test/helpers/build-html-fixtures.ts
git commit -m "feat(hdx): untagged semantic HTML body"
```

---

### Task 7: Tagged semantic body + per-page filtering

**Files:**
- Modify: `src/htmlsemantic.ts`, `src/html.ts`
- Test: `test/html.test.ts` (append)

**Interfaces:**
- Consumes: `StructElement.Nodes`, `StructNode`, `StructTextNode` (Task 4); `escapeHtml` (Task 5).
- Produces: `taggedBody(doc: Document, root: StructTreeRoot, only: Page | undefined): string` from `src/htmlsemantic.ts`. `only` restricts output to one page's content; `undefined` emits the whole tree.

- [ ] **Step 1: Write the failing test**

Append to `test/html.test.ts`:

These reuse three existing builders — read each before writing to confirm the
tree shape documented in its header comment. `buildTaggedPdf` already carries a
RoleMap heading, an `/ActualText` paragraph, an `/Alt` figure, and `/Lang`;
`buildTaggedTablePdf` already carries a `THead`/`TBody` table.

```ts
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';

describe('ToHtml — tagged semantic', () => {
  it('drives markup from the structure tree', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<p>Page one body</p>');
    expect(html).toContain('<p>Page two body</p>');
    expect(html).toContain('<div>');            // Document/Sect wrappers
  });

  it('uses /Alt as a figure\'s alt text', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('alt="A figure"');
  });

  it('resolves a custom role through the RoleMap to a heading', () => {
    // MyHead -> SubHead -> H2.
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.ToHtml({ fragment: true })).toContain('<h2');
  });

  it('emits /Lang on an element that declares one', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.ToHtml({ fragment: true })).toContain('lang="en-GB"');
  });

  it('lets /ActualText replace the element\'s glyph text', () => {
    const doc = Document.Open(buildTaggedPdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<p>Body paragraph actual</p>');
  });

  it('renders a tagged table through Table.toHtml', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const html = doc.ToHtml({ fragment: true });
    expect(html).toContain('<table>');
    expect(html).toContain('<caption>Employee directory</caption>');
    expect(html).toContain('<thead>');
    expect(html).toContain('scope="Column"');
    // Exactly one table, despite the walk visiting the Table element once.
    expect(html.match(/<table>/g)).toHaveLength(1);
  });

  it('keeps only this page\'s elements, with ancestor nesting intact', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = doc.Pages[1].ToHtml({ fragment: true });
    expect(html).toContain('<p>Page two body</p>');
    expect(html).not.toContain('Page one body');
    expect(html).not.toContain('alt="A figure"');   // Figure is on page 1
    // The Sect ancestor survives around the kept P.
    expect(html).toMatch(/<div>[\s\S]*<p>Page two body<\/p>[\s\S]*<\/div>/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/html.test.ts`
Expected: FAIL — tagged output is not implemented, so the untagged path emits bare paragraphs with no wrappers and no `alt`.

- [ ] **Step 3: Implement the tagged walk in `htmlsemantic.ts`**

Add the imports:

```ts
import { StructElement, StructTreeRoot, type StructNode, type StructTextNode } from './struct.js';
import { extractTaggedTables } from './tablestruct.js';
```

and:

```ts
/** Standard structure type → HTML tag. Types absent here fall back to <div>. */
const TAG_FOR: Record<string, string> = {
  P: 'p', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6',
  L: 'ul', LI: 'li', Span: 'span', Link: 'a',
  Document: 'div', Part: 'div', Sect: 'div', Div: 'div', Art: 'div', TOC: 'div', TOCI: 'div',
};

function isText(n: StructNode): n is StructTextNode {
  return !(n instanceof StructElement);
}

/** Walk state. `tables` memoizes each page's tagged tables so that N `Table`
 *  elements on one page consume N distinct tables rather than each re-extracting
 *  the whole page. Both walks are tree-order over the same tree, so the k-th
 *  `Table` element on a page is the k-th extracted table. */
interface Ctx {
  doc: Document;
  only: Page | undefined;
  tables: Map<Page, { list: Table[]; next: number }>;
}

/** The next unconsumed tagged table on `page`, or undefined when none remain. */
function nextTable(ctx: Ctx, page: Page | undefined): Table | undefined {
  if (!page) return undefined;
  let entry = ctx.tables.get(page);
  if (!entry) {
    entry = { list: extractTaggedTables(ctx.doc, page), next: 0 };
    ctx.tables.set(page, entry);
  }
  return entry.list[entry.next++];
}

/** True when this element contributes any content on `only` (or `only` is undefined). */
function onPage(el: StructElement, only: Page | undefined): boolean {
  if (!only) return true;
  const nodes = el.Nodes;
  if (!nodes.length) return el.Page === only;      // e.g. a Figure whose /K is an OBJR
  return nodes.some((n) => (isText(n) ? n.page === only : onPage(n, only)));
}

function elementHtml(ctx: Ctx, el: StructElement): string {
  if (!onPage(el, ctx.only)) return '';
  const type = el.StandardType;

  if (type === 'Table') {
    // Consume this page's next table even when filtered out, so the pairing
    // between Table elements and extracted tables stays aligned.
    const table = nextTable(ctx, el.Page);
    return table ? table.toHtml() : '';
  }
  if (type === 'Figure') {
    const alt = el.Alt ?? el.ActualText ?? '';
    return `<img alt="${escapeHtml(alt)}">`;
  }

  // ActualText replaces the subtree's own text entirely.
  const actual = el.ActualText;
  const inner = actual !== undefined
    ? escapeHtml(actual)
    : el.Nodes.map((n) => (isText(n)
        ? (ctx.only && n.page !== ctx.only ? '' : escapeHtml(n.text))
        : elementHtml(ctx, n))).filter((s) => s).join('');

  if (!inner) return '';
  const tag = TAG_FOR[type] ?? 'div';
  const lang = el.Lang ? ` lang="${escapeHtml(el.Lang)}"` : '';
  return `<${tag}${lang}>${inner}</${tag}>`;
}

/** Body markup driven by the structure tree. `only` restricts to one page. */
export function taggedBody(doc: Document, root: StructTreeRoot, only: Page | undefined): string {
  const ctx: Ctx = { doc, only, tables: new Map() };
  return root.Children.map((c) => elementHtml(ctx, c)).filter((s) => s).join('\n');
}
```

`Lbl` and `LBody` are absent from `TAG_FOR` deliberately: they fall to `<div>` inside their `<li>`. Nesting stays correct and no text is lost. Refining list internals is out of scope for Phase 1 (see the spec's Out of scope).

- [ ] **Step 4: Dispatch on tagged-ness in `html.ts`**

```ts
import { taggedBody, untaggedBody } from './htmlsemantic.js';
```

```ts
function bodyFor(doc: Document, pages: Page[], opts: HtmlOptions): string {
  void opts;
  const root = doc.GetStructTree();
  if (root) {
    // The tree spans pages: walk it once, restricted to a single page when
    // that is all that was asked for, so an element crossing a page break
    // stays one element.
    const only = pages.length === 1 && doc.Pages.length > 1 ? pages[0] : undefined;
    return taggedBody(doc, root, only);
  }
  return untaggedBody(doc, pages, headingRanks(doc));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/html.test.ts && npm run typecheck`
Expected: all tagged and untagged tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/htmlsemantic.ts src/html.ts test/html.test.ts
git commit -m "feat(hdx): tagged semantic HTML body with per-page filtering"
```

---

### Task 8: Round-trip criterion, README, close

**Files:**
- Test: `test/html.test.ts` (append)
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above. Produces nothing new.

- [ ] **Step 1: Write the round-trip test**

This is the issue's acceptance criterion: no text is lost or duplicated. Append to `test/html.test.ts`:

```ts
/** Strip tags and decode the entities escapeHtml produces. */
function htmlText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

describe('ToHtml — round-trip', () => {
  it('preserves untagged page text', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const expected = htmlText(escapeHtml(doc.Pages[0].GetText()));
    expect(htmlText(doc.ToHtml({ fragment: true }))).toBe(expected);
  });

  it('preserves tagged document text', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const text = htmlText(doc.ToHtml({ fragment: true }));
    expect(text).toContain('Page one body');
    expect(text).toContain('Page two body');
    // Each run appears exactly once.
    expect(text.match(/Page one body/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/html.test.ts`
Expected: PASS. If the untagged case fails on word spacing, compare `htmlText` output against `GetText()` directly and fix the joining in `blockHtml` — do not weaken the assertion to make it pass.

- [ ] **Step 3: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: both green. The `autotag`, `struct`, `svgrender`, and table suites are the regression gates for Tasks 1–4.

- [ ] **Step 4: Update `README.md`**

Add `ToHtml` to **Features** and **API overview** alongside `ToSvg`/`ToImage`, with a short example:

```ts
const doc = Document.Open(bytes);
const html = doc.ToHtml();                    // semantic, whole document
const page = doc.Pages[0].ToHtml({ fragment: true });
```

Add to **Limitations**: `ToHtml` ships `semantic` mode only — `mode: 'fixed'` throws `UnsupportedFeatureError` pending Phase 2; untagged list reconstruction (`<ul>`/`<ol>`) and `@font-face` embedding are not implemented.

- [ ] **Step 5: Commit**

```bash
git add test/html.test.ts README.md
git commit -m "test(hdx): ToHtml round-trip criterion; docs(hdx): README"
```

- [ ] **Step 6: File the Phase 2 follow-ups and close**

```bash
bd create "PDF -> HTML export Phase 2: fixed mode" -t feature -p 3 \
  -d "Positioned-span HTML over an SvgSink backdrop, per docs/superpowers/specs/2026-07-16-pdf-to-html-export-design.md. BLOCKED on resolving text baseline placement: PDF anchors text by baseline, CSS by line-box top, and with CSS font mapping (no @font-face) the substitute ascent is not the PDF font's. Prototype against a real browser and measure drift before planning."
bd create "PDF -> HTML export: @font-face embedding" -t feature -p 4 \
  -d "Opt-in fonts: 'embed' — re-emit embedded font programs as base64 woff/otf data URIs for fixed mode. Needs an sfnt/CFF -> browser-font writer. Raises licensing questions."
bd close hdx
```

Then push, per CLAUDE.md's session-completion workflow:

```bash
git pull --rebase && git push && git status
```

---

## Notes for the implementer

- **The two lift tasks (1–3) are behavior-preserving.** If an existing test changes behavior, the lift was not faithful — fix the lift, do not update the test.
- **`ToHtml` never throws** except for `mode: 'fixed'`. `render()` catches body-generation failures and still emits a well-formed shell. Do not add throws to the semantic path.
- **Verified against source while planning:** `doc.GetMetadata(): Metadata`, `doc.Lang`, `page.Images: ImageInfo[]`, `extractTaggedTables(doc, page, options = {})`, and `buildSvgPdf({ mediaBox, cropBox, rotate, resources, content, extra })`. The one accessor that does **not** exist yet is `ImageInfo.Stream` — Task 6 adds it.
- **Fixture builders already carry what the tagged tests need.** Do not write new tagged fixtures: `buildTaggedPdf` has the RoleMap chain, `/ActualText`, `/Alt`, and `/Lang`; `buildTaggedTablePdf` has `THead`/`TBody`/`/Summary`/`/Scope`; `buildMultiPageTaggedPdf` has a page-spanning `Sect`. Read each file's header comment for the exact tree.
