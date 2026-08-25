# Feature Showcase Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Go library's `_examples/feature_showcase/main.go` to TypeScript as `_examples/feature-showcase/`, producing `docs/feature-showcase.pdf` — a fourteen-section document exercising every major capability of `aspose-pdf-foss-for-ts`.

**Architecture:** One module per section, each exporting a single function that fills one `Page`. `theme.ts` holds the shared vocabulary — a Go-shaped `Box` rectangle type, a Go-shaped `TextStyle`, and the `addText` adapter that maps them onto `page.AddTextBlock`. `main.ts` owns document scaffolding and the strict ordering the sections depend on. `verify.ts` re-opens the saved bytes and asserts the three claims the document makes about itself.

**Tech Stack:** TypeScript 5 (NodeNext, strict), the library's own `src/` (imported as `../../src/index.js`), `tsx` as the runner, `vitest` for the two pure-geometry helpers. No new runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. `tsx` is a **dev** dependency only.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension, including inside `_examples/` — e.g. `import { addText } from './theme.js'`.
- **The library is imported as `../../src/index.js`**, never from `dist/`.
- **PDF user space throughout:** origin bottom-left, points, y grows upward.
- **`Box` is `[llx, lly, urx, ury]`** — the Go `pdf.Rectangle` shape — so numeric literals port from the Go source verbatim. The library's own `AddImage`/`AddTextBlock`/`AddSVGObject` take `[x, y, w, h]`; `theme.xywh()` is the only place that conversion happens.
- **Colours are `[r, g, b]` in 0..1**; Go's alpha channel becomes a separate `opacity`.
- **Product naming:** `productName = 'Aspose.PDF FOSS for TypeScript'`, `docVersion = 'v0.0.0'` (from `package.json`), `docTitle = productName + ' — Feature Showcase'`, `docAuthor = 'Aspose'`.
- **Output path:** `docs/feature-showcase.pdf` (hyphens, matching this repo; the Go repo uses underscores).
- **Go reference source** lives at `_examples/feature-showcase/.reference/main.go` after Task 1 and is gitignored. Every "port lines N–M" instruction below cites that file.
- **Every task ends green on `npm run typecheck`.**

---

### Task 1: Scaffolding, runner, and assets

**Files:**
- Modify: `package.json` (devDependencies, scripts)
- Modify: `tsconfig.json` (include)
- Modify: `.gitignore`
- Create: `_examples/feature-showcase/assets/` (10 files + `PROVENANCE.md`)
- Create: `_examples/feature-showcase/assets.ts`
- Create: `_examples/feature-showcase/main.ts` (stub)

**Interfaces:**
- Consumes: nothing.
- Produces: `assets.ts` exporting
  `starryNight(): Uint8Array`, `newton(): Uint8Array`, `einstein(): Uint8Array`,
  `salesBanner(): Uint8Array`, `asposePinwheel(): Uint8Array`, `asposeLogo(): Uint8Array`,
  `githubMark(): Uint8Array`, `bookIcon(): Uint8Array`, `asposeLogoPng(): Uint8Array`,
  `dejaVuSansPath(): string`. Each memoizes its `readFileSync`.

- [ ] **Step 1: Declare the runner and wire the example into typecheck**

In `package.json`, add to `devDependencies` (keeping alphabetical order) and to `scripts`:

```json
"tsx": "^4.23.1"
```

```json
"example:showcase": "tsx _examples/feature-showcase/main.ts"
```

In `tsconfig.json`, change the include line to:

```json
"include": ["src", "test", "_examples"]
```

In `.gitignore`, append:

```
# Reference copy of the Go showcase, fetched by the feature-showcase example
_examples/feature-showcase/.reference/
```

- [ ] **Step 2: Install and confirm tsx is no longer extraneous**

Run: `npm install`
Then: `npm ls tsx`
Expected: `` `-- tsx@4.23.1 `` with **no** "extraneous" suffix.

- [ ] **Step 3: Fetch the Go reference source and the nine copied assets**

```bash
cd _examples/feature-showcase
mkdir -p assets .reference
BASE=https://raw.githubusercontent.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go/main
curl -sSL -o .reference/main.go "$BASE/_examples/feature_showcase/main.go"
for f in starry-night.jpg newton.jpg einstein.jpg sales-banner.jpg \
         aspose-pinwheel.svg github-mark.svg; do
  curl -sSL -o "assets/$f" "$BASE/_examples/feature_showcase/assets/$f"
done
curl -sSL -o assets/aspose-logo.svg "$BASE/testdata/aspose-logo.svg"
curl -sSL -o assets/aspose-logo.png "$BASE/testdata/aspose-logo.png"
curl -sSL -o assets/DejaVuSans.ttf  "$BASE/testdata/DejaVuSans.ttf"
```

Expected: `.reference/main.go` is 2513 lines; every file in `assets/` is non-empty.

- [ ] **Step 4: Author the unbranded book icon**

The Go repo's tenth asset is `go-logo.svg`, which has no counterpart here and whose
substitute would be another vendor's trademark. Create `assets/book-icon.svg` — our
own file, no third-party rights:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M3 4.5C3 3.7 3.7 3 4.5 3H11v17.2l-.7-.5a6 6 0 0 0-3.4-1.1H4.5A1.5 1.5 0 0 1 3 17.1z"
        fill="#1a3ba0"/>
  <path d="M21 4.5c0-.8-.7-1.5-1.5-1.5H13v17.2l.7-.5a6 6 0 0 1 3.4-1.1h2.4a1.5 1.5 0 0 0 1.5-1.5z"
        fill="#3b5fd0"/>
  <path d="M11 3h2v17.2h-2z" fill="#0f2569"/>
</svg>
```

- [ ] **Step 5: Record provenance**

Create `_examples/feature-showcase/assets/PROVENANCE.md`. Generate the hashes with
`sha256sum assets/*` and paste the real values — do not invent them. Use this structure:

```markdown
# Feature showcase assets — provenance

Nine files are copied verbatim from the Go sibling repository,
<https://github.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go>, at `main`.
Fetched 2026-08-06.

| File | Source path in that repo | SHA-256 | License / rights |
|---|---|---|---|
| `starry-night.jpg` | `_examples/feature_showcase/assets/` | … | Vincent van Gogh, *The Starry Night* (1889) — public domain |
| `newton.jpg` | `_examples/feature_showcase/assets/` | … | public domain portrait |
| `einstein.jpg` | `_examples/feature_showcase/assets/` | … | public domain portrait |
| `sales-banner.jpg` | `_examples/feature_showcase/assets/` | … | public domain / synthetic banner |
| `aspose-pinwheel.svg` | `_examples/feature_showcase/assets/` | … | Aspose brand mark, used by its owner |
| `github-mark.svg` | `_examples/feature_showcase/assets/` | … | GitHub logo, used per GitHub's logo policy to link to a GitHub-hosted repository |
| `aspose-logo.svg` | `testdata/` | … | Aspose brand mark, used by its owner |
| `aspose-logo.png` | `testdata/` | … | Aspose brand mark, used by its owner |
| `DejaVuSans.ttf` | `testdata/` | … | DejaVu Fonts License (Bitstream Vera derivative), permissive |

`book-icon.svg` is **not** from that repo. It was authored for this example — an
unbranded document glyph standing in for the Go repo's `go-logo.svg`, which has no
TypeScript counterpart we may lawfully substitute. It carries no third-party rights.

`.reference/main.go` is the Go showcase source, fetched by Task 1 of the
implementation plan as a porting reference. It is gitignored and is not part of
this package.
```

- [ ] **Step 6: Write the asset loader**

Create `_examples/feature-showcase/assets.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to a file in this example's assets directory. */
export function assetPath(name: string): string {
  return join(here, 'assets', name);
}

const cache = new Map<string, Uint8Array>();

function load(name: string): Uint8Array {
  let bytes = cache.get(name);
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(assetPath(name)));
    cache.set(name, bytes);
  }
  return bytes;
}

export const starryNight = (): Uint8Array => load('starry-night.jpg');
export const newton = (): Uint8Array => load('newton.jpg');
export const einstein = (): Uint8Array => load('einstein.jpg');
export const salesBanner = (): Uint8Array => load('sales-banner.jpg');
export const asposePinwheel = (): Uint8Array => load('aspose-pinwheel.svg');
export const asposeLogo = (): Uint8Array => load('aspose-logo.svg');
export const githubMark = (): Uint8Array => load('github-mark.svg');
export const bookIcon = (): Uint8Array => load('book-icon.svg');
export const asposeLogoPng = (): Uint8Array => load('aspose-logo.png');
export const dejaVuSansPath = (): string => assetPath('DejaVuSans.ttf');
```

- [ ] **Step 7: Write a stub main that proves the toolchain works**

Create `_examples/feature-showcase/main.ts`:

```ts
import * as assets from './assets.js';

const sizes = {
  starryNight: assets.starryNight().length,
  newton: assets.newton().length,
  einstein: assets.einstein().length,
  salesBanner: assets.salesBanner().length,
  asposePinwheel: assets.asposePinwheel().length,
  asposeLogo: assets.asposeLogo().length,
  githubMark: assets.githubMark().length,
  bookIcon: assets.bookIcon().length,
  asposeLogoPng: assets.asposeLogoPng().length,
};
for (const [name, n] of Object.entries(sizes)) {
  if (n === 0) throw new Error(`asset ${name} is empty`);
  console.log(`${name}: ${n} bytes`);
}
console.log('dejaVuSans:', assets.dejaVuSansPath());
```

- [ ] **Step 8: Run it**

Run: `npm run example:showcase`
Expected: nine non-zero byte counts and the font path; exit 0.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore _examples/feature-showcase
git commit -m "chore(example): scaffold feature-showcase with assets and tsx runner"
```

---

### Task 2: theme.ts — shared vocabulary

**Files:**
- Create: `_examples/feature-showcase/theme.ts`
- Test: `test/showcase-theme.test.ts`

**Interfaces:**
- Consumes: `assets.ts` (nothing yet).
- Produces:
  - `type Box = [number, number, number, number]` — `llx, lly, urx, ury`.
  - `xywh(b: Box): [number, number, number, number]`
  - `rectToQuads(b: Box): number[]`
  - `centeredRect(outer: Box, w: number, h: number): Box`
  - `interface TextStyle { font?; size?; color?; opacity?; align?; valign?; lineSpacing?; underline?; strikethrough?; background?; rotate?; behind? }`
  - `addText(page: Page, text: string, box: Box, style?: TextStyle): void`
  - `sectionHeader(page: Page, title: string, subtitle?: string): void`
  - `addUnifiedFooter(page: Page, index: number, total: number): void`
  - `pageWidth(page: Page): number`, `pageHeight(page: Page): number`
  - the palette constants `NAVY`, `DEEP_NAVY`, `INK`, `MUTED`, `FAINT`, `WHITE`, `TINT`, `GREEN`, `BROWN`
  - `DOC_TITLE`, `PRODUCT_NAME`, `DOC_VERSION`, `DOC_AUTHOR`

- [ ] **Step 1: Write the failing test for the two pure geometry helpers**

`rectToQuads` corner order is the classic silent bug in this format — a wrong order
draws the markup somewhere plausible but wrong, and nothing throws. Pin it.
Create `test/showcase-theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { xywh, rectToQuads, centeredRect } from '../_examples/feature-showcase/theme.js';

describe('showcase theme geometry', () => {
  it('converts a Go-shaped box to x/y/w/h', () => {
    expect(xywh([50, 100, 250, 160])).toEqual([50, 100, 200, 60]);
  });

  it('emits QuadPoints in top-left, top-right, bottom-left, bottom-right order', () => {
    // PDF 32000-1 12.5.6.10 order, as the library's own README documents it.
    expect(rectToQuads([72, 528, 240, 540])).toEqual([
      72, 540, 240, 540,   // top-left, top-right
      72, 528, 240, 528,   // bottom-left, bottom-right
    ]);
  });

  it('centres a box of the given size inside an outer box', () => {
    expect(centeredRect([0, 0, 100, 100], 40, 20)).toEqual([30, 40, 70, 60]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/showcase-theme.test.ts`
Expected: FAIL — cannot resolve `../_examples/feature-showcase/theme.js`.

- [ ] **Step 3: Write theme.ts**

Create `_examples/feature-showcase/theme.ts`:

```ts
import type { Page } from '../../src/index.js';
import type { AuthoringFont } from '../../src/stamp.js';

export const PRODUCT_NAME = 'Aspose.PDF FOSS for TypeScript';
export const DOC_TITLE = `${PRODUCT_NAME} — Feature Showcase`;
export const DOC_AUTHOR = 'Aspose';
export const DOC_VERSION = 'v0.0.0';

/** A rectangle in the Go example's shape: lower-left and upper-right corners.
 *  Kept so the ported numeric literals read exactly as they do in main.go. */
export type Box = [number, number, number, number];

export const NAVY: [number, number, number] = [0.15, 0.20, 0.55];
export const DEEP_NAVY: [number, number, number] = [0.10, 0.15, 0.40];
export const INK: [number, number, number] = [0.15, 0.16, 0.20];
export const MUTED: [number, number, number] = [0.4, 0.4, 0.45];
export const FAINT: [number, number, number] = [0.5, 0.5, 0.55];
export const WHITE: [number, number, number] = [1, 1, 1];
export const TINT: [number, number, number] = [0.95, 0.96, 1.0];
export const GREEN: [number, number, number] = [0.10, 0.55, 0.25];
export const BROWN: [number, number, number] = [0.6, 0.3, 0.1];

/** The library's rect shape: origin plus extent. */
export function xywh(b: Box): [number, number, number, number] {
  return [b[0], b[1], b[2] - b[0], b[3] - b[1]];
}

/** /QuadPoints for one rectangle, in the spec's corner order:
 *  top-left, top-right, bottom-left, bottom-right. */
export function rectToQuads(b: Box): number[] {
  const [llx, lly, urx, ury] = b;
  return [llx, ury, urx, ury, llx, lly, urx, lly];
}

/** A box of `w` x `h` centred inside `outer`. */
export function centeredRect(outer: Box, w: number, h: number): Box {
  const cx = (outer[0] + outer[2]) / 2;
  const cy = (outer[1] + outer[3]) / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

export function pageWidth(page: Page): number {
  return page.Rect[2] - page.Rect[0];
}

export function pageHeight(page: Page): number {
  return page.Rect[3] - page.Rect[1];
}

/** The Go example's TextStyle, so ported call sites keep their shape.
 *  `lineSpacing` is a multiple of the font size (Go semantics); the library's
 *  `leading` is absolute points, and addText converts. */
export interface TextStyle {
  font?: AuthoringFont;
  size?: number;
  color?: [number, number, number];
  opacity?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'center' | 'bottom';
  lineSpacing?: number;
  underline?: boolean;
  strikethrough?: boolean;
  background?: [number, number, number];
  rotate?: number;
  behind?: boolean;
}

/** Flow `text` into `box`, the adapter for Go's rect-plus-style AddText.
 *  Overflow is dropped, exactly as Go's AddText clips at the box boundary. */
export function addText(page: Page, text: string, box: Box, style: TextStyle = {}): void {
  const size = style.size ?? 12;
  page.AddTextBlock(text, xywh(box), {
    font: style.font ?? 'Helvetica',
    fontSize: size,
    color: style.color,
    opacity: style.opacity,
    align: style.align,
    valign: style.valign,
    leading: style.lineSpacing === undefined ? undefined : style.lineSpacing * size,
    underline: style.underline,
    strikethrough: style.strikethrough,
    background: style.background,
    rotate: style.rotate,
    behind: style.behind,
  });
}

/** A section's title and italic subtitle, in the shared body-page style. */
export function sectionHeader(page: Page, title: string, subtitle = ''): void {
  const w = pageWidth(page);
  const h = pageHeight(page);
  addText(page, title, [50, h - 90, w - 50, h - 55], {
    font: 'Helvetica-Bold', size: 26, color: NAVY, align: 'center',
  });
  if (subtitle) {
    addText(page, subtitle, [50, h - 113, w - 50, h - 98], {
      font: 'Helvetica-Oblique', size: 11, color: MUTED, align: 'center',
    });
  }
}

/** A thin rule plus "<title>   ·   <index> / <total>" at the page foot. */
export function addUnifiedFooter(page: Page, index: number, total: number): void {
  const w = pageWidth(page);
  const g = page.Graphics();
  g.setStrokeColor([0.85, 0.85, 0.9]).setLineWidth(0.5)
    .drawLine(50, 40, w - 50, 40).stroke();
  g.apply();
  addText(page, `${DOC_TITLE}   ·   ${index} / ${total}`, [50, 22, w - 50, 36], {
    size: 8, color: [0.55, 0.55, 0.6], align: 'center',
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/showcase-theme.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Prove the QuadPoints assertion is load-bearing**

Temporarily swap the `rectToQuads` return to `[llx, lly, urx, lly, llx, ury, urx, ury]`
(bottom row first). Re-run the test. Expected: the QuadPoints case FAILS. Restore the
correct order and re-run to green. This is the repo's rule for a new assertion: break
the path it covers and confirm the suite goes red.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add _examples/feature-showcase/theme.ts test/showcase-theme.test.ts
git commit -m "feat(example): showcase theme vocabulary and geometry helpers"
```

---

### Task 3: main.ts — document scaffolding, labels, metadata, save

**Files:**
- Modify: `_examples/feature-showcase/main.ts` (replace the Task 1 stub)

**Interfaces:**
- Consumes: `theme.ts`, `assets.ts`.
- Produces:
  - `interface Section { dest: string; title: string; subtype: string; page: Page }`
  - the `DEST_*` name constants used by every later task:
    `DEST_TEXT='section.text'`, `DEST_IMAGE='section.image'`, `DEST_FORM='section.form'`,
    `DEST_ANNOT='section.annotations'`, `DEST_REDACT='section.redaction'`,
    `DEST_BILL='section.bill'`, `DEST_SALES='section.sales'`,
    `DEST_LANDSCAPE='section.landscape'`, `DEST_VECTOR='section.vector'`,
    `DEST_FLATTEN='section.flatten'`, `DEST_FLOW='section.flow'`,
    `DEST_RENDER='section.render'`

- [ ] **Step 1: Replace main.ts with the scaffolding**

The page allocation mirrors `.reference/main.go:96-157`: eight portrait A4 pages up
front (cover, TOC, then six body sections), then the sales report, landscape chart,
vector, flatten and flow pages appended so they land after any sales-report
continuation pages, then the render page last.

```ts
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Document, PageFormat } from '../../src/index.js';
import type { Page } from '../../src/index.js';
import { DOC_AUTHOR, DOC_TITLE, DOC_VERSION, PRODUCT_NAME, addUnifiedFooter } from './theme.js';

const OUTPUT_PATH = 'docs/feature-showcase.pdf';

export const DEST_TEXT = 'section.text';
export const DEST_IMAGE = 'section.image';
export const DEST_FORM = 'section.form';
export const DEST_ANNOT = 'section.annotations';
export const DEST_REDACT = 'section.redaction';
export const DEST_BILL = 'section.bill';
export const DEST_SALES = 'section.sales';
export const DEST_LANDSCAPE = 'section.landscape';
export const DEST_VECTOR = 'section.vector';
export const DEST_FLATTEN = 'section.flatten';
export const DEST_FLOW = 'section.flow';
export const DEST_RENDER = 'section.render';

/** One TOC/outline entry. */
export interface Section {
  dest: string;
  title: string;
  subtype: string;
  page: Page;
}

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

// --- Document scaffolding -------------------------------------------------
const doc = Document.New(PageFormat.A4);
for (let i = 0; i < 7; i++) doc.AddPage(PageFormat.A4);

const coverPage = doc.Pages[0];
const tocPage = doc.Pages[1];
const textPage = doc.Pages[2];
const imagePage = doc.Pages[3];
const formPage = doc.Pages[4];
const annotPage = doc.Pages[5];
const redactPage = doc.Pages[6];
const billPage = doc.Pages[7];

// --- Body content ---------------------------------------------------------
// (section modules are wired in by later tasks)

// Sales report — a fresh page the table then grows from.
const salesPage = doc.AddPage(PageFormat.A4).page;

// Landscape wide chart — a physically wider page.
const landscapePage = doc.AddPage(PageFormat.A4.landscape()).page;

const vectorPage = doc.AddPage(PageFormat.A4).page;
const flattenPage = doc.AddPage(PageFormat.A4).page;

// The flow appends its own page(s) — added in a later task, which also adds its
// section entry below.

// A meta page whose thumbnails are renders of this very document.
const renderPage = doc.AddPage(PageFormat.A4).page;

const sections: Section[] = [
  { dest: DEST_TEXT, title: 'Text Capabilities Showcase', subtype: 'text', page: textPage },
  { dest: DEST_IMAGE, title: 'Image Embedding', subtype: 'image', page: imagePage },
  { dest: DEST_FORM, title: 'AcroForm Fields', subtype: 'form', page: formPage },
  { dest: DEST_ANNOT, title: 'Annotation Gallery', subtype: 'annotations', page: annotPage },
  { dest: DEST_REDACT, title: 'Redactions', subtype: 'redaction', page: redactPage },
  { dest: DEST_BILL, title: 'Restaurant Bill', subtype: 'bill', page: billPage },
  { dest: DEST_SALES, title: 'Multi-Page Sales Report', subtype: 'sales', page: salesPage },
  { dest: DEST_LANDSCAPE, title: 'Annual Sales — 12 Month Trend', subtype: 'landscape', page: landscapePage },
  { dest: DEST_VECTOR, title: 'Vector Graphics', subtype: 'vector', page: vectorPage },
  { dest: DEST_FLATTEN, title: 'Form & Annotation Flattening', subtype: 'flatten', page: flattenPage },
  // The DEST_FLOW entry is spliced in here by the flow task, once that page exists.
  { dest: DEST_RENDER, title: 'Rendering & Imposition', subtype: 'image', page: renderPage },
];

// --- Named destinations ---------------------------------------------------
for (const s of sections) doc.SetNamedDestination(s.dest, { page: s.page.Number });

// --- Page labels ----------------------------------------------------------
// Cover + TOC are lowercase roman; the body restarts at decimal 1. This MUST
// run before the TOC is drawn: AddTOC defaults each row's label to the target
// page's /PageLabels label.
doc.SetPageLabels([
  { startIndex: 0, style: 'roman' },
  { startIndex: 2, style: 'decimal', start: 1 },
]);

// --- Per-page furniture ---------------------------------------------------
doc.Pages.forEach((p, i) => addUnifiedFooter(p, i + 1, doc.Pages.length));

// --- Document info + XMP --------------------------------------------------
const now = new Date();
doc.SetMetadata({
  title: DOC_TITLE,
  author: DOC_AUTHOR,
  subject: `End-to-end showcase of ${PRODUCT_NAME} capabilities`,
  keywords: 'aspose,pdf,typescript,acroform,annotations,svg,redaction,tables,flow',
  creator: `${PRODUCT_NAME} ${DOC_VERSION}`,
  producer: `${PRODUCT_NAME} ${DOC_VERSION}`,
  creationDate: now,
  modDate: now,
  custom: { AsposeProduct: PRODUCT_NAME },
});
// SetMetadata already mirrors the shared fields into XMP, so no explicit sync
// step is needed; this adds an XMP-only namespaced property on top.
doc.SetXmp({
  custom: [{
    namespace: 'http://ns.aspose.com/pdf/foss/1.0/',
    prefix: 'aspose',
    name: 'Showcase',
    value: 'feature-showcase',
  }],
});

doc.WriteTo(OUTPUT_PATH);
console.log(`wrote ${OUTPUT_PATH} (${doc.Pages.length} pages)`);
```

- [ ] **Step 2: Run it**

Run: `npm run example:showcase`
Expected: `wrote docs/feature-showcase.pdf (13 pages)`.

- [ ] **Step 3: Confirm the labels and metadata landed**

```bash
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
console.log('pages', d.Pages.length);
console.log('labels', [0,1,2,3].map(i => d.PageLabelFor(i)).join(','));
console.log('title', d.GetMetadata().title);
console.log('xmp custom', JSON.stringify(d.GetXmp().custom));
console.log('dests', d.GetNamedDestinations().map(x => x.name).join(','));
"
```

Expected: `pages 13`; `labels i,ii,1,2`; the title; one XMP custom property named
`Showcase`; **eleven** destination names — the twelfth, `section.flow`, arrives
with the flow task.

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase scaffolding, page labels, metadata and XMP"
```

---

### Task 4: cover.ts

**Files:**
- Create: `_examples/feature-showcase/cover.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts` (`Box`, `addText`, `pageWidth`, `pageHeight`, `PRODUCT_NAME`), `assets.ts`.
- Produces: `addCoverPage(page: Page): void`

Port `.reference/main.go:1945-2061`. The pinwheel, title, subtitle and one-liner
carry over unchanged; the CTA row's right-hand group swaps the Go logo for
`book-icon.svg` and both links retarget this repository.

- [ ] **Step 1: Write cover.ts**

```ts
import type { Page } from '../../src/index.js';
import { addText, pageHeight, pageWidth, xywh, PRODUCT_NAME, MUTED, FAINT } from './theme.js';
import { asposePinwheel, bookIcon, githubMark } from './assets.js';

const SOURCE_URL = 'https://github.com/aspose-pdf-foss/aspose-pdf-foss-for-ts';
const API_URL = 'https://github.com/aspose-pdf-foss/aspose-pdf-foss-for-ts#api-overview';

export function addCoverPage(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  // Big pinwheel — square, centred, upper-middle of the page.
  const logoSize = 220;
  const logoX = (w - logoSize) / 2;
  const logoY = h - 100 - logoSize;
  page.AddSVGObject(asposePinwheel(), xywh([logoX, logoY, logoX + logoSize, logoY + logoSize]));

  const titleY = logoY - 80;
  addText(page, PRODUCT_NAME, [30, titleY, w - 30, titleY + 40], {
    font: 'Helvetica-Bold', size: 30, color: [0.1, 0.15, 0.4], align: 'center',
  });
  addText(page, 'Feature Showcase', [50, titleY - 38, w - 50, titleY - 8], {
    font: 'Helvetica-Oblique', size: 18, color: MUTED, align: 'center',
  });
  addText(page, 'An end-to-end tour of every library capability in one document.',
    [50, titleY - 70, w - 50, titleY - 48], { size: 12, color: FAINT, align: 'center' });

  // CTA row: [github mark] Source code  •  [book icon] API reference, laid out
  // symmetrically about the page centre.
  const iconH = 12;
  const githubAR = 1.0;      // viewBox 16x16
  const bookAR = 1.0;        // viewBox 24x24
  const textGap = 5;
  const bulletGap = 12;
  const linkY = 110;
  const srcW = 74;           // "Source code" at Helvetica-Bold 12pt
  const apiW = 88;           // "API reference"
  const bulletHW = 5;
  const centre = w / 2;

  const linkStyle = {
    font: 'Helvetica-Bold' as const, size: 12,
    color: [0.1, 0.3, 0.7] as [number, number, number], underline: true,
  };

  // Left group.
  const ghW = iconH * githubAR;
  const srcEnd = centre - bulletHW - bulletGap;
  const srcStart = srcEnd - srcW;
  const ghEnd = srcStart - textGap;
  const ghStart = ghEnd - ghW;
  page.AddSVGObject(githubMark(), xywh([ghStart, linkY, ghEnd, linkY + iconH]));
  addText(page, 'Source code', [srcStart, linkY - 1, srcEnd, linkY + iconH], linkStyle);
  page.AddLink({
    rect: [ghStart - 2, linkY - 3, srcEnd + 2, linkY + iconH + 3],
    action: { type: 'uri', uri: SOURCE_URL },
  });

  // Centre bullet.
  addText(page, '•', [centre - bulletHW, linkY - 2, centre + bulletHW, linkY + iconH + 2], {
    font: 'Helvetica-Bold', size: 14, color: [0.3, 0.3, 0.35], align: 'center',
  });

  // Right group.
  const bookW = iconH * bookAR;
  const bookStart = centre + bulletHW + bulletGap;
  const bookEnd = bookStart + bookW;
  const apiStart = bookEnd + textGap;
  const apiEnd = apiStart + apiW;
  page.AddSVGObject(bookIcon(), xywh([bookStart, linkY, bookEnd, linkY + iconH]));
  addText(page, 'API reference', [apiStart, linkY - 1, apiEnd, linkY + iconH], linkStyle);
  page.AddLink({
    rect: [bookStart - 2, linkY - 3, apiEnd + 2, linkY + iconH + 3],
    action: { type: 'uri', uri: API_URL },
  });
}
```

- [ ] **Step 2: Wire it into main.ts**

Add the import beside the other section imports:

```ts
import { addCoverPage } from './cover.js';
```

and, under the `// --- Body content ---` comment, replace the placeholder comment with:

```ts
addCoverPage(coverPage);
```

- [ ] **Step 3: Run and eyeball**

Run: `npm run example:showcase`
Then open `docs/feature-showcase.pdf` page 1. Expected: the pinwheel centred in the
upper half, the product name and subtitle beneath it, and one CTA row near the
bottom whose bullet sits on the page's vertical centre line.

- [ ] **Step 4: Confirm both links carry URI actions**

```bash
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
for (const a of d.Pages[0].Annotations) console.log(a.Subtype, JSON.stringify(a.Dict.get('A')));
"
```

Expected: two `Link` lines, each with a `URI` action.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/cover.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase cover page"
```

---

### Task 5: text.ts — text capabilities

**Files:**
- Create: `_examples/feature-showcase/text.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`, `assets.ts` (`dejaVuSansPath`).
- Produces: `addPageText(doc: Document, page: Page): void`

Port `.reference/main.go:420-612`, all five subsections, in order: the twelve
Standard-14 faces with a sample line each; the embedded DejaVu Sans block (five
Unicode lines, then two RTL lines); decorations; the six-colour palette row; and the
word-wrap paragraph. Copy the sample strings, font labels, colour values and the
paragraph text verbatim from those lines.

- [ ] **Step 1: Write text.ts**

```ts
import type { Document, Page } from '../../src/index.js';
import { addText, pageWidth, pageHeight, sectionHeader, NAVY, FAINT, MUTED } from './theme.js';
import type { TextStyle } from './theme.js';
import { dejaVuSansPath } from './assets.js';

export function addPageText(doc: Document, page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Text Capabilities Showcase',
    'Standard 14 fonts  •  embedded TTF & Unicode  •  decorations  •  colors  •  word-wrap');

  addText(page,
    'Also available  ·  GetText / GetStructuredText (font, colour, position)  ·  Search / ReplaceText  ·  AddWatermark on selected pages  ·  destructive removal via Redact / ApplyRedactions',
    [50, h - 145, w - 50, h - 120],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  const sectionStyle: TextStyle = { font: 'Helvetica-Bold', size: 13, color: NAVY };
  const section = (label: string, top: number): void => {
    addText(page, label, [50, top - 16, w - 50, top], sectionStyle);
  };

  // ===== 1: Standard 14 PDF Fonts =====
  section('Standard 14 PDF Fonts', h - 170);
  const sample = 'The quick brown fox jumps over 42 lazy dogs.';
  const labelStyle: TextStyle = { font: 'Courier', size: 8, color: [0.5, 0.5, 0.5] };
  const fonts: Array<[TextStyle['font'], string]> = [
    ['Helvetica', 'Helvetica'],
    ['Helvetica-Bold', 'Helvetica-Bold'],
    ['Helvetica-Oblique', 'Helvetica-Oblique'],
    ['Helvetica-BoldOblique', 'Helvetica-BoldOblique'],
    ['Times-Roman', 'Times-Roman'],
    ['Times-Bold', 'Times-Bold'],
    ['Times-Italic', 'Times-Italic'],
    ['Times-BoldItalic', 'Times-BoldItalic'],
    ['Courier', 'Courier'],
    ['Courier-Bold', 'Courier-Bold'],
    ['Courier-Oblique', 'Courier-Oblique'],
    ['Courier-BoldOblique', 'Courier-BoldOblique'],
  ];
  let y = h - 200;
  for (const [font, label] of fonts) {
    addText(page, label, [50, y - 11, 185, y + 1], labelStyle);
    addText(page, sample, [190, y - 12, w - 50, y + 2], { font, size: 11 });
    y -= 12;
  }

  // ===== 2: Embedded TTF — Unicode & RTL =====
  y -= 14;
  section('Embedded TTF (DejaVu Sans) — Unicode & RTL', y);
  y -= 22;

  const deja = doc.AddFontFile(dejaVuSansPath(), { shape: true });
  for (const line of [
    'Русский: Здравствуй, мир!',
    'Ελληνικά: Γειά σου, κόσμε!',
    'Deutsch: Schöne Grüße aus München',
    'Français: Bonjour à tous, ça va?',
    'Symbols: → ← ★ ♥ ☎ € § ¶ ¥ £ © ®',
  ]) {
    addText(page, line, [60, y - 14, w - 50, y + 1], { font: deja, size: 11 });
    y -= 15;
  }

  addText(page, 'Right-to-left — automatic BiDi + Arabic shaping, right-aligned:',
    [60, y - 12, w - 50, y + 1], { font: 'Helvetica-Oblique', size: 9, color: MUTED });
  y -= 15;
  for (const line of ['עברית — שלום עולם! (3 ספרים)', 'العربية — مرحبا بالعالم ٢٠٢٤']) {
    // dir: 'rtl' plus the font's shaping default drives the bidi engine; align
    // right so the paragraph sits on the edge a reader of these scripts expects.
    page.AddTextBlock(line, [60, y - 15, w - 110, 16],
      { font: deja, fontSize: 12, dir: 'rtl', align: 'right' });
    y -= 16;
  }

  // ===== 3: Decorations =====
  y -= 12;
  section('Decorations', y);
  y -= 22;
  addText(page, 'This text is underlined.', [60, y - 14, 295, y + 1],
    { size: 11, underline: true });
  addText(page, 'This text is struck through.', [310, y - 14, 545, y + 1],
    { size: 11, strikethrough: true });
  y -= 18;
  addText(page, 'Yellow highlight background.', [60, y - 14, 295, y + 2],
    { size: 11, background: [1, 0.95, 0.4] });
  addText(page, '35% opacity text (faded).', [310, y - 14, 545, y + 1],
    { size: 11, opacity: 0.35 });
  y -= 22;

  // ===== 4: Color palette =====
  section('Color palette', y);
  y -= 22;
  const colors: Array<[[number, number, number], string]> = [
    [[0.85, 0.10, 0.10], 'crimson'],
    [[0.10, 0.60, 0.20], 'forest'],
    [[0.10, 0.20, 0.80], 'azure'],
    [[0.60, 0.30, 0.70], 'violet'],
    [[0.95, 0.55, 0.05], 'amber'],
    [[0.05, 0.55, 0.55], 'teal'],
  ];
  const colW = (w - 100) / colors.length;
  colors.forEach(([color, label], i) => {
    addText(page, label, [50 + i * colW, y - 16, 50 + (i + 1) * colW, y + 2],
      { font: 'Helvetica-Bold', size: 13, color, align: 'center' });
  });
  y -= 28;

  // ===== 5: Word wrap & line spacing =====
  section('Word wrap & line spacing', y);
  y -= 22;
  addText(page,
    'This paragraph demonstrates automatic word wrapping at the right edge of the bounding '
    + 'rectangle. Words break on whitespace; line spacing is 1.4× the font size. AddTextBlock '
    + 'handles alignment, clipping at the rectangle boundary, and font-aware glyph-width '
    + 'measurement, so all these features carry through into table cells and free-text annotations.',
    [60, 80, w - 50, y + 2],
    { font: 'Times-Roman', size: 11, lineSpacing: 1.4 });
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addPageText } from './text.js';
```

and after `addCoverPage(coverPage);`:

```ts
addPageText(doc, textPage);
```

- [ ] **Step 3: Run and check the Unicode round-trips**

Run: `npm run example:showcase`

```bash
npx tsx -e "
import { Document } from './src/index.js';
const t = Document.OpenFile('docs/feature-showcase.pdf').Pages[2].GetText();
for (const s of ['Здравствуй', 'Γειά', 'Grüße', 'שלום', 'مرحبا'])
  console.log(s, t.includes(s) ? 'OK' : 'MISSING');
"
```

Expected: five `OK` lines. A `MISSING` on the RTL rows means the shaped text's
`/ToUnicode` map is not round-tripping — investigate before moving on, since the
whole point of that block is that it does.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/text.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase text capabilities page"
```

---

### Task 6: image.ts

**Files:**
- Create: `_examples/feature-showcase/image.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`, `assets.ts` (`starryNight`).
- Produces: `addPageImage(page: Page): void`

Port `.reference/main.go:618-662`.

- [ ] **Step 1: Write image.ts**

```ts
import type { Page } from '../../src/index.js';
import { addText, pageWidth, pageHeight, sectionHeader, xywh, FAINT, MUTED } from './theme.js';
import { starryNight } from './assets.js';

export function addPageImage(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Image Embedding',
    'JPEG / PNG raster images placed with pixel-precise Page.AddImage rectangles');

  addText(page,
    'Also available  ·  page.Images metadata-only inspection  ·  image.Decode() to samples  ·  Redact partial-image re-encode  ·  Optimize({ images }) downsample + JPEG re-encode',
    [40, h - 150, w - 40, h - 120],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  // Van Gogh's "The Starry Night" (1889) — public domain. Source is 1280x1014;
  // scaled to 60% of the page width, aspect preserved.
  const srcW = 1280;
  const srcH = 1014;
  const imgW = w * 0.6;
  const imgH = (imgW * srcH) / srcW;
  const x = (w - imgW) / 2;
  const y = (h - imgH) / 2;
  page.AddImage(starryNight(), xywh([x, y, x + imgW, y + imgH]));

  addText(page, 'Vincent van Gogh, The Starry Night (1889) — public domain',
    [50, y - 22, w - 50, y - 6],
    { font: 'Helvetica-Oblique', size: 10, color: MUTED, align: 'center' });
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addPageImage } from './image.js';
```
```ts
addPageImage(imagePage);
```

- [ ] **Step 3: Run and confirm the image embedded**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const imgs = Document.OpenFile('docs/feature-showcase.pdf').Pages[3].Images;
console.log(imgs.map(i => \`\${i.Width}x\${i.Height} \${i.Filter}\`).join(' | '));
"
```

Expected: one entry, `1280x1014 DCTDecode`.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/image.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase image embedding page"
```

---

### Task 7: forms.ts — AcroForm field types

**Files:**
- Create: `_examples/feature-showcase/forms.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`, `assets.ts` (`asposeLogoPng`).
- Produces: `addFormFields(doc: Document, page: Page): void`

Port `.reference/main.go:668-815`. The Go code creates each field, then calls
`SetValue`, then `SetStyle`; here every one of those is a key on the single `Add*`
options object, so the three calls collapse to one per field.

- [ ] **Step 1: Write forms.ts**

```ts
import type { Document, Page } from '../../src/index.js';
import {
  addText, pageWidth, pageHeight, sectionHeader, NAVY, TINT, GREEN, FAINT,
} from './theme.js';
import { asposeLogoPng } from './assets.js';

export function addFormFields(doc: Document, page: Page): void {
  const form = doc.Form;
  const pageNum = page.Number;
  const w = pageWidth(page);
  const h = pageHeight(page);
  const labelW = 130;

  const addLabel = (text: string, y: number): void => {
    addText(page, text, [50, y, 50 + labelW, y + 18], { font: 'Helvetica-Bold', size: 11 });
  };

  sectionHeader(page, 'AcroForm Fields',
    'Text  •  checkbox  •  radio group  •  combo box  •  list box  •  push button');

  addText(page,
    'Fields below are styled at creation (border, background, text colour, font, alignment)  ·  Also available  ·  read / write any value  ·  Required & ReadOnly flags  ·  MaxLen, Multiline, Password, Comb (text)  ·  MultiSelect (list)  ·  AddOption / RemoveOption  ·  RemoveField',
    [30, h - 145, w - 30, h - 115],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  // Row 1: text field — navy border, faint tint fill, navy text.
  addLabel('Full name:', 670);
  form.AddTextField({
    page: pageNum, rect: [200, 670, 450, 690], name: 'FullName', value: 'Alice Sample',
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY,
    borderWidth: 1, font: 'Helvetica', fontSize: 12,
  });

  // Row 2: checkbox — navy box, green check.
  addLabel('Subscribe:', 630);
  form.AddCheckbox({
    page: pageNum, rect: [200, 630, 218, 648], name: 'Subscribe',
    checked: true, borderColor: NAVY, borderWidth: 1, textColor: GREEN,
  });

  // Row 3: radio group, three options laid out horizontally.
  addLabel('Plan:', 590);
  form.AddRadioGroup({
    name: 'Plan',
    selected: 'Pro',
    borderColor: NAVY, borderWidth: 1, textColor: NAVY,
    options: [
      { page: pageNum, rect: [200, 590, 218, 608], export: 'Basic' },
      { page: pageNum, rect: [290, 590, 308, 608], export: 'Pro' },
      { page: pageNum, rect: [380, 590, 398, 608], export: 'Enterprise' },
    ],
  });
  addText(page, 'Basic', [222, 592, 280, 608], { size: 10 });
  addText(page, 'Pro', [312, 592, 370, 608], { size: 10 });
  addText(page, 'Enterprise', [402, 592, 480, 608], { size: 10 });

  // Row 4: combo box. /V holds the export, the appearance draws the display text.
  addLabel('Country:', 550);
  form.AddComboBox({
    page: pageNum, rect: [200, 550, 350, 570], name: 'Country', value: 'US',
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY, borderWidth: 1,
    options: [
      { export: 'US', display: 'United States' },
      { export: 'UK', display: 'United Kingdom' },
      { export: 'DE', display: 'Germany' },
      { export: 'JP', display: 'Japan' },
    ],
  });

  // Row 5: multi-select list box.
  addLabel('Interests:', 490);
  form.AddListBox({
    page: pageNum, rect: [200, 410, 350, 510], name: 'Interests',
    multiSelect: true, value: ['pdf'],
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY, borderWidth: 1,
    options: [
      { export: 'pdf', display: 'PDF Engineering' },
      { export: 'crypto', display: 'Cryptography' },
      { export: 'type', display: 'Typography' },
      { export: 'color', display: 'Color Science' },
    ],
  });

  // Row 6: branded push button. /N, /R and /D are all generated, so the button
  // reacts to hover and press in any viewer.
  addLabel('Submit:', 360);
  form.AddPushButton({
    page: pageNum, rect: [200, 320, 320, 388], name: 'Submit',
    caption: 'Submit',
    rolloverCaption: 'Click to submit',
    downCaption: 'Submitting…',
    icon: asposeLogoPng(),
    iconPosition: 'icon-above-caption',
    textColor: [1, 1, 1],
    backgroundColor: NAVY,
    borderColor: [0.08, 0.12, 0.4],
    borderWidth: 1,
    action: { type: 'submit', url: 'https://httpbin.org/post', format: 'fdf' },
  });
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addFormFields } from './forms.js';
```
```ts
addFormFields(doc, formPage);
```

- [ ] **Step 3: Run and confirm every field type is present with its value**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
for (const f of d.Form.Fields) console.log(f.FullName, f.Type, JSON.stringify(f.Value));
"
```

Expected six lines: `FullName text "Alice Sample"`, `Subscribe checkbox true`,
`Plan radio "Pro"`, `Country choice "US"`, `Interests choice ["pdf"]`,
`Submit button` (a push button has no value).

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/forms.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase AcroForm field types page"
```

---

### Task 8: annotations.ts — the annotation gallery

**Files:**
- Create: `_examples/feature-showcase/annotations.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts` (`Box`, `addText`, `centeredRect`, `rectToQuads`, `sectionHeader`).
- Produces: `addAnnotations(page: Page): void`

Port `.reference/main.go:1014-1354` — sixteen cards in a two-column grid, filled
column by column (cells 0–7 left, 8–15 right).

**Two deliberate divergences from the Go source, both from the design doc:**

1. The Go `renderMarkup` helper draws each markup decoration *manually* into the
   content stream, because its `/AP` was left for the viewer to regenerate. This
   library generates `/AP` for `Highlight`, `Underline`, `StrikeOut` and `Squiggly`,
   so the `decorate` callback and every `page.Draw*` call inside it are **dropped**.
   `AddHighlight` defaults to `/CA 0.4`, so the sample text stays readable under the
   fill with no draw-order handling.
2. Markup annotations take `/QuadPoints`, not a rect — use `rectToQuads`.

- [ ] **Step 1: Write annotations.ts**

```ts
import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import {
  addText, centeredRect, pageWidth, pageHeight, rectToQuads, sectionHeader, NAVY, FAINT,
} from './theme.js';

interface Cell {
  name: string;
  caption: string;
  render: (body: Box) => void;
}

export function addAnnotations(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Annotation Gallery',
    '16 of 18 supported types  ·  Redact has its own page; Widget is shown via AcroForm');

  addText(page,
    'Also available  ·  read existing annotations via page.Annotations  ·  typed handles per /Subtype with live setters  ·  RemoveAnnotation  ·  /AP generated on create  ·  round-trip safe under AES encryption',
    [30, h - 148, w - 30, h - 115],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  const cardW = 235;
  const cardH = 75;
  const labelH = 14;
  const topY = 685;
  const gapX = 25;
  const leftX = 50;
  const rightX = leftX + cardW + gapX;

  // A markup sample: one line of text with the annotation over it. No manual
  // decoration — this library generates the /AP for all four markup subtypes.
  const markup = (
    body: Box, sample: string,
    add: (quads: number[]) => void,
  ): void => {
    const yMid = (body[1] + body[3]) / 2 - 6;
    const textRect: Box = [body[0] + 4, yMid, body[2] - 4, yMid + 16];
    addText(page, sample, textRect, { font: 'Times-Roman', size: 12 });
    add(rectToQuads(textRect));
  };

  const cells: Cell[] = [
    { name: 'Highlight', caption: 'translucent yellow over text', render: (body) =>
      markup(body, 'Highlight this phrase', (quads) =>
        page.AddHighlight({ quads, color: [1, 1, 0], contents: 'Yellow highlight' })) },

    { name: 'Underline', caption: 'single line under the text', render: (body) =>
      markup(body, 'Underline this phrase', (quads) =>
        page.AddUnderline({ quads, color: [0, 0, 1] })) },

    { name: 'Squiggly', caption: 'wavy underline for proofreaders', render: (body) =>
      markup(body, 'Squiggle this phrase', (quads) =>
        page.AddSquiggly({ quads, color: [1, 0.5, 0] })) },

    { name: 'StrikeOut', caption: 'line through the text', render: (body) =>
      markup(body, 'Strike this phrase out', (quads) =>
        page.AddStrikeOut({ quads, color: [1, 0, 0] })) },

    { name: 'Link', caption: 'clickable URL with a URI action', render: (body) => {
      const yMid = (body[1] + body[3]) / 2 - 6;
      const rect: Box = [body[0] + 4, yMid, body[2] - 4, yMid + 16];
      addText(page, 'Open example.com', rect,
        { font: 'Helvetica-Bold', size: 11, color: [0.1, 0.3, 0.7], underline: true });
      page.AddLink({ rect, action: { type: 'uri', uri: 'https://example.com' }, border: 0 });
    } },

    { name: 'Text — sticky note', caption: 'click the icon to read the comment', render: (body) => {
      const x = body[0] + 12;
      const y = body[1] + (body[3] - body[1]) / 2 - 4;
      page.AddTextNote({
        rect: [x, y, x + 20, y + 20], icon: 'Note', author: 'Reviewer',
        contents: 'This is a sticky-note annotation.',
      });
    } },

    { name: 'FreeText', caption: 'text drawn directly on the page', render: (body) =>
      page.AddFreeText({
        rect: [body[0] + 30, body[1] + 4, body[2] - 30, body[3] - 4],
        contents: 'FreeText sample', fontSize: 10, align: 'center',
        fill: [1, 1, 0.8], width: 1,
      }) },

    { name: 'Square', caption: 'filled rectangle with border', render: (body) =>
      page.AddSquare({
        rect: centeredRect(body, 80, 35), color: [0.8, 0, 0],
        fill: [1, 1, 0.5], width: 2,
      }) },

    { name: 'Circle', caption: 'stroked ellipse, no fill', render: (body) =>
      page.AddCircle({ rect: centeredRect(body, 80, 35), color: [0, 0.5, 0], width: 2 }) },

    { name: 'Line', caption: 'line with start/end arrow endings', render: (body) => {
      const midY = (body[1] + body[3]) / 2;
      page.AddLine({
        line: [body[0] + 25, midY, body[2] - 25, midY],
        color: [0, 0, 0.7], width: 2,
        startEnding: 'OpenArrow', endEnding: 'ClosedArrow',
      });
    } },

    { name: 'Ink', caption: 'free-hand pen strokes', render: (body) => {
      const midY = (body[1] + body[3]) / 2;
      const step = (body[2] - body[0] - 30) / 6;
      const x0 = body[0] + 15;
      const dy = [-8, 6, -4, 10, -2, 8, -6];
      const stroke: number[] = [];
      dy.forEach((d, i) => stroke.push(x0 + i * step, midY + d));
      page.AddInk({ paths: [stroke], color: [0.6, 0, 0.6], width: 2 });
    } },

    { name: 'Polygon', caption: 'closed shape with fill + border', render: (body) => {
      const cx = (body[0] + body[2]) / 2;
      const cy = (body[1] + body[3]) / 2;
      const verts: number[] = [];
      for (let k = 0; k < 5; k++) {
        const ang = Math.PI / 2 + (k * 2 * Math.PI) / 5;
        verts.push(cx + 20 * Math.cos(ang), cy + 16 * Math.sin(ang));
      }
      page.AddPolygon({ vertices: verts, color: [0.8, 0, 0], fill: [0.6, 0.8, 1], width: 1.5 });
    } },

    { name: 'Polyline', caption: 'open vertex path with arrow ending', render: (body) => {
      const midY = (body[1] + body[3]) / 2;
      const x0 = body[0] + 20;
      const width = body[2] - body[0] - 40;
      page.AddPolyline({
        vertices: [
          x0, midY - 8,
          x0 + width * 0.35, midY + 10,
          x0 + width * 0.65, midY - 10,
          x0 + width, midY + 8,
        ],
        color: [0, 0.5, 0.2], width: 2, endEnding: 'ClosedArrow',
      });
    } },

    { name: 'Stamp', caption: 'predefined or custom-image stamp', render: (body) =>
      page.AddStamp({ rect: centeredRect(body, 110, 35), name: 'Approved' }) },

    { name: 'FileAttachment', caption: 'embedded file behind a paperclip icon', render: (body) => {
      const x = body[0] + 12;
      const y = body[1] + (body[3] - body[1]) / 2 - 4;
      page.AddFileAttachment({
        rect: [x, y, x + 20, y + 20],
        name: 'q3-report.txt',
        bytes: new TextEncoder().encode('Confidential report contents (demonstration only).'),
        icon: 'Paperclip',
        contents: 'Quarterly report — see attachment',
        description: 'Q3 financial summary',
        addToCatalog: true,
      });
    } },

    { name: 'Caret', caption: 'text-insertion marker (chevron)', render: (body) => {
      const cx = (body[0] + body[2]) / 2;
      const cy = (body[1] + body[3]) / 2;
      page.AddCaret({
        rect: [cx - 11, cy - 12, cx + 11, cy + 12],
        symbol: 'paragraph', color: [0.85, 0.1, 0.1],
      });
    } },
  ];

  // Two columns, filled column by column: cells 0-7 left, 8-15 right.
  const rowsPerCol = 8;
  const g = page.Graphics();
  cells.forEach((c, i) => {
    const colIdx = Math.floor(i / rowsPerCol);
    const rowIdx = i % rowsPerCol;
    const cardX = colIdx === 1 ? rightX : leftX;
    const cardTop = topY - rowIdx * cardH;
    const cardBot = cardTop - cardH;

    if (rowIdx > 0) {
      g.setStrokeColor([0.9, 0.9, 0.93]).setLineWidth(0.5)
        .drawLine(cardX + 4, cardTop - 1, cardX + cardW - 4, cardTop - 1).stroke();
    }

    addText(page, c.name, [cardX, cardTop - labelH, cardX + cardW, cardTop - 2],
      { font: 'Helvetica-Bold', size: 11, color: NAVY });
    addText(page, c.caption,
      [cardX, cardTop - labelH - 11, cardX + cardW, cardTop - labelH - 1],
      { font: 'Helvetica-Oblique', size: 8, color: [0.55, 0.55, 0.6] });

    c.render([cardX + 4, cardBot + 4, cardX + cardW - 4, cardTop - labelH - 14]);
  });
  g.apply();
}
```

- [ ] **Step 2: Check the FileAttachment option name before running**

`AddFileAttachment` extends `AttachmentOptions`. Read
`src/embeddedfile.ts`'s `AttachmentOptions` and confirm the description key is
spelled `description`. If it is not, fix that one key in the call above to match.

- [ ] **Step 3: Wire it into main.ts**

```ts
import { addAnnotations } from './annotations.js';
```
```ts
addAnnotations(annotPage);
```

- [ ] **Step 4: Run and confirm all sixteen annotations landed with appearances**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const as = Document.OpenFile('docs/feature-showcase.pdf').Pages[5].Annotations;
console.log('count', as.length);
const noAp = as.filter(a => !a.Dict.get('AP')).map(a => a.Subtype);
console.log('subtypes', as.map(a => a.Subtype).join(','));
console.log('without /AP', noAp.join(',') || '(none)');
"
```

Expected: `count 16`; all sixteen subtypes listed. `Text`, `Link` and
`FileAttachment` render natively and may legitimately appear in the "without /AP"
list — the four markup subtypes must **not**, since dropping their manual
decoration relies on the generated appearance.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/annotations.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase annotation gallery page"
```

---

### Task 9: redaction.ts — mark-mode vs applied

**Files:**
- Create: `_examples/feature-showcase/redaction.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`.
- Produces:
  - `addRedactionDemo(page: Page): void`
  - `export const REDACTED_VALUES: string[]` — the two values destroyed by the apply pass
  - `export const MARKED_VALUES: string[]` — the two values left readable under marks

  Task 19's `verify.ts` consumes both arrays.

Port `.reference/main.go:2146-2281`. **The ordering inside this function is
load-bearing:** add the marks for the two "applied" rows, call `ApplyRedactions()`,
and only then add the two "mark-mode" marks. Reversing it applies all four and the
page loses the contrast it exists to demonstrate.

- [ ] **Step 1: Write redaction.ts**

```ts
import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, pageWidth, pageHeight, sectionHeader } from './theme.js';

/** Values destroyed by the apply pass — absent from the saved page's text. */
export const REDACTED_VALUES = ['$185,000.00', '+1 (415) 555-0182'];
/** Values left intact beneath unapplied marks — still present in the saved text. */
export const MARKED_VALUES = ['026009593', '4421-9087-7733-2104'];

type Phase = 'none' | 'apply' | 'mark';

interface Row { label: string; value: string; y: number; phase: Phase }

export function addRedactionDemo(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Redactions',
    'Mark-mode  vs  applied — both phases side by side on the same page');

  addText(page,
    'ApplyRedactions destructively rewrites the content stream — glyphs inside every targeted /Redact annotation are gone for good. Marks added after the call stay unapplied: the value reads through and is still copy-selectable.',
    [50, h - 180, w - 50, h - 130],
    { size: 10.5, color: [0.3, 0.3, 0.3], lineSpacing: 1.4 });

  addText(page, 'Internal memo — Q3 personnel changes', [60, h - 220, w - 60, h - 200],
    { font: 'Helvetica-Bold', size: 14 });

  const valueLLX = 220;
  const valueURX = 460;
  const rows: Row[] = [
    { label: 'Employee:', value: 'Maria Castellano (ID 47821)', y: 580, phase: 'none' },
    { label: 'Retention bonus:', value: REDACTED_VALUES[0], y: 550, phase: 'apply' },
    { label: 'Direct phone:', value: REDACTED_VALUES[1], y: 520, phase: 'apply' },
    { label: 'Bank routing:', value: MARKED_VALUES[0], y: 490, phase: 'mark' },
    { label: 'Account number:', value: MARKED_VALUES[1], y: 460, phase: 'mark' },
    { label: 'Effective date:', value: '2026-04-15', y: 430, phase: 'none' },
  ];

  for (const r of rows) {
    addText(page, r.label, [60, r.y, 215, r.y + 16],
      { font: 'Helvetica-Bold', size: 12, color: [0.3, 0.3, 0.3] });
    addText(page, r.value, [valueLLX, r.y, valueURX, r.y + 16],
      { font: 'Times-Roman', size: 12 });
    if (r.phase !== 'none') {
      const tag = r.phase === 'apply' ? 'applied' : 'mark-mode';
      const color: [number, number, number] =
        r.phase === 'apply' ? [0.7, 0.1, 0.1] : [0.5, 0.4, 0.0];
      addText(page, tag, [475, r.y + 1, w - 50, r.y + 15],
        { font: 'Helvetica-Bold', size: 8, color });
    }
  }

  const rectFor = (y: number): Box => [valueLLX - 4, y - 2, valueURX, y + 18];

  // Phase 1 — mark the "applied" rows, then apply. That rewrites the content
  // stream (the value glyphs inside each quad are destroyed) and removes those
  // marks, so the saved page holds a plain filled rectangle: no annotation, no
  // recoverable text.
  for (const r of rows.filter((x) => x.phase === 'apply')) {
    page.AddRedact({
      rect: rectFor(r.y),
      fill: [0, 0, 0],
      overlayText: '[REDACTED]',
      align: 'center',
      fontSize: 9,
      textColor: [1, 1, 1],
    });
  }
  page.ApplyRedactions();

  // Phase 2 — marks added AFTER the apply call stay unapplied for ever. The
  // annotation is part of the PDF and the content under it is alive. Colour is
  // the discriminator: black + "[REDACTED]" is applied and gone, amber + "MARK"
  // is an annotation whose value survives beneath it.
  for (const r of rows.filter((x) => x.phase === 'mark')) {
    page.AddRedact({
      rect: rectFor(r.y),
      color: [0.98, 0.82, 0.18],
      fill: [0.98, 0.82, 0.18],
      overlayText: 'MARK — annotation, not applied',
      align: 'center',
      fontSize: 9,
      textColor: [0.4, 0.3, 0],
    });
  }

  addText(page,
    'Try copying the values: applied rows yield nothing (the glyphs are not there), mark-mode rows still copy the original text.',
    [50, 380, w - 50, 400],
    { font: 'Helvetica-Oblique', size: 10, color: [0.5, 0.5, 0.5], align: 'center' });
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addRedactionDemo } from './redaction.js';
```
```ts
addRedactionDemo(redactPage);
```

- [ ] **Step 3: Run and confirm both phases behaved**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const p = Document.OpenFile('docs/feature-showcase.pdf').Pages[6];
const t = p.GetText();
for (const v of ['\$185,000.00', '+1 (415) 555-0182'])
  console.log('destroyed?', JSON.stringify(v), !t.includes(v));
for (const v of ['026009593', '4421-9087-7733-2104'])
  console.log('preserved?', JSON.stringify(v), t.includes(v));
console.log('remaining /Redact marks', p.Annotations.filter(a => a.Subtype === 'Redact').length);
"
```

Expected: two `destroyed? … true`, two `preserved? … true`, and
`remaining /Redact marks 2`. Any other result means the two phases ran in the
wrong order.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/redaction.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase redaction page, marked and applied"
```

---

### Task 10: bill.ts — single-page table

**Files:**
- Create: `_examples/feature-showcase/bill.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`.
- Produces: `addRestaurantBill(page: Page): void`

Port `.reference/main.go:1367-1491`. Copy the seven menu items and their prices
from lines 1424-1430 verbatim.

- [ ] **Step 1: Write bill.ts**

```ts
import type { Page } from '../../src/index.js';
import { createTable } from '../../src/index.js';
import { addText, pageWidth, pageHeight, sectionHeader, BROWN } from './theme.js';

export function addRestaurantBill(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Restaurant Bill',
    'Trattoria da Marco — single-page table with colSpan summary rows');

  addText(page, 'Date: 2026-05-19    Table: 7    Server: Marco    Receipt #: 4218',
    [50, h - 140, w - 50, h - 122],
    { size: 10, color: [0.3, 0.3, 0.3], align: 'center' });

  const table = createTable({
    font: 'Helvetica',
    fontSize: 11,
    outerBorder: { width: 1, color: BROWN },
    border: { width: 0.4, color: [0.75, 0.75, 0.75] },
    padding: { top: 5, right: 8, bottom: 5, left: 8 },
  });
  table.setColumnWidths([{ fixed: 260 }, { fixed: 50 }, { fixed: 75 }, { fixed: 75 }]);

  // Header row.
  const header = table.addRow(undefined, {
    background: BROWN, font: 'Helvetica-Bold', fontSize: 11, color: [1, 1, 1],
  });
  header.addCell('Item', { align: 'left' });
  header.addCell('Qty', { align: 'center' });
  header.addCell('Unit Price', { align: 'right' });
  header.addCell('Total', { align: 'right' });

  const items: Array<[string, number, number, number]> = [
    ['Bruschetta al Pomodoro', 2, 8.50, 17.00],
    ['Insalata Caprese', 1, 12.00, 12.00],
    ['Spaghetti alla Carbonara', 2, 16.50, 33.00],
    ['Pizza Margherita', 1, 14.00, 14.00],
    ['Tiramisu', 2, 7.50, 15.00],
    ['House Red Wine (bottle)', 1, 28.00, 28.00],
    ['Espresso', 4, 3.50, 14.00],
  ];
  let subtotal = 0;
  for (const [name, qty, unit, total] of items) {
    subtotal += total;
    const row = table.addRow();
    row.addCell(name, { align: 'left' });
    row.addCell(String(qty), { align: 'center' });
    row.addCell(`€${unit.toFixed(2)}`, { align: 'right' });
    row.addCell(`€${total.toFixed(2)}`, { align: 'right' });
  }

  // Summary rows: one label cell spanning the first three columns, then the
  // amount on the right.
  const addSummary = (
    label: string, amount: number, bold: boolean, bg?: [number, number, number],
  ): void => {
    const row = table.addRow(undefined, bg ? { background: bg } : {});
    const style = bold
      ? { font: 'Helvetica-Bold' as const, fontSize: 12 }
      : { font: 'Helvetica' as const, fontSize: 11 };
    row.addCell(label, { ...style, colSpan: 3, align: 'right' });
    row.addCell(`€${amount.toFixed(2)}`, { ...style, align: 'right' });
  };
  const tax = subtotal * 0.10;
  const service = subtotal * 0.15;
  addSummary('Subtotal:', subtotal, false);
  addSummary('Tax (10%):', tax, false);
  addSummary('Service (15%):', service, false);
  addSummary('TOTAL:', subtotal + tax + service, true, [0.97, 0.93, 0.85]);

  // 460pt wide, centred on A4 (595 - 460 = 135 -> 67.5 each side).
  page.AddTable(table, 67.5, h - 165, { width: 460 });

  addText(page, 'Grazie mille e a presto!', [50, 140, w - 50, 175],
    { font: 'Helvetica-Oblique', size: 14, color: BROWN, align: 'center' });
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addRestaurantBill } from './bill.js';
```
```ts
addRestaurantBill(billPage);
```

- [ ] **Step 3: Run and check the arithmetic reached the page**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const t = Document.OpenFile('docs/feature-showcase.pdf').Pages[7].GetText();
// 133.00 subtotal, 13.30 tax, 19.95 service, 166.25 total
for (const s of ['133.00','13.30','19.95','166.25']) console.log(s, t.includes(s));
"
```

Expected: four `true` lines. A mismatch means the item table was mistyped.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/bill.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase restaurant bill table page"
```

---

### Task 11: sales.ts — multi-page table

**Files:**
- Create: `_examples/feature-showcase/sales.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`, `assets.ts` (`salesBanner`).
- Produces: `addSalesReport(page: Page): number` — returns the number of
  continuation pages appended, for the console log.

Port `.reference/main.go:1507-1676`. Copy all five category blocks and their 31
product rows verbatim from lines 1594-1646. Three header rows repeat on every
continuation page.

- [ ] **Step 1: Write sales.ts**

```ts
import type { Page } from '../../src/index.js';
import { createTable } from '../../src/index.js';
import { pageWidth, pageHeight, sectionHeader, DEEP_NAVY } from './theme.js';
import { salesBanner } from './assets.js';

export function addSalesReport(page: Page): number {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Multi-Page Sales Report',
    'image header  •  repeating headers  •  colSpan  •  row background  •  overflow');

  const navy = DEEP_NAVY;
  const white: [number, number, number] = [1, 1, 1];
  const titleBG: [number, number, number] = [0.94, 0.95, 0.99];
  const sectionBG: [number, number, number] = [0.85, 0.88, 0.95];
  const zebraBG: [number, number, number] = [0.97, 0.97, 0.97];
  const totalBG: [number, number, number] = [0.97, 0.93, 0.85];

  const table = createTable({
    font: 'Helvetica',
    fontSize: 10,
    outerBorder: { width: 1, color: navy },
    border: { width: 0.4, color: [0.78, 0.78, 0.78] },
    padding: { top: 4, right: 6, bottom: 4, left: 6 },
  });
  table.setColumnWidths([{ fixed: 260 }, { fixed: 60 }, { fixed: 80 }, { fixed: 80 }]);

  // Row 0: banner image spanning all four columns; minHeight makes it a strip.
  table.addRow(undefined, { minHeight: 54, background: navy })
    .addCell('', { colSpan: 4, align: 'center', valign: 'center' })
    .setImage(salesBanner(), { align: 'center', valign: 'center', height: 46 });

  // Row 1: title.
  table.addRow(undefined, { minHeight: 28, background: titleBG })
    .addCell('Trattoria da Marco  —  Quarterly Sales Report  (Q3 2026)', {
      colSpan: 4, font: 'Helvetica-Bold', fontSize: 14, color: navy,
      align: 'center', valign: 'center',
    });

  // Row 2: column headers — row style propagates, per-cell align overrides.
  const colHeader = table.addRow(undefined, {
    minHeight: 22, background: navy, font: 'Helvetica-Bold', fontSize: 11, color: white,
  });
  colHeader.addCell('Item', { align: 'left', valign: 'center' });
  colHeader.addCell('Qty', { align: 'center', valign: 'center' });
  colHeader.addCell('Unit Price', { align: 'right', valign: 'center' });
  colHeader.addCell('Revenue', { align: 'right', valign: 'center' });

  table.setRepeatingRowsCount(3);

  const divider = (label: string): void => {
    table.addRow(undefined, { background: sectionBG })
      .addCell(label, {
        colSpan: 4, font: 'Helvetica-Bold', fontSize: 11, color: navy, align: 'left',
      });
  };

  let grandTotal = 0;
  let zebraIdx = 0;
  const addItems = (items: Array<[string, string, string, string]>): void => {
    items.forEach(([name, qty, unit, revenue], i) => {
      const row = table.addRow(undefined,
        (i + zebraIdx) % 2 === 1 ? { background: zebraBG } : {});
      row.addCell(name, { align: 'left' });
      row.addCell(qty, { align: 'center' });
      row.addCell(unit, { align: 'right' });
      row.addCell(revenue, { align: 'right' });
      grandTotal += Number(revenue);
    });
    zebraIdx += items.length;
  };

  divider('Pasta Dishes');
  addItems([
    ['Spaghetti alla Carbonara', '47', '16.50', '775.50'],
    ['Tagliatelle al Ragu Bolognese', '38', '17.00', '646.00'],
    ['Lasagna alla Forno', '29', '18.50', '536.50'],
    ['Fettuccine Alfredo', '24', '16.00', '384.00'],
    ["Penne all'Arrabbiata", '31', '15.00', '465.00'],
    ['Linguine al Pesto Genovese', '26', '16.50', '429.00'],
    ['Ravioli di Spinaci e Ricotta', '22', '17.50', '385.00'],
    ['Gnocchi ai Quattro Formaggi', '19', '17.00', '323.00'],
  ]);

  divider('Pizza Selection');
  addItems([
    ['Pizza Margherita', '62', '12.00', '744.00'],
    ['Pizza Quattro Formaggi', '41', '14.50', '594.50'],
    ['Pizza Capricciosa', '35', '15.00', '525.00'],
    ['Pizza Diavola', '33', '14.00', '462.00'],
    ['Pizza Marinara', '28', '11.00', '308.00'],
    ['Pizza Napoletana', '39', '13.50', '526.50'],
    ['Pizza Prosciutto e Funghi', '37', '15.50', '573.50'],
    ['Pizza Quattro Stagioni', '30', '16.00', '480.00'],
  ]);

  divider('Antipasti');
  addItems([
    ['Bruschetta al Pomodoro', '54', '8.50', '459.00'],
    ['Carpaccio di Manzo', '21', '14.00', '294.00'],
    ['Insalata Caprese', '33', '12.00', '396.00'],
    ['Vitello Tonnato', '18', '16.50', '297.00'],
  ]);

  divider('Desserts');
  addItems([
    ['Tiramisu Classico', '67', '7.50', '502.50'],
    ['Panna Cotta ai Frutti di Bosco', '44', '7.00', '308.00'],
    ['Cannoli Siciliani', '32', '6.50', '208.00'],
    ['Gelato Misto (3 scoops)', '58', '6.00', '348.00'],
    ['Sfogliatella Napoletana', '27', '7.50', '202.50'],
  ]);

  divider('Beverages');
  addItems([
    ['House Red Wine (Chianti, bottle)', '42', '28.00', '1176.00'],
    ['House White Wine (Pinot Grigio, bottle)', '36', '26.00', '936.00'],
    ['Sparkling Water (Acqua Frizzante, 1L)', '89', '4.50', '400.50'],
    ['Espresso', '215', '3.50', '752.50'],
    ['Cappuccino', '127', '4.50', '571.50'],
    ['Limoncello (glass)', '53', '8.00', '424.00'],
  ]);

  // TOTAL row: two colSpan(2) cells so the formatted total has room.
  const totalRow = table.addRow(undefined, {
    minHeight: 32, background: totalBG,
    padding: { top: 6, right: 8, bottom: 6, left: 8 },
  });
  totalRow.addCell('GRAND TOTAL', {
    colSpan: 2, font: 'Helvetica-Bold', fontSize: 13, color: navy,
    align: 'right', valign: 'center',
  });
  totalRow.addCell(`€${grandTotal.toFixed(2)}`, {
    colSpan: 2, font: 'Helvetica-Bold', fontSize: 14, color: navy,
    align: 'right', valign: 'center',
  });

  const res = page.AddTable(table, 50, h - 130, {
    width: w - 100, autoPaginate: true, bottomMargin: 70, topMargin: 60,
  });
  return res.pages.length - 1;
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addSalesReport } from './sales.js';
```

Immediately after the `const salesPage = …` line:

```ts
const salesContinuations = addSalesReport(salesPage);
console.log(`sales report: ${salesContinuations} continuation page(s) appended`);
```

The report **must** run before the landscape/vector/flatten pages are allocated, so
its continuation pages land in the right place — that is why `salesPage` is created
on its own line ahead of them.

- [ ] **Step 3: Run and check pagination and the repeated header**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
const withHeader = d.Pages
  .map((p, i) => [i + 1, p.GetText().includes('Quarterly Sales Report')])
  .filter(([, ok]) => ok).map(([n]) => n);
console.log('pages', d.Pages.length, 'header repeats on', withHeader.join(','));
"
```

Expected: at least two page numbers in `header repeats on` — the report overflows,
so the three header rows are reprinted. Grand total is `€15433.00`; confirm it
appears on the last of those pages.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/sales.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase multi-page sales report table"
```

---

### Task 12: landscape.ts — wide bar chart

**Files:**
- Create: `_examples/feature-showcase/landscape.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`.
- Produces: `addLandscapeChart(page: Page): void`

Port `.reference/main.go:2291-2385`.

- [ ] **Step 1: Write landscape.ts**

```ts
import type { Page } from '../../src/index.js';
import { addText, pageWidth, sectionHeader } from './theme.js';

export function addLandscapeChart(page: Page): void {
  const w = pageWidth(page); // 842 x 595 for A4 landscape

  sectionHeader(page, 'Annual Sales — 12 Month Trend',
    'PageFormat.A4.landscape()  •  alpha bar fills  •  dashed grid  •  polyline trend  •  labels');

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const values = [42, 51, 49, 58, 67, 72, 79, 81, 74, 68, 55, 62];

  const chartLeft = 80;
  const chartBottom = 110;
  const chartTop = 440;
  const chartRight = w - 60;
  const barSlot = (chartRight - chartLeft) / months.length;
  const barWidth = barSlot * 0.62;

  // Round the y-axis bound up to a nice value so labels read 20/40/60/80/100.
  const target = Math.max(...values) * 1.15;
  const yStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]
    .find((s) => s * 5 >= target) ?? 1;
  const yMax = yStep * 5;
  const scaleY = (chartTop - chartBottom) / yMax;

  const g = page.Graphics();

  // Y-axis grid lines.
  for (let i = 1; i <= 5; i++) {
    const y = chartBottom + (i * (chartTop - chartBottom)) / 5;
    g.save().setStrokeColor([0.9, 0.9, 0.93]).setLineWidth(0.5).setDash([2, 3])
      .drawLine(chartLeft, y, chartRight, y).stroke().restore();
    addText(page, `€${(yStep * i).toFixed(0)}k`,
      [chartLeft - 38, y - 5, chartLeft - 4, y + 5],
      { size: 8, color: [0.5, 0.5, 0.55], align: 'right' });
  }

  // X-axis baseline.
  g.save().setStrokeColor([0.2, 0.2, 0.2]).setLineWidth(1.2).setLineCap(1)
    .drawLine(chartLeft, chartBottom, chartRight, chartBottom).stroke().restore();

  // Bars, month labels, value labels.
  const tops: Array<[number, number]> = [];
  values.forEach((v, i) => {
    const x = chartLeft + i * barSlot + (barSlot - barWidth) / 2;
    const barTop = chartBottom + v * scaleY;
    g.save().setOpacity(0.92)
      .setFillColor([0.3, 0.55, 0.85])
      .setStrokeColor([0.1, 0.3, 0.6]).setLineWidth(0.6)
      .rect(x, chartBottom, barWidth, barTop - chartBottom).fillStroke().restore();
    addText(page, months[i], [x - 5, chartBottom - 18, x + barWidth + 5, chartBottom - 5],
      { size: 10, color: [0.3, 0.3, 0.35], align: 'center' });
    addText(page, `€${v.toFixed(0)}k`, [x - 10, barTop + 2, x + barWidth + 10, barTop + 14],
      { font: 'Helvetica-Bold', size: 9, color: [0.1, 0.3, 0.6], align: 'center' });
    tops.push([x + barWidth / 2, barTop]);
  });

  // Trend polyline through the bar tops.
  g.setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(1.8).setLineCap(1).setLineJoin(1)
    .polyline(tops).stroke();

  g.apply();
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addLandscapeChart } from './landscape.js';
```

after the `const landscapePage = …` line:

```ts
addLandscapeChart(landscapePage);
```

- [ ] **Step 3: Run and check the page really is landscape**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
const p = d.Pages.find(x => x.GetText().includes('12 Month Trend'));
console.log('page', p.Number, 'size', p.Rect[2]-p.Rect[0], 'x', p.Rect[3]-p.Rect[1]);
console.log('paths', p.GetPaths().length);
"
```

Expected: `size 842 x 595`, and at least 18 paths (5 grid lines + baseline +
12 bars + trend line).

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/landscape.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase landscape 12-month bar chart"
```

---

### Task 13: vector.ts — the primitives gallery

**Files:**
- Create: `_examples/feature-showcase/vector.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`.
- Produces: `addVectorShowcase(page: Page): void`

Port `.reference/main.go:1692-1888` — a 2x3 gallery of labelled cards.

- [ ] **Step 1: Write vector.ts**

```ts
import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, sectionHeader, NAVY } from './theme.js';

export function addVectorShowcase(page: Page): void {
  sectionHeader(page, 'Vector Graphics',
    'lines  •  rectangles  •  circle & ellipse  •  polyline  •  polygon  •  path with arc  •  gradient fills');

  const colCount = 2;
  const rowCount = 3;
  const gridLeft = 50;
  const gridRight = 545;
  const gridTop = 705;
  const gridBottom = 105;
  const gapX = 14;
  const gapY = 14;
  const labelInset = 12;
  const labelHeight = 22;
  const cardW = (gridRight - gridLeft - gapX) / colCount;
  const cardH = (gridTop - gridBottom - gapY * (rowCount - 1)) / rowCount;

  const g = page.Graphics();

  /** Paint a card frame and label; return the inner drawing box. */
  const drawCard = (col: number, row: number, label: string): Box => {
    const x = gridLeft + col * (cardW + gapX);
    const y = gridTop - (row + 1) * cardH - row * gapY;
    g.setFillColor([0.985, 0.985, 0.995])
      .setStrokeColor([0.83, 0.85, 0.92]).setLineWidth(0.5)
      .roundedRect(x, y, cardW, cardH, 6).fillStroke();
    addText(page, label,
      [x + labelInset, y + cardH - labelHeight - 2, x + cardW - labelInset, y + cardH - 4],
      { font: 'Helvetica-Bold', size: 11, color: NAVY });
    return [x + labelInset, y + 10, x + cardW - labelInset, y + cardH - labelHeight - 6];
  };

  const midY = (b: Box): number => (b[1] + b[3]) / 2;
  const midX = (b: Box): number => (b[0] + b[2]) / 2;

  // --- Card 1: three stroke variants -------------------------------------
  let inner = drawCard(0, 0, 'Lines — width, dash, cap');
  let ym = midY(inner);
  g.save().setStrokeColor([0.20, 0.30, 0.70]).setLineWidth(2.5).setLineCap(1)
    .drawLine(inner[0] + 8, ym + 28, inner[2] - 8, ym + 28).stroke().restore();
  g.save().setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(2).setDash([8, 5])
    .drawLine(inner[0] + 8, ym, inner[2] - 8, ym).stroke().restore();
  g.save().setStrokeColor([0.10, 0.50, 0.30]).setLineWidth(3).setLineCap(1).setDash([0.5, 6])
    .drawLine(inner[0] + 8, ym - 28, inner[2] - 8, ym - 28).stroke().restore();

  // --- Card 2: rectangle + rounded rectangle ------------------------------
  inner = drawCard(1, 0, 'Rectangle  •  Rounded');
  const gap = 14;
  const half = (inner[2] - inner[0] - gap) / 2;
  g.save().setFillColor([0.82, 0.88, 1.00])
    .setStrokeColor([0.20, 0.30, 0.70]).setLineWidth(1.2)
    .rect(inner[0], inner[1] + 6, half, inner[3] - inner[1] - 12).fillStroke().restore();
  g.save().setFillColor([1.00, 0.92, 0.78])
    .setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(1.2)
    .roundedRect(inner[0] + half + gap, inner[1] + 6,
      inner[2] - (inner[0] + half + gap), inner[3] - inner[1] - 12, 14)
    .fillStroke().restore();

  // --- Card 3: circle with a radial gradient, plus an ellipse -------------
  inner = drawCard(0, 1, 'Circle  •  radial gradient');
  ym = midY(inner);
  const cR = 28;
  const cCx = inner[0] + cR + 12;
  g.save()
    .setFillGradient({
      kind: 'radial', cx: cCx, cy: ym, r: cR,
      fx: cCx - cR * 0.4, fy: ym + cR * 0.4,
      stops: [
        { offset: 0, color: [0.98, 0.95, 1.0] },
        { offset: 1, color: [0.55, 0.25, 0.70] },
      ],
    })
    .setStrokeColor([0.45, 0.20, 0.62]).setLineWidth(1.4)
    .circle(cCx, ym, cR).fillStroke().restore();
  g.save().setOpacity(0.92).setFillColor([0.85, 0.95, 0.85])
    .setStrokeColor([0.10, 0.50, 0.30]).setLineWidth(1.4)
    .ellipse(inner[2] - 50, ym, 44, 24).fillStroke().restore();

  // --- Card 4: polyline zigzag -------------------------------------------
  inner = drawCard(1, 1, 'Polyline');
  const steps = 8;
  const stride = (inner[2] - inner[0] - 16) / steps;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    pts.push([inner[0] + 8 + i * stride, i % 2 === 1 ? inner[3] - 14 : inner[1] + 14]);
  }
  g.save().setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(2.5).setLineCap(1).setLineJoin(1)
    .polyline(pts).stroke().restore();

  // --- Card 5: five-point star with a radial gradient fill ----------------
  inner = drawCard(0, 2, 'Polygon');
  const sx = midX(inner);
  const sy = midY(inner);
  const outerR = 36;
  const innerR = 15;
  const star: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const ang = Math.PI / 2 - (i * Math.PI) / 5;
    const r = i % 2 === 1 ? innerR : outerR;
    star.push([sx + r * Math.cos(ang), sy + r * Math.sin(ang)]);
  }
  g.save()
    .setFillGradient({
      kind: 'radial', cx: sx, cy: sy, r: outerR,
      stops: [
        { offset: 0, color: [1.00, 0.96, 0.70] },
        { offset: 1, color: [0.96, 0.66, 0.12] },
      ],
    })
    .setStrokeColor([0.78, 0.55, 0.06]).setLineWidth(1.3).setLineJoin(0).setMiterLimit(4)
    .polygon(star).fillStroke().restore();

  // --- Card 6: pie slice via arc, plus a cubic Bezier wave ----------------
  inner = drawCard(1, 2, 'Path with arc');
  const pcx = inner[0] + 38;
  const pcy = (inner[1] + inner[3]) / 2;
  const pieR = 34;
  g.save().setFillColor([0.78, 0.88, 1.00])
    .setStrokeColor([0.20, 0.45, 0.78]).setLineWidth(1.3)
    .moveTo(pcx, pcy).lineTo(pcx + pieR, pcy)
    .arc(pcx, pcy, pieR, 0, 2.0944)  // 120 degrees
    .close().fillStroke().restore();

  const wx0 = inner[0] + 88;
  const wx1 = inner[2] - 4;
  g.save().setStrokeColor([0.95, 0.55, 0.05]).setLineWidth(2.2).setLineCap(1).setLineJoin(1)
    .moveTo(wx0, pcy)
    .curveTo(wx0 + 14, pcy + 30, wx0 + 30, pcy - 30, wx0 + 44, pcy)
    .curveTo(wx0 + 58, pcy + 30, wx1 - 14, pcy - 30, wx1, pcy)
    .stroke().restore();

  g.apply();
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addVectorShowcase } from './vector.js';
```
```ts
addVectorShowcase(vectorPage);
```

- [ ] **Step 3: Run and eyeball the six cards**

Run: `npm run example:showcase`, then open the vector page. Expected: six framed
cards, each labelled, with the sphere-like radial gradient in card 3 and the
gold-gradient star in card 5. Confirm the dashed line in card 1 is dashed and the
solid lines either side of it are **not** — a leaked `setDash` across a `save()`
boundary would show up here first.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/vector.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase vector graphics gallery page"
```

---

### Task 14: flatten.ts — selective flattening

**Files:**
- Create: `_examples/feature-showcase/flatten.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`.
- Produces: `addFlattenDemo(doc: Document, page: Page): void`

Port `.reference/main.go:826-896`. Interactive fields and a live annotation are
created, then baked into static content — leaving the AcroForm page's fields
untouched. **Order matters:** each object is flattened after it is created and
valued, never before.

- [ ] **Step 1: Write flatten.ts**

```ts
import type { Document, Page } from '../../src/index.js';
import {
  addText, pageWidth, pageHeight, sectionHeader, NAVY, TINT, GREEN, FAINT, MUTED,
} from './theme.js';

export function addFlattenDemo(doc: Document, page: Page): void {
  const form = doc.Form;
  const pageNum = page.Number;
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Form & Annotation Flattening',
    'field.Flatten()  •  annotation.Flatten()  •  bake interactive content into static content');

  addText(page,
    "The text field, checkbox and note below were created as interactive AcroForm fields and a live annotation, then flattened — baked into the page's content stream. In the saved PDF this page has no /Annots and contributes no /AcroForm fields: the look is permanent and non-editable, while the still-interactive form lives on the AcroForm Fields page.",
    [40, h - 165, w - 40, h - 115],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  const addLabel = (text: string, y: number): void => {
    addText(page, text, [60, y, 200, y + 18], { font: 'Helvetica-Bold', size: 11 });
  };

  addLabel('Full name:', 660);
  const tb = form.AddTextField({
    page: pageNum, rect: [210, 660, 460, 680], name: 'FlattenName', value: 'Alice Sample',
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY,
    borderWidth: 1, font: 'Helvetica', fontSize: 12,
  });

  addLabel('Subscribe:', 620);
  const cb = form.AddCheckbox({
    page: pageNum, rect: [210, 620, 238, 638], name: 'FlattenCheck',
    checked: true, borderColor: NAVY, borderWidth: 1, textColor: GREEN,
  });

  addLabel('Note:', 575);
  const note = page.AddFreeText({
    rect: [210, 535, 470, 590],
    contents: 'Sticky note — flattened into the page.',
    fontSize: 11, textColor: NAVY, align: 'left',
  });

  // Bake all three. Each bakes its own ink and then unwires itself; the fields
  // on the AcroForm page are untouched.
  tb.Flatten();
  cb.Flatten();
  note.Flatten();

  addText(page, 'Now static content — there is nothing to click or edit in a viewer.',
    [40, 495, w - 40, 515],
    { font: 'Helvetica-Oblique', size: 10, color: MUTED, align: 'center' });
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addFlattenDemo } from './flatten.js';
```
```ts
addFlattenDemo(doc, flattenPage);
```

- [ ] **Step 3: Run and confirm the page is inert while the form survives**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
const p = d.Pages.find(x => x.GetText().includes('Annotation Flattening'));
console.log('annots on flatten page', p.Annotations.length);
console.log('fields still in the form', d.Form.Fields.map(f => f.FullName).join(','));
console.log('flattened text baked?', p.GetText().includes('Alice Sample'));
"
```

Expected: `annots on flatten page 0`; the six AcroForm-page fields listed with
**no** `FlattenName` or `FlattenCheck`; `flattened text baked? true`.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/flatten.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase selective form and annotation flattening"
```

---

### Task 15: flowshowcase.ts — Giants of Physics

**Files:**
- Create: `_examples/feature-showcase/flowshowcase.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`, `assets.ts` (`newton`, `einstein`, `dejaVuSansPath`).
- Produces: `addFlowShowcase(doc: Document): Page[]` — the pages the flow created.

Port `.reference/main.go:913-1012`. Copy both prose blocks, both quotes and both
bullet lists verbatim from lines 971-1001.

- [ ] **Step 1: Write flowshowcase.ts**

```ts
import type { Document, Page } from '../../src/index.js';
import { PageFormat } from '../../src/index.js';
import { sectionHeader, INK, MUTED, NAVY } from './theme.js';
import { dejaVuSansPath, einstein, newton } from './assets.js';

export function addFlowShowcase(doc: Document): Page[] {
  const indigo = NAVY;
  const ink = INK;
  const muted = MUTED;

  // The formula card uses DejaVu Sans so the sub/superscripts render.
  const formulaFont = doc.AddFontFile(dejaVuSansPath());

  const body = { font: 'Helvetica' as const, fontSize: 9.5, color: ink, leading: 13.3 };
  const h2 = { font: 'Helvetica-Bold' as const, fontSize: 15, color: indigo };
  const caption = {
    font: 'Helvetica-Oblique' as const, fontSize: 8, color: muted, align: 'center' as const,
  };
  const lede = {
    font: 'Helvetica-BoldOblique' as const, fontSize: 10, color: indigo, leading: 13,
  };

  const flow = doc.NewFlow({
    format: PageFormat.A4.landscape(),
    columns: 2,
    columnGap: 34,
    marginLeft: 48, marginRight: 48, marginTop: 128, marginBottom: 52,
    paragraphSpacing: 7,
  });

  const giant = (
    img: Uint8Array, name: string, dates: string, tagline: string, prose: string,
    formula: string, quote: string, bullets: string[], accent: [number, number, number],
  ): void => {
    // Portrait + caption, floated left; the heading and prose wrap beside it and
    // then continue at full column width beneath.
    const portrait = doc.NewFloatingBox({ width: 112, spacing: 2 });
    portrait.AddImage(img, { width: 112 });
    portrait.AddParagraph(dates, caption);
    flow.AddFloatBox(portrait, 'left');

    flow.AddHeading(2, name, h2);
    flow.AddParagraph(tagline, lede);
    flow.AddParagraph(prose, body);

    // Formula card — an in-flow box; symmetric padding centres the single line.
    const card = doc.NewFloatingBox({
      width: 320, spacing: 0,
      background: [0.95, 0.96, 1],
      border: { width: 0.7, color: accent, sides: 'all' },
      padding: { top: 11, right: 8, bottom: 11, left: 8 },
    });
    card.AddParagraph(formula,
      { font: formulaFont, fontSize: 15, color: indigo, align: 'center' });
    flow.AddFloatingBox(card);

    // Pull-quote — an in-flow box with a left rule only.
    const pull = doc.NewFloatingBox({
      width: 320, spacing: 0,
      border: { width: 3, color: accent, sides: { left: true } },
      padding: { top: 9, right: 6, bottom: 9, left: 12 },
    });
    pull.AddParagraph(quote,
      { font: 'Times-Italic', fontSize: 10, color: muted, leading: 11.5 });
    flow.AddFloatingBox(pull);

    flow.AddList(bullets, { font: 'Helvetica', fontSize: 9, color: ink, leading: 11.7 });
  };

  giant(newton(),
    'Isaac Newton',
    'Woolsthorpe, 1643  —  London, 1727',
    'The architect of classical mechanics.',
    "Newton's Principia Mathematica (1687) unified terrestrial and celestial motion under a single law of universal gravitation, and his three laws of motion became the bedrock of physics for the next two centuries. Working in near-isolation during the plague years at Woolsthorpe, he also co-invented the calculus, and in the Opticks he demonstrated with prisms that white light is a mixture of colours. A reflecting telescope of his own design and studies of cooling and the speed of sound rounded out a singular career. As Lucasian Professor at Cambridge, and later Master of the Royal Mint, he pursued mathematics, alchemy and theology with the same relentless focus. Elected President of the Royal Society in 1703, he was knighted by Queen Anne two years later — the first man of science to be so honoured.",
    'F  =  G · m₁m₂ / r²',
    '“If I have seen further it is by standing on the shoulders of Giants.”',
    [
      'Laws of motion & universal gravitation',
      'Co-invention of the calculus',
      'Decomposition of white light (Opticks)',
      'The reflecting telescope',
    ],
    [0.55, 0.45, 0.20]);

  flow.AddColumnBreak(); // Newton fills the left column; Einstein opens the right.

  giant(einstein(),
    'Albert Einstein',
    'Ulm, 1879  —  Princeton, 1955',
    'The author of relativity.',
    "Einstein's 1905 “miracle year” produced special relativity, the explanation of Brownian motion, the photoelectric effect — for which he received the 1921 Nobel Prize — and the mass–energy equivalence E = mc². A decade later, general relativity recast gravity as the curvature of spacetime, a description confirmed again and again, from starlight bending around the Sun in 1919 to the gravitational waves detected a century later. Born in Ulm and schooled in Munich and Zurich, he sketched his earliest ideas while working as a clerk in the Bern patent office. He left Germany for good in 1933, settled at the Institute for Advanced Study in Princeton, and spent his final years there — an outspoken advocate for pacifism and civil rights — pursuing a unified field theory.",
    'E  =  mc²',
    '“Imagination is more important than knowledge.”',
    [
      'Special & general relativity',
      'Mass–energy equivalence, E = mc²',
      'Photoelectric effect (1921 Nobel Prize)',
      'Foundations of modern cosmology',
    ],
    [0.20, 0.40, 0.60]);

  const pages = flow.Render();

  // The standard section header, drawn on the flow's first page — the flow left
  // a 128pt top margin clear for exactly this.
  sectionHeader(pages[0], 'Flow Layout — Giants of Physics',
    'two columns  •  floated portraits with wrap-around  •  formula cards  •  pull-quotes  •  lists');

  return pages;
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addFlowShowcase } from './flowshowcase.js';
```

Replace Task 3's comment placeholder

```ts
// The flow appends its own page(s) — added in a later task, which also adds its
// section entry below.
```

with the real call. It must sit after `addFlattenDemo(doc, flattenPage);` and
before the render page is allocated, so the flow's pages land ahead of it:

```ts
const flowPages = addFlowShowcase(doc);
const flowPage = flowPages[0];
```

Then replace the sections-array comment

```ts
  // The DEST_FLOW entry is spliced in here by the flow task, once that page exists.
```

with the entry itself:

```ts
  { dest: DEST_FLOW, title: 'Flow Layout — Giants of Physics', subtype: 'flow', page: flowPage },
```

- [ ] **Step 3: Run and confirm the two-column split**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
const p = d.Pages.find(x => x.GetText().includes('Giants of Physics'));
console.log('page', p.Number, 'size', p.Rect[2]-p.Rect[0], 'x', p.Rect[3]-p.Rect[1]);
const t = p.GetText();
for (const s of ['Isaac Newton','Albert Einstein','E  =  mc²','shoulders of Giants'])
  console.log(s, t.includes(s));
"
```

Expected: `size 842 x 595` (landscape), and four `true` lines. Open the page and
confirm Newton occupies the left column and Einstein the right, each portrait
floated with prose wrapping beside it.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/flowshowcase.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase flow layout, Giants of Physics"
```

---

### Task 16: contents.ts — the table of contents, and the outline tree

**Files:**
- Create: `_examples/feature-showcase/contents.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`, `main.ts`'s `Section`.
- Produces:
  - `addTOC(page: Page, sections: Section[]): void`
  - `addBookmarks(doc: Document, sections: Section[]): void`

Port `.reference/main.go:2072-2122` (TOC) and `1899-1935` (outlines).

**The TOC's `label` is deliberately omitted.** Go computed `page.Number() - 2` by
hand; `AddTOC` defaults each row's label to the target page's `/PageLabels` label,
which `main.ts` has already set. A sequential `"N."` index is still folded into the
title so the sales report's continuation pages create no gap in the numbering.

- [ ] **Step 1: Write contents.ts**

```ts
import type { Document, Page } from '../../src/index.js';
import type { OutlineItem } from '../../src/index.js';
import type { Section } from './main.js';
import { addText, pageWidth, pageHeight, sectionHeader } from './theme.js';

export function addTOC(page: Page, sections: Section[]): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Contents',
    'page.AddTOC  •  dotted leaders  •  logical page labels  •  clickable links');

  // No explicit `label`: AddTOC defaults to each target page's /PageLabels
  // label, which main.ts set before calling this.
  page.AddTOC(
    sections.map((s, i) => ({ title: `${i + 1}.  ${s.title}`, page: s.page.Number })),
    [72, 160, w - 172, h - 340],
    {
      font: 'Helvetica',
      fontSize: 13,
      color: [0.1, 0.1, 0.15],
      rowGap: 18,
    },
  );

  addText(page, 'Click any title above to jump to the section.',
    [50, 120, w - 50, 140],
    { font: 'Helvetica-Oblique', size: 10, color: [0.55, 0.55, 0.6], align: 'center' });
}

const OUTLINE_COLORS: Record<string, [number, number, number] | undefined> = {
  text: [0.15, 0.20, 0.55],
  image: undefined,
  form: undefined,
  annotations: [0.6, 0, 0.6],
  redaction: [0, 0, 0],
  bill: [0.6, 0.3, 0.1],
  sales: [0.1, 0.15, 0.4],
  landscape: [0.4, 0.3, 0.6],
  vector: [0.1, 0.5, 0.3],
  flatten: [0.3, 0.3, 0.3],
  flow: [0.2, 0.4, 0.6],
};

const BOLD_SUBTYPES = new Set(['text', 'bill', 'sales', 'vector']);

/** A two-level tree: one entry per section, with per-category children under
 *  the sales report. Every destination is a NAME, so it resolves at view time
 *  and keeps working after the redaction pass rewrites content streams. */
export function addBookmarks(doc: Document, sections: Section[]): void {
  const items: OutlineItem[] = sections.map((s) => {
    const item: OutlineItem = { Title: s.title, Dest: { name: s.dest } };
    const color = OUTLINE_COLORS[s.subtype];
    if (color) item.Color = color;
    if (BOLD_SUBTYPES.has(s.subtype)) item.Bold = true;
    if (s.subtype === 'sales') {
      item.Open = true;
      item.Children = ['Pasta', 'Pizza', 'Antipasti', 'Desserts', 'Beverages']
        .map((cat) => ({ Title: cat, Dest: { name: s.dest } }));
    }
    return item;
  });
  doc.SetOutlines(items);
}
```

- [ ] **Step 2: Wire both into main.ts**

```ts
import { addBookmarks, addTOC } from './contents.js';
```

`addTOC` goes **after** `doc.SetPageLabels(...)`; `addBookmarks` goes after it:

```ts
addTOC(tocPage, sections);
addBookmarks(doc, sections);
```

- [ ] **Step 3: Run and confirm the labels and links**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
const toc = d.Pages[1];
console.log(toc.GetText().split('\n').filter(Boolean).slice(0, 20).join('\n'));
console.log('links', toc.Annotations.filter(a => a.Subtype === 'Link').length);
console.log('outline roots', d.GetOutlines().length);
console.log('sales children', d.GetOutlines().find(i => i.Title.includes('Sales')).Children.length);
"
```

Expected: twelve numbered rows with dot leaders; `links 12`; `outline roots 12`;
`sales children 5`. The Text Capabilities row's label must read `1`, not `3` —
that is the `/PageLabels` default doing its job.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/contents.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase table of contents and outline tree"
```

---

### Task 17: furniture — logo stamp and watermark

**Files:**
- Create: `_examples/feature-showcase/furniture.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`, `assets.ts` (`asposeLogo`).
- Produces:
  - `stampLogoOnEveryPage(doc: Document, skip: Page[]): void`
  - `addCenteredWatermark(page: Page, text: string): void`

Port `.reference/main.go:2425-2491`.

- [ ] **Step 1: Write furniture.ts**

```ts
import type { Document, Page } from '../../src/index.js';
import { pageWidth, pageHeight, xywh } from './theme.js';
import { asposeLogo } from './assets.js';

/** The Aspose wordmark in the top-right corner of every page but the skipped
 *  ones (cover and TOC carry their own branding). The logo's viewBox is 314x100,
 *  and the stamp rect keeps that aspect. There is no load-once SVG handle in
 *  this library, so the same bytes are parsed once per page — fine at this
 *  scale, and cheaper than the alternative of caching a Form XObject by hand. */
export function stampLogoOnEveryPage(doc: Document, skip: Page[]): void {
  const svg = asposeLogo();
  const skipNumbers = new Set(skip.map((p) => p.Number));
  const stampW = 120;
  const stampH = 38; // 314/100 * 38 ~= 119.3
  const margin = 25;

  for (const p of doc.Pages) {
    if (skipNumbers.has(p.Number)) continue;
    const urx = pageWidth(p) - margin;
    const ury = pageHeight(p) - margin;
    p.AddSVGObject(svg, xywh([urx - stampW, ury - stampH, urx, ury]));
  }
}

/** "WATERMARK" at 45 degrees, geometrically centred, sunk beneath the page
 *  content. AddTextBlock rotates about the rect's bottom-left corner, so the
 *  rect origin is solved for so the post-rotation centre lands on the page
 *  centre. */
export function addCenteredWatermark(page: Page, text: string): void {
  const w = pageWidth(page);
  const h = pageHeight(page);
  const fontSize = 48;
  const rectW = 340; // "WATERMARK" at 48pt bold needs ~315pt
  const rectH = 60;
  const cos45 = Math.SQRT1_2;
  const sin45 = Math.SQRT1_2;

  const llx = w / 2 - (rectW / 2) * cos45 + (rectH / 2) * sin45;
  const lly = h / 2 - (rectW / 2) * sin45 - (rectH / 2) * cos45;

  page.AddTextBlock(text, [llx, lly, rectW, rectH], {
    font: 'Helvetica-Bold',
    fontSize,
    color: [0.85, 0.85, 0.85],
    opacity: 0.4,
    rotate: 45,
    align: 'center',
    valign: 'center',
    behind: true,
  });
}
```

- [ ] **Step 2: Wire it into main.ts**

```ts
import { addCenteredWatermark, stampLogoOnEveryPage } from './furniture.js';
```

Place both **before** the footer loop and before the render page is filled — the
render thumbnails must show finished pages:

```ts
stampLogoOnEveryPage(doc, [coverPage, tocPage]);
// The watermark lives only on the Text Capabilities page, where it doubles as
// the example of `behind: true`. Other body pages read more cleanly without it.
addCenteredWatermark(textPage, 'WATERMARK');
```

- [ ] **Step 3: Run and confirm the watermark sinks and the logo skips two pages**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
console.log('watermark on text page', d.Pages[2].GetText().includes('WATERMARK'));
console.log('cover has no stamp', !d.Pages[0].GetText().includes('WATERMARK'));
"
```

Expected: `true` then `true`. Open the text page and confirm the diagonal
WATERMARK sits **behind** the font samples, not over them.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/furniture.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase per-page logo stamp and centred watermark"
```

---

### Task 18: render.ts — rendering and imposition thumbnails

**Files:**
- Create: `_examples/feature-showcase/render.ts`
- Modify: `_examples/feature-showcase/main.ts`

**Interfaces:**
- Consumes: `theme.ts`.
- Produces:
  - `interface Thumb { img: Uint8Array; aspect: number; label: string }`
  - `renderPageThumb(page: Page, label: string): Thumb`
  - `imposedSheetThumb(doc: Document, label: string): Thumb`
  - `addRenderShowcase(page: Page, thumbs: Thumb[]): void`

Port `.reference/main.go:317-392`. This task runs **last** among the content
tasks: the thumbnails rasterize finished pages, so the logo stamp, watermark and
footer must already be on them.

- [ ] **Step 1: Write render.ts**

```ts
import type { Document, Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, sectionHeader, xywh } from './theme.js';

/** One pre-rendered thumbnail plus its source sheet's aspect, so portrait pages
 *  and the wide booklet spread share one tidy grid. */
export interface Thumb {
  img: Uint8Array;
  aspect: number;
  label: string;
}

/** Rasterize a finished page with the pure-TypeScript renderer at 96 DPI. */
export function renderPageThumb(page: Page, label: string): Thumb {
  const img = page.ToImage({ scale: 96 / 72 });
  const w = page.Rect[2] - page.Rect[0];
  const h = page.Rect[3] - page.Rect[1];
  return { img, aspect: w / h, label };
}

/** Rasterize the first sheet of an imposed document (the output of NUp/Booklet). */
export function imposedSheetThumb(doc: Document, label: string): Thumb {
  return renderPageThumb(doc.Pages[0], label);
}

/** A 2x2 grid of framed, captioned thumbnails. The top row is finished pages
 *  the renderer drew; the bottom row is an N-up sheet and a booklet spread the
 *  imposition API built from this document, which the renderer then drew. */
export function addRenderShowcase(page: Page, thumbs: Thumb[]): void {
  sectionHeader(page, 'Rendering & Imposition',
    'pages rasterized by the pure-TypeScript renderer  ·  N-up & booklet imposition sheets');

  const slotW = 232;
  const slotH = 210;
  const gapX = 40;
  const gapY = 34;
  const captionH = 15;
  const topY = 690;
  const pageW = page.Rect[2] - page.Rect[0];
  const leftX = (pageW - (2 * slotW + gapX)) / 2;

  const g = page.Graphics();
  thumbs.forEach((th, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const sx = leftX + col * (slotW + gapX);
    const slotTop = topY - row * (slotH + captionH + gapY);

    // Fit inside the slot, aspect preserved, centred.
    let dw = slotW;
    let dh = slotH;
    if (th.aspect > slotW / slotH) dh = slotW / th.aspect;
    else dw = slotH * th.aspect;
    const ox = sx + (slotW - dw) / 2;
    const oy = slotTop - slotH + (slotH - dh) / 2;
    const rect: Box = [ox, oy, ox + dw, oy + dh];

    page.AddImage(th.img, xywh(rect));
    g.setStrokeColor([0.72, 0.72, 0.74]).setLineWidth(0.8)
      .rect(ox, oy, dw, dh).stroke();

    addText(page, th.label,
      [sx, slotTop - slotH - captionH, sx + slotW, slotTop - slotH - 2],
      { size: 9, color: [0.3, 0.3, 0.3], align: 'center' });
  });
  g.apply();
}
```

- [ ] **Step 2: Wire it into main.ts**

Add after the furniture calls and after the footer loop:

```ts
import { addRenderShowcase, imposedSheetThumb, renderPageThumb } from './render.js';
```
```ts
// Impose a finished, self-contained subset — the first eight pages, all complete
// with furniture by now — rather than the whole document, so both the N-up sheet
// and the booklet spread are full rather than showing this still-empty page.
const subset = doc.ExtractPages([1, 2, 3, 4, 5, 6, 7, 8]);
const nup = subset.NUp(2, 2, { margin: 14, gutter: 8, drawBorder: true });
const booklet = subset.Booklet({});
addRenderShowcase(renderPage, [
  renderPageThumb(textPage, 'Rendered page — Text'),
  renderPageThumb(vectorPage, 'Rendered page — Vector'),
  imposedSheetThumb(nup, ' 4-up imposition — NUp(2×2)'),
  imposedSheetThumb(booklet, 'Booklet spread — Booklet()'),
]);
```

- [ ] **Step 3: Run and confirm four thumbnails landed**

```bash
npm run example:showcase
npx tsx -e "
import { Document } from './src/index.js';
const d = Document.OpenFile('docs/feature-showcase.pdf');
const p = d.Pages[d.Pages.length - 1];
console.log('images', p.Images.map(i => i.Width + 'x' + i.Height).join(' | '));
"
```

Expected: four PNG entries. The booklet spread is the wide one — its width should
be roughly twice its height. Open the page and confirm all four render as
recognisable miniatures of real pages, complete with the corner logo and footer.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add _examples/feature-showcase/render.ts _examples/feature-showcase/main.ts
git commit -m "feat(example): showcase rendering and imposition thumbnails"
```

---

### Task 19: verify.ts, font optimization, README, and the committed PDF

**Files:**
- Create: `_examples/feature-showcase/verify.ts`
- Modify: `_examples/feature-showcase/main.ts`
- Modify: `README.md`
- Create: `docs/feature-showcase.pdf` (committed output)

**Interfaces:**
- Consumes: `redaction.ts` (`REDACTED_VALUES`, `MARKED_VALUES`), `main.ts`'s `Section`.
- Produces: `verifySavedDocument(path: string, sections: Section[]): void` — throws on any failed check.

The three claims the document makes about itself are asserted on the **saved
bytes**, not on the in-memory model, because the in-memory model is what produced
them and would agree with itself.

- [ ] **Step 1: Write verify.ts**

```ts
import { Document } from '../../src/index.js';
import { isNamedDest } from '../../src/outline.js';
import type { OutlineItem } from '../../src/index.js';
import type { Section } from './main.js';
import { MARKED_VALUES, REDACTED_VALUES } from './redaction.js';

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`showcase verification failed: ${what}`);
  console.log(`  ok — ${what}`);
}

/** Re-open the written file and assert the three things this document claims
 *  about itself. Fails loudly, so a regression in any of them stops the build
 *  rather than producing a quietly wrong artifact. */
export function verifySavedDocument(path: string, sections: Section[]): void {
  const doc = Document.OpenFile(path);
  console.log('verifying saved document:');

  // 1. The flatten page is inert, while the AcroForm page's fields survive.
  const flatten = doc.Pages.find((p) => p.GetText().includes('Annotation Flattening'));
  check(flatten !== undefined, 'the flattening page is present');
  check(flatten!.Annotations.length === 0, 'the flattening page carries no /Annots');
  const names = doc.Form.Fields.map((f) => f.FullName);
  check(!names.includes('FlattenName') && !names.includes('FlattenCheck'),
    'the flattened fields are unwired from /AcroForm');
  check(names.includes('FullName') && names.includes('Plan'),
    'the AcroForm page\'s fields are still interactive');
  check(flatten!.GetText().includes('Alice Sample'),
    'the flattened value is baked into page content');

  // 2. Applied redactions destroyed their values; unapplied marks did not.
  const redact = doc.Pages.find((p) => p.GetText().includes('Internal memo'));
  check(redact !== undefined, 'the redaction page is present');
  const redactText = redact!.GetText();
  for (const v of REDACTED_VALUES) {
    check(!redactText.includes(v), `applied redaction destroyed ${JSON.stringify(v)}`);
  }
  for (const v of MARKED_VALUES) {
    check(redactText.includes(v), `unapplied mark preserved ${JSON.stringify(v)}`);
  }
  check(redact!.Annotations.filter((a) => a.Subtype === 'Redact').length === 2,
    'two /Redact marks survive unapplied');

  // 3. Every navigation target resolves.
  const pageCount = doc.Pages.length;
  const destNames = new Set(doc.GetNamedDestinations().map((d) => d.name));
  for (const s of sections) {
    check(destNames.has(s.dest), `named destination ${s.dest} exists`);
  }
  for (const { name, dest } of doc.GetNamedDestinations()) {
    check(dest.page >= 1 && dest.page <= pageCount,
      `named destination ${name} targets a page in range`);
  }
  const walk = (items: OutlineItem[]): void => {
    for (const it of items) {
      if (it.Dest && isNamedDest(it.Dest)) {
        check(destNames.has(it.Dest.name),
          `outline "${it.Title}" names an existing destination`);
      }
      if (it.Children) walk(it.Children);
    }
  };
  walk(doc.GetOutlines());

  console.log('all checks passed');
}
```

- [ ] **Step 2: Add font optimization and the verify call to main.ts**

Font optimization runs **after** all text is added and **before** the save: it
drops glyphs nothing draws, so text added afterwards could reference one that is
gone. Replace the `doc.WriteTo(OUTPUT_PATH);` line and what follows with:

```ts
import { verifySavedDocument } from './verify.js';
```
```ts
// Shrink the embedded DejaVu Sans to just the glyphs this document draws.
// Lossless-only: the three default passes minus the ones that would change
// bytes for reasons unrelated to fonts.
const report = doc.Optimize({ fonts: true, dedup: false, compress: false, dr: false });
for (const f of report.fonts) {
  console.log(`subset font: ${f.before} -> ${f.after} bytes`);
}

doc.WriteTo(OUTPUT_PATH);
console.log(`wrote ${OUTPUT_PATH} (${doc.Pages.length} pages)`);

verifySavedDocument(OUTPUT_PATH, sections);
```

If `OptimizeReport`'s per-font entry does not spell its fields `before`/`after`,
read `src/optimize.ts`'s `FontOptimization` and adjust that one log line.

- [ ] **Step 3: Run the whole thing**

Run: `npm run example:showcase`
Expected: the subset log line showing a large reduction (DejaVu Sans is ~760 KB
whole), `wrote docs/feature-showcase.pdf (…)`, then `verifying saved document:`
followed by a run of `ok —` lines and `all checks passed`. Exit 0.

- [ ] **Step 4: Prove the verification is load-bearing**

In `redaction.ts`, temporarily move the `page.ApplyRedactions();` call to the very
end of the function (after the phase-2 marks are added). Re-run
`npm run example:showcase`. Expected: it FAILS with
`showcase verification failed: unapplied mark preserved "026009593"` — because all
four marks were applied. Restore the correct order and re-run to green. This is
the repo's rule: break the path an assertion covers and confirm it goes red.

- [ ] **Step 5: Document it in README.md**

In the `## Development` section, after the code fence, add:

```markdown
The [feature showcase](docs/feature-showcase.pdf) is a single generated document
that exercises every major capability in one narrative — text and embedded fonts,
images, AcroForm fields, annotations, redaction, tables, vector graphics, flow
layout, rendering and imposition. Regenerate it with:

```bash
npm run example:showcase     # _examples/feature-showcase -> docs/feature-showcase.pdf
```

The script re-opens what it wrote and asserts the claims the document makes about
itself, so a regression fails the run rather than producing a quietly wrong PDF.
```

- [ ] **Step 6: Typecheck, run the full suite, and commit everything**

```bash
npm run typecheck
npm test
git add _examples/feature-showcase/verify.ts _examples/feature-showcase/main.ts \
        README.md docs/feature-showcase.pdf
git commit -m "feat(example): verify the saved showcase, subset fonts, document it

Re-opens the written PDF and asserts the three claims the document makes:
the flattening page is inert while the AcroForm page stays interactive,
applied redactions destroyed their values while unapplied marks preserved
theirs, and every named destination and outline target resolves."
```

---

## Notes for the implementer

**When a signature does not match.** This plan was written against the API as it
stands at commit `d532bec`. Three places flag a field name to confirm before
running (`AttachmentOptions.description` in Task 8, `FontOptimization`'s field
names in Task 19). If any other call does not typecheck, read the type in `src/`
and adjust the call — do not work around it by casting to `any`.

**Ordering is the one thing that cannot be rearranged.** `main.ts`'s final shape is:

1. scaffold pages
2. body sections — cover, text, image, forms, annotations, redaction, bill
3. sales report (its continuation pages must land before the later allocations)
4. landscape, vector, flatten
5. flow (appends its own pages)
6. allocate the render page
7. named destinations
8. **page labels** — before the TOC
9. TOC, then outlines
10. furniture — logo stamp, watermark
11. footer on every page
12. render page — imposition and thumbnails of the now-finished pages
13. metadata + XMP
14. font optimization
15. save, then verify

**The Go source is the content authority.** Where this plan says "copy verbatim
from `.reference/main.go:N-M`", read those lines — the prose, menu items, colour
values and quotes are data, and retyping them from memory introduces errors the
verification cannot catch.
