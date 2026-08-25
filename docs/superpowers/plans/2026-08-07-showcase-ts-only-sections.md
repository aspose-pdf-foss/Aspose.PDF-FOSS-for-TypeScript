# Feature Showcase — TypeScript-only sections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six sections to `_examples/feature-showcase/` covering barcodes, optional-content layers, tagged PDF, HTML export, standards validation and digital signatures, plus the sibling artifacts the last three produce.

**Architecture:** One module per section, each exporting a single `addXxx(...)` taking the `Page` it fills (and the `Document` where it needs one) — the convention every existing section already follows. Two sections are self-contained and fill early; four report on the finished document and fill late, after a single whole-document `AutoTag` pass. Signing runs last of all, on the saved file, because it appends incrementally.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), `tsx` to run, zero runtime dependencies (`node:` built-ins only).

**Spec:** [`docs/superpowers/specs/2026-08-07-showcase-ts-only-sections-design.md`](../specs/2026-08-07-showcase-ts-only-sections-design.md)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension, e.g. `import { Page } from '../../src/index.js'`.
- **No new binary assets.** Every new section draws from code or reuses files already in `_examples/feature-showcase/assets/`.
- **No checked-in secrets.** Signing credentials are minted at run time, every run.
- **Gates, both must be green before any task is closed:**
  - `npm run typecheck` — `_examples` is in the tsconfig `include`, so this really does gate the new modules.
  - `npm run example:showcase` — must exit 0 with `verify.ts` printing `all checks passed`.
- **Committed artifact:** `docs/feature-showcase.pdf` only. `feature-showcase.html`, `feature-showcase-fixed.html`, `feature-showcase-pdfa.pdf` and `feature-showcase-signed.pdf` are build products and go in `.gitignore`.
- **Issue tracking:** this project uses `bd` (beads). Do NOT use TodoWrite or markdown TODO lists. File follow-up work with `bd`.
- **Commit trailer:** end every commit message with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `_examples/feature-showcase/barcodes.ts` | the barcode card grid — no document interaction |
| `_examples/feature-showcase/layers.ts` | the OCG schematic, its layers and their default states |
| `_examples/feature-showcase/tagged.ts` | the `AutoTag` pass, the report page, the hand-tag helper |
| `_examples/feature-showcase/htmlexport.ts` | both HTML siblings and the page describing them |
| `_examples/feature-showcase/compliance.ts` | the three validators, the findings table, the PDF/A sibling |
| `_examples/feature-showcase/signcred.ts` | run-time RSA keypair + self-signed X.509, nothing else |
| `_examples/feature-showcase/signing.ts` | certify + sign the saved file, verify, report |

**Modify:**

| File | Change |
|---|---|
| `_examples/feature-showcase/theme.ts` | add `cardGrid()` |
| `_examples/feature-showcase/vector.ts` | use `cardGrid()` instead of its own inline grid |
| `_examples/feature-showcase/main.ts` | six `DEST_*`, six `Section` entries, the late-fill phase, top-level `await` |
| `_examples/feature-showcase/verify.ts` | five new assertion groups |
| `.gitignore` | the four sibling build products |
| `README.md` | the six new sections and the sibling artifacts |

**Note on testing style.** This example is not covered by vitest; `verify.ts` is its test suite, and it runs against re-opened bytes at the end of every run. So in each task the *verification assertion is written first* and observed to fail before the section that satisfies it is written. That is the TDD cycle for this codebase, and it is why `verify.ts` is touched in almost every task rather than once at the end.

---

### Task 1: Extract the card grid into `theme.ts`

`vector.ts` builds a card grid inline and carries a comment explaining a real trap: `PageGraphics` buffers until `apply()` while `addText` appends to `/Contents` immediately, so every frame must be committed before any label is drawn, or the fills paint over the labels. `apply()` is single-shot, so it cannot be done per card. Two new sections need the same grid, and the invariant is invisible in the output when only one of them gets it wrong.

**Files:**
- Modify: `_examples/feature-showcase/theme.ts` (append at end)
- Modify: `_examples/feature-showcase/vector.ts:9-57`

**Interfaces:**
- Consumes: `Box`, `addText`, `NAVY` (already in `theme.ts`)
- Produces: `cardGrid(page: Page, labels: string[], opts: CardGridOptions): Box[]` — draws every frame in one committed `PageGraphics` pass, then every label, and returns one inner content `Box` per label, in the same order. Tasks 2 and 3 rely on this exact signature.

- [ ] **Step 1: Add `cardGrid` to `theme.ts`**

Append to `_examples/feature-showcase/theme.ts`:

```ts
export interface CardGridOptions {
  cols: number;
  rows: number;
  /** Grid bounds in page space. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  gapX?: number;
  gapY?: number;
  /** Horizontal inset of the label and content from the card edge. Default 12. */
  labelInset?: number;
  /** Height of the label strip at the top of each card. Default 22. */
  labelHeight?: number;
  /** Label type size. Default 11. */
  labelSize?: number;
}

/** Draw a grid of labelled cards and return each card's inner content box.
 *
 *  The two passes are the point of this helper. `PageGraphics` buffers until
 *  `apply()` while `addText` appends to `/Contents` straight away, so every
 *  frame must be committed before any label is drawn — otherwise the fills
 *  splice in last and paint over the labels. `apply()` is single-shot, so it
 *  cannot be done per card. Three sections now depend on that ordering and it
 *  is invisible in the output when only one of them gets it wrong, which is
 *  why it lives here and not at the call sites. */
export function cardGrid(page: Page, labels: string[], opts: CardGridOptions): Box[] {
  const gapX = opts.gapX ?? 14;
  const gapY = opts.gapY ?? 14;
  const labelInset = opts.labelInset ?? 12;
  const labelHeight = opts.labelHeight ?? 22;
  const labelSize = opts.labelSize ?? 11;
  const cardW = (opts.right - opts.left - gapX * (opts.cols - 1)) / opts.cols;
  const cardH = (opts.top - opts.bottom - gapY * (opts.rows - 1)) / opts.rows;

  // Pass 1 — every frame, committed in one apply().
  const frames = page.Graphics();
  const labelBoxes: Box[] = [];
  const inners: Box[] = [];
  labels.forEach((_, i) => {
    const col = i % opts.cols;
    const row = Math.floor(i / opts.cols);
    const x = opts.left + col * (cardW + gapX);
    const y = opts.top - (row + 1) * cardH - row * gapY;
    frames.setFillColor([0.985, 0.985, 0.995])
      .setStrokeColor([0.83, 0.85, 0.92]).setLineWidth(0.5)
      .roundedRect(x, y, cardW, cardH, 6).fillStroke();
    labelBoxes.push([
      x + labelInset, y + cardH - labelHeight - 2, x + cardW - labelInset, y + cardH - 4,
    ]);
    inners.push([
      x + labelInset, y + 10, x + cardW - labelInset, y + cardH - labelHeight - 6,
    ]);
  });
  frames.apply();

  // Pass 2 — labels, on top of committed frames.
  labels.forEach((label, i) => {
    addText(page, label, labelBoxes[i], {
      font: 'Helvetica-Bold', size: labelSize, color: NAVY,
    });
  });

  return inners;
}
```

- [ ] **Step 2: Convert `vector.ts` to use it**

In `_examples/feature-showcase/vector.ts`, add `cardGrid` to the `theme.js` import, then replace everything from `const colCount = 2;` down to and including the `LABELS.forEach((label, i) => { addText(...) });` block (currently lines 9-57) with:

```ts
  const LABELS = [
    'Lines — width, dash, cap',
    'Rectangle  •  Rounded',
    'Circle  •  radial gradient',
    'Polyline',
    'Polygon',
    'Path with arc',
  ];

  const inners = cardGrid(page, LABELS, {
    cols: 2, rows: 3, left: 50, right: 545, top: 705, bottom: 105,
  });
```

Leave the rest of the function (the `midY`/`midX` helpers, `const g = page.Graphics();` and the six drawing blocks) exactly as it is — it already reads from `inners`.

- [ ] **Step 3: Verify nothing moved**

The grid arithmetic is intentionally identical, so this refactor must not change the rendered page. Capture the before/after hash of the vector page's content:

```bash
git stash && npm run example:showcase >/dev/null 2>&1 && \
  node -e "const{Document}=await import('./dist/index.js').catch(()=>import('./src/index.js'));" 2>/dev/null; \
  sha256sum docs/feature-showcase.pdf > /tmp/before.txt; git stash pop
```

Simpler and sufficient: run the example before and after and confirm the vector page still renders all six cards with their labels on top of the frames.

Run: `npm run typecheck`
Expected: PASS, no errors.

Run: `npm run example:showcase`
Expected: exit 0, ends with `all checks passed`.

Then open `docs/feature-showcase.pdf` to the Vector Graphics page and confirm six labelled cards, labels legible above their artwork.

- [ ] **Step 4: Commit**

```bash
git add _examples/feature-showcase/theme.ts _examples/feature-showcase/vector.ts
git commit -m "$(cat <<'EOF'
refactor(example): lift the card grid into theme.ts

Three sections now need the labelled-card grid, and it carries an ordering
invariant that is invisible in the output when only one of them gets it wrong:
frames must commit in their own apply() before any label is drawn, because
PageGraphics buffers while addText appends immediately.

Putting the two passes inside the helper makes it impossible to get wrong at a
call site. The grid arithmetic is unchanged, so the vector page renders
identically.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Barcodes & QR Codes

**Files:**
- Create: `_examples/feature-showcase/barcodes.ts`
- Modify: `_examples/feature-showcase/main.ts`
- Modify: `_examples/feature-showcase/verify.ts`

**Interfaces:**
- Consumes: `cardGrid` (Task 1); `page.AddBarcode(spec, rect, opts)` where `rect` is `[x, y, w, h]` and `spec` is `{ type: 'code128' | 'ean13' | 'upca' | 'ean8', data: string }` or `{ type: 'qr', data: string, ecc?: 'L'|'M'|'Q'|'H', version?: number }`.
- Produces: `addBarcodeShowcase(page: Page): void`; `DEST_BARCODE = 'section.barcode'` exported from `main.ts`.

- [ ] **Step 1: Write the failing verification**

In `_examples/feature-showcase/verify.ts`, add a fourth group at the end of `verifySavedDocument`, just before `console.log('all checks passed')`:

```ts
  // 4. The barcode page drew every symbology.
  const barcode = doc.Pages.find((p) => p.GetText().includes('Barcodes & QR Codes'));
  check(barcode !== undefined, 'the barcode page is present');
  const barcodePaths = barcode!.GetPaths();
  check(barcodePaths.length > 200,
    `the barcode page drew module geometry (${barcodePaths.length} paths)`);
  const barcodeText = barcode!.GetText();
  for (const payload of ['5901234123457', '036000291452', '96385074']) {
    check(barcodeText.includes(payload),
      `the human-readable payload ${payload} was drawn`);
  }
```

`GetPaths()` is `page.GetPaths()` from `src/paths.ts`, already public. A vector barcode paints one filled rectangle per dark module, so a page carrying eight symbologies is comfortably over 200 paths; the threshold is a floor, not a fit.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run example:showcase`
Expected: FAIL — `Error: showcase verification failed: the barcode page is present`

- [ ] **Step 3: Write `barcodes.ts`**

Create `_examples/feature-showcase/barcodes.ts`:

```ts
import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, cardGrid, sectionHeader, MUTED } from './theme.js';

/** [x, y, w, h] for a barcode inset into a card's inner box, leaving room for
 *  a one-line caption under it. */
function slot(inner: Box, captionHeight: number): [number, number, number, number] {
  return [inner[0], inner[1] + captionHeight, inner[2] - inner[0], inner[3] - inner[1] - captionHeight];
}

/** A one-line caption pinned to the bottom of a card's inner box. */
function caption(page: Page, inner: Box, text: string): void {
  addText(page, text, [inner[0], inner[1], inner[2], inner[1] + 12], {
    size: 8, color: MUTED, align: 'center',
  });
}

export function addBarcodeShowcase(page: Page): void {
  sectionHeader(page, 'Barcodes & QR Codes',
    'Code 128  •  EAN-13  •  UPC-A  •  EAN-8  •  QR (ECC L / H)  •  vector vs raster stencil');

  const LABELS = [
    'Code 128 — alphanumeric',
    'EAN-13 — retail',
    'UPC-A — North America',
    'EAN-8 — short retail',
    'QR — ECC level L',
    'QR — ECC level H',
    'QR — raster stencil',
    'Code 128 — colour, no quiet zone',
  ];

  const inners = cardGrid(page, LABELS, {
    cols: 2, rows: 4, left: 50, right: 545, top: 705, bottom: 105,
  });

  // The check-digit symbologies get known-valid payloads: these are the
  // canonical published examples, so a check-digit regression shows up as a
  // thrown error rather than a subtly wrong symbol.
  page.AddBarcode({ type: 'code128', data: 'ASPOSE-PDF-FOSS-TS' },
    slot(inners[0], 14), { text: true });
  caption(page, inners[0], 'variable length, three code sets');

  page.AddBarcode({ type: 'ean13', data: '5901234123457' }, slot(inners[1], 14));
  caption(page, inners[1], 'check digit 7, computed and verified');

  page.AddBarcode({ type: 'upca', data: '036000291452' }, slot(inners[2], 14));
  caption(page, inners[2], '12 digits, EAN-13 with a leading zero');

  page.AddBarcode({ type: 'ean8', data: '96385074' }, slot(inners[3], 14));
  caption(page, inners[3], '8 digits for small packaging');

  // The same payload at two error-correction levels: ECC H reserves ~30% of
  // the codewords for recovery, so it needs a larger symbol for identical data.
  const QR_PAYLOAD = 'https://github.com/aspose-pdf-foss';
  page.AddBarcode({ type: 'qr', data: QR_PAYLOAD, ecc: 'L' }, slot(inners[4], 14));
  caption(page, inners[4], '~7% recovery — smallest symbol');

  page.AddBarcode({ type: 'qr', data: QR_PAYLOAD, ecc: 'H' }, slot(inners[5], 14));
  caption(page, inners[5], '~30% recovery — same payload, larger symbol');

  page.AddBarcode({ type: 'qr', data: QR_PAYLOAD, ecc: 'L' },
    slot(inners[6], 14), { render: 'raster' });
  caption(page, inners[6], 'one 1-bit /ImageMask, not one rect per module');

  page.AddBarcode({ type: 'code128', data: 'NO-QUIET-ZONE' },
    slot(inners[7], 14), { color: [0.15, 0.20, 0.55], quietZone: false, text: true });
  caption(page, inners[7], 'scanners need the quiet zone — off for contrast only');
}
```

- [ ] **Step 4: Wire it into `main.ts`**

Three edits to `_examples/feature-showcase/main.ts`:

1. Add the import beside the other section imports:

```ts
import { addBarcodeShowcase } from './barcodes.js';
```

2. Add the destination constant beside the others:

```ts
export const DEST_BARCODE = 'section.barcode';
```

3. Allocate and fill the page immediately after the `renderPage` allocation (`const renderPage = doc.AddPage(PageFormat.A4).page;`), and add its `Section` entry as the last element of the `sections` array:

```ts
const barcodePage = doc.AddPage(PageFormat.A4).page;
addBarcodeShowcase(barcodePage);
```

```ts
  { dest: DEST_BARCODE, title: 'Barcodes & QR Codes', subtype: 'barcode', page: barcodePage },
```

The barcode page fills here — early, with the other body sections — deliberately: it is self-contained, and filling it before the tagging pass in Task 4 is what lets `AutoTag` cover it like any other page.

- [ ] **Step 5: Run and verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run example:showcase`
Expected: exit 0, `all checks passed`, and the four new barcode checks printed as `ok — …`.

Open `docs/feature-showcase.pdf` to the new page: eight cards, each with a scannable symbol. Scan the EAN-13 with a phone to confirm it reads `5901234123457`.

- [ ] **Step 6: Commit**

```bash
git add _examples/feature-showcase/barcodes.ts _examples/feature-showcase/main.ts _examples/feature-showcase/verify.ts
git commit -m "$(cat <<'EOF'
feat(example): showcase barcode and QR generation

Eight symbologies through page.AddBarcode: Code 128, EAN-13, UPC-A, EAN-8, QR
at two error-correction levels, the raster /ImageMask stencil beside its vector
twin, and a coloured quiet-zone-off variant.

The check-digit payloads are the canonical published examples, so a check-digit
regression throws rather than drawing a subtly wrong symbol. verify.ts asserts
the module geometry and the human-readable payloads on re-opened bytes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Optional-Content Layers

**Files:**
- Create: `_examples/feature-showcase/layers.ts`
- Modify: `_examples/feature-showcase/main.ts`
- Modify: `_examples/feature-showcase/verify.ts`

**Interfaces:**
- Consumes: `doc.OptionalContent` → `OptionalContent`, with `AddLayer(name, { parent?, visible? }): Layer`, `Layers: Layer[]`, `Default: LayerConfig`; `LayerConfig.IsVisible(layer): boolean`; `PageGraphics.BeginLayer(layer)` / `.EndLayer()`; `page.AddImage(bytes, [x,y,w,h], { layer })`; `page.AddBarcode(spec, rect, { layer })`.
- Produces: `addLayerShowcase(doc: Document, page: Page): void`; `DEST_LAYERS = 'section.layers'` exported from `main.ts`.

- [ ] **Step 1: Write the failing verification**

Append a fifth group in `verify.ts`, before the final `console.log`:

```ts
  // 5. Optional content: the layers, the nesting, and the default-off one.
  const oc = doc.OptionalContent;
  const layerNames = oc.Layers.map((l) => l.Name);
  for (const want of ['Walls', 'Furniture', 'Seating', 'Grid', 'Branding', 'Asset Tag']) {
    check(layerNames.includes(want), `layer "${want}" survives the save`);
  }
  const grid = oc.GetLayer('Grid');
  check(grid !== undefined && !oc.Default.IsVisible(grid),
    'the Grid layer is default-off in the /D config');
  const walls = oc.GetLayer('Walls');
  check(walls !== undefined && oc.Default.IsVisible(walls),
    'the Walls layer is default-on');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run example:showcase`
Expected: FAIL — `Error: showcase verification failed: layer "Walls" survives the save`

- [ ] **Step 3: Write `layers.ts`**

Create `_examples/feature-showcase/layers.ts`:

```ts
import type { Document, Page } from '../../src/index.js';
import { addText, sectionHeader, INK, MUTED, NAVY } from './theme.js';
import { asposeLogoPng } from './assets.js';

/** A floor plan drawn across five optional-content groups, one nested.
 *
 *  Only three kinds of content can bind to a layer: a PageGraphics sequence
 *  between BeginLayer/EndLayer, an image XObject via AddImage({ layer }), and a
 *  barcode via AddBarcode({ layer }). Text stamping (AddText / AddTextBlock)
 *  takes no layer option, so the legend below is base content and stays visible
 *  whatever the viewer toggles. That is a real limit of the API, noted here
 *  rather than papered over. */
export function addLayerShowcase(doc: Document, page: Page): void {
  sectionHeader(page, 'Optional-Content Layers',
    'OCGs  •  nested /D /Order  •  a default-off layer  •  layered images and barcodes');

  const oc = doc.OptionalContent;
  const walls = oc.AddLayer('Walls');
  const furniture = oc.AddLayer('Furniture');
  const seating = oc.AddLayer('Seating', { parent: furniture });
  const grid = oc.AddLayer('Grid', { visible: false });
  const branding = oc.AddLayer('Branding');
  const assetTag = oc.AddLayer('Asset Tag');

  // Plan bounds.
  const x0 = 80, y0 = 300, x1 = 515, y1 = 640;
  const g = page.Graphics();

  // --- Grid (default off): a dashed 40pt measurement grid ------------------
  g.BeginLayer(grid);
  g.save().setStrokeColor([0.72, 0.76, 0.88]).setLineWidth(0.4).setDash([3, 3]);
  for (let x = x0; x <= x1; x += 40) g.drawLine(x, y0, x, y1);
  for (let y = y0; y <= y1; y += 40) g.drawLine(x0, y, x1, y);
  g.stroke().restore();
  g.EndLayer();

  // --- Walls: the outer shell plus one interior partition ------------------
  g.BeginLayer(walls);
  g.save().setStrokeColor(NAVY).setLineWidth(3).setLineJoin(0)
    .rect(x0, y0, x1 - x0, y1 - y0).stroke().restore();
  g.save().setStrokeColor(NAVY).setLineWidth(3)
    .drawLine(x0 + 250, y0, x0 + 250, y1 - 90).stroke().restore();
  // A door gap, drawn as a quarter-circle swing.
  g.save().setStrokeColor([0.55, 0.60, 0.75]).setLineWidth(1).setDash([4, 3])
    .moveTo(x0 + 250, y1 - 90).arc(x0 + 250, y1 - 90, 46, 0, Math.PI / 2)
    .stroke().restore();
  g.EndLayer();

  // --- Furniture: desks in the left room -----------------------------------
  g.BeginLayer(furniture);
  g.save().setFillColor([0.88, 0.91, 0.98]).setStrokeColor([0.45, 0.52, 0.75]).setLineWidth(1);
  g.rect(x0 + 30, y1 - 90, 90, 50).fillStroke();
  g.rect(x0 + 140, y1 - 90, 90, 50).fillStroke();
  g.rect(x0 + 30, y0 + 40, 200, 55).fillStroke();
  g.restore();
  g.EndLayer();

  // --- Seating (nested under Furniture): chairs beside each desk -----------
  g.BeginLayer(seating);
  g.save().setFillColor([1.0, 0.90, 0.76]).setStrokeColor([0.80, 0.55, 0.20]).setLineWidth(1);
  for (const [cx, cy] of [[x0 + 75, y1 - 115], [x0 + 185, y1 - 115],
    [x0 + 80, y0 + 20], [x0 + 180, y0 + 20]] as Array<[number, number]>) {
    g.circle(cx, cy, 13).fillStroke();
  }
  g.restore();
  g.EndLayer();

  g.apply();

  // --- Branding: an image XObject bound to a layer via /OC -----------------
  page.AddImage(asposeLogoPng(), [x0 + 290, y1 - 90, 110, 34], { layer: branding });

  // --- Asset Tag: a barcode bound to a layer -------------------------------
  page.AddBarcode({ type: 'code128', data: 'ROOM-204' },
    [x0 + 290, y0 + 40, 130, 44], { layer: assetTag, text: true });

  // --- Legend (base content — see the note on the function above) ----------
  addText(page, 'Layers in this drawing', [80, 262, 320, 278],
    { font: 'Helvetica-Bold', size: 12, color: NAVY });

  const rows: Array<[string, string]> = [
    ['Walls', 'on — outer shell, partition, door swing'],
    ['Furniture', 'on — desks'],
    ['Furniture › Seating', 'on — nested under Furniture in /D /Order'],
    ['Grid', 'OFF — switch it on in the layers panel'],
    ['Branding', 'on — an image XObject bound via /OC'],
    ['Asset Tag', 'on — a barcode bound via /OC'],
  ];
  rows.forEach(([name, note], i) => {
    const y = 246 - i * 15;
    addText(page, name, [80, y, 210, y + 12], { size: 9.5, color: INK });
    addText(page, note, [216, y, 545, y + 12], { size: 9.5, color: MUTED });
  });

  addText(page,
    'Text stamping takes no layer option — only PageGraphics sequences, image '
    + 'XObjects and barcodes bind to an optional-content group. This legend is '
    + 'therefore base content and stays visible whatever you toggle.',
    [80, 120, 545, 152],
    { size: 8.5, color: MUTED, lineSpacing: 1.35 });
}
```

- [ ] **Step 4: Wire it into `main.ts`**

1. Import:

```ts
import { addLayerShowcase } from './layers.js';
```

2. Destination constant:

```ts
export const DEST_LAYERS = 'section.layers';
```

3. Allocate and fill immediately after the barcode page from Task 2, and add the `Section` entry after the barcode entry:

```ts
const layersPage = doc.AddPage(PageFormat.A4).page;
addLayerShowcase(doc, layersPage);
```

```ts
  { dest: DEST_LAYERS, title: 'Optional-Content Layers', subtype: 'layers', page: layersPage },
```

- [ ] **Step 5: Run and verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run example:showcase`
Expected: exit 0, `all checks passed`, with the eight new layer checks printed.

Open the PDF to the new page in a viewer with a layers panel (Acrobat Reader, or Firefox's built-in viewer). Confirm: the layers panel lists Walls, Furniture (with Seating nested under it), Grid, Branding and Asset Tag; Grid starts unchecked; checking it reveals the dashed grid; unchecking Furniture hides the desks but leaves the chairs, and unchecking Seating hides the chairs.

- [ ] **Step 6: Commit**

```bash
git add _examples/feature-showcase/layers.ts _examples/feature-showcase/main.ts _examples/feature-showcase/verify.ts
git commit -m "$(cat <<'EOF'
feat(example): showcase optional-content layers

A floor plan across five OCGs, one nested under another in /D /Order and one
created default-off so the viewer's layers panel has something to switch on.
Covers all three binding paths: PageGraphics BeginLayer sequences, an image
XObject via AddImage({ layer }), and a barcode via AddBarcode({ layer }).

Text stamping takes no layer option, so the legend is base content. That limit
is documented on the function and stated on the page itself rather than hidden.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Tagged PDF — the `AutoTag` pass and the late-fill phase

This task restructures the tail of `main.ts`. It is the load-bearing task: Tasks 5, 6 and 7 slot their sections into the late-fill phase it establishes.

Two ordering constraints, both from the spec:

- **`Optimize()` must run before tagging.** Its dedup pass merges byte-identical streams; run after MCIDs are embedded it can fuse two pages' content streams, and the `/ParentTree` then maps one page's MCIDs onto another's content.
- **`AutoTag` appends, it does not replace.** `CreateStructTree()` returns the existing root rather than clearing it, and `autoTag` re-walks every text block on every page. So there is exactly one `AutoTag` call, over the whole document, and hand-tagging happens only *after* it, on pages filled after it ran.

**Files:**
- Create: `_examples/feature-showcase/tagged.ts`
- Modify: `_examples/feature-showcase/main.ts`
- Modify: `_examples/feature-showcase/verify.ts`

**Interfaces:**
- Consumes: `doc.AutoTag(opts): AutoTagReport` where `AutoTagReport` is `{ headings: number; paragraphs: number; figures: number; artifacts: number; tables: number }` and `opts.alt` is `(image: ImageEvent) => string | undefined`; `doc.GetStructTree(): StructTreeRoot | null`; `StructTreeRoot.Append(type, opts?): StructElement`; `StructTreeRoot.Children: StructElement[]`; `StructElement.Append(type, opts?)`, `.MarkContent(page, region): number`, `.Type: string`, `.Children: StructElement[]`; `page.GetStructuredText(): TextBlock[]` where `TextBlock` is `{ text: string; quad: [number,number,number,number]; lines: TextLine[] }`.
- Produces:
  - `runAutoTag(doc: Document): AutoTagReport`
  - `addTaggedShowcase(doc: Document, page: Page, report: AutoTagReport): void`
  - `handTagPage(doc: Document, page: Page, heading: string): void` — Tasks 5, 6 and 7 call this on their own pages.
  - `DEST_TAGGED = 'section.tagged'` exported from `main.ts`.

- [ ] **Step 1: Write the failing verification**

Append a sixth group in `verify.ts`:

```ts
  // 6. The document is tagged, and the late-filled pages were hand-tagged.
  const tree = doc.GetStructTree();
  check(tree !== null, 'the saved document carries a /StructTreeRoot');
  check(doc.IsTagged, 'the catalog declares /MarkInfo /Marked true');
  check(doc.Lang === 'en-US', "the document /Lang is 'en-US'");
  check(tree!.Children.length > 20,
    `the structure tree has top-level elements (${tree!.Children.length})`);
  const types = new Set(tree!.Children.map((c) => c.Type));
  check(types.has('P'), 'the tree contains paragraphs');
  check([...types].some((t) => /^H[1-6]$/.test(t)), 'the tree contains headings');
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run example:showcase`
Expected: FAIL — `Error: showcase verification failed: the saved document carries a /StructTreeRoot`

- [ ] **Step 3: Write `tagged.ts`**

Create `_examples/feature-showcase/tagged.ts`:

```ts
import type { Document, Page } from '../../src/index.js';
import type { AutoTagReport, StructElement } from '../../src/index.js';
import type { ImageEvent } from '../../src/index.js';
import { addText, cardGrid, sectionHeader, INK, MUTED, NAVY } from './theme.js';
import { DOC_TITLE } from './theme.js';

/** Alt text for a page-level image, or undefined to mark it an /Artifact.
 *
 *  ImageEvent carries geometry, not identity — no page, no XObject name — so
 *  the decision has to come from the quad. The rule: anything under 40pt on
 *  its long edge is decoration at this document's scale and becomes an
 *  /Artifact; everything larger is real content and becomes a /Figure with
 *  /Alt. Both branches are honest, and the section page reports the real
 *  counts rather than asserting a split that did not happen. */
function altForImage(image: ImageEvent): string | undefined {
  const [x0, y0, x1, y1] = image.quad;
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  if (Math.max(w, h) < 40) return undefined; // decoration -> /Artifact
  return `Showcase illustration, ${Math.round(w)} by ${Math.round(h)} points`;
}

/** The single whole-document tagging pass.
 *
 *  Exactly one AutoTag call, because autoTag *appends* into whatever tree
 *  already exists (CreateStructTree returns the existing root rather than
 *  clearing it) and re-walks every text block on every page. A second call, or
 *  hand-tagging before this one, double-tags the same content.
 *
 *  { title } also sets /ViewerPreferences /DisplayDocTitle: a title alone does
 *  not satisfy PDF/UA unless the viewer is told to show it. */
export function runAutoTag(doc: Document): AutoTagReport {
  return doc.AutoTag({ lang: 'en-US', title: DOC_TITLE, alt: altForImage, tables: true });
}

/** Tag one page that was filled *after* runAutoTag, so it is not left as
 *  untagged content. The first text block matching `heading` becomes an H2 and
 *  every other block a P. Safe to call only post-AutoTag — calling it before
 *  would duplicate what the pass then adds. */
export function handTagPage(doc: Document, page: Page, heading: string): void {
  const root = doc.GetStructTree();
  if (!root) throw new Error('handTagPage: the document is not tagged yet');
  for (const block of page.GetStructuredText()) {
    const text = block.text.trim();
    if (text.length === 0) continue;
    const el = root.Append(text.startsWith(heading) ? 'H2' : 'P');
    el.MarkContent(page, block.quad);
  }
}

/** Render `element` and its descendants as an indented outline, depth-first,
 *  stopping at `maxLines` so a 300-element tree does not overrun the card. */
function outlineTree(children: StructElement[], maxLines: number): string[] {
  const lines: string[] = [];
  const walk = (els: StructElement[], depth: number): void => {
    for (const el of els) {
      if (lines.length >= maxLines) return;
      const title = el.Title ?? el.Alt;
      const suffix = title ? `  — ${title.slice(0, 34)}` : '';
      lines.push(`${'  '.repeat(depth)}/${el.Type}${suffix}`);
      walk(el.Children, depth + 1);
    }
  };
  walk(children, 0);
  return lines;
}

export function addTaggedShowcase(doc: Document, page: Page, report: AutoTagReport): void {
  sectionHeader(page, 'Tagged PDF & Logical Structure',
    'AutoTag over the whole document  •  /Figure vs /Artifact  •  hand-authored elements');

  const root = doc.GetStructTree();
  const total = report.headings + report.paragraphs + report.figures
    + report.artifacts + report.tables;

  addText(page,
    'One AutoTag pass ran over every page of this document after its content was '
    + 'final. It derives headings from font-size ranks, paragraphs from text '
    + 'blocks, tables from ruling geometry, and decides per image whether to emit '
    + 'a /Figure with /Alt or an /Artifact. The counts below are what it actually '
    + 'produced on this run.',
    [50, 640, 545, 700], { size: 10, color: INK, lineSpacing: 1.35 });

  const LABELS = [
    'AutoTag — what it produced',
    'Structure tree — first elements',
    'Images — /Figure vs /Artifact',
    'Hand-authored elements',
  ];
  const inners = cardGrid(page, LABELS, {
    cols: 2, rows: 2, left: 50, right: 545, top: 620, bottom: 150,
  });

  // Card 1 — the report counts.
  const counts: Array<[string, number]> = [
    ['Headings (/H1../H6)', report.headings],
    ['Paragraphs (/P)', report.paragraphs],
    ['Tables (/Table)', report.tables],
    ['Figures (/Figure)', report.figures],
    ['Artifacts', report.artifacts],
    ['Total elements', total],
  ];
  counts.forEach(([label, n], i) => {
    const y = inners[0][3] - 16 - i * 15;
    addText(page, label, [inners[0][0], y, inners[0][2] - 46, y + 12],
      { size: 9.5, color: INK });
    addText(page, String(n), [inners[0][2] - 44, y, inners[0][2], y + 12],
      { size: 9.5, color: NAVY, align: 'right', font: 'Helvetica-Bold' });
  });

  // Card 2 — an excerpt of the real tree.
  const lines = root ? outlineTree(root.Children, 12) : ['(no structure tree)'];
  lines.forEach((line, i) => {
    const y = inners[1][3] - 14 - i * 11;
    addText(page, line, [inners[1][0], y, inners[1][2], y + 10],
      { size: 7.5, color: MUTED });
  });

  // Card 3 — the alt-text rule.
  addText(page,
    'ImageEvent carries geometry, not identity — no page, no XObject name — so '
    + 'the alt callback decides from the quad. Anything under 40pt on its long '
    + 'edge is decoration at this scale and becomes an /Artifact; larger images '
    + 'become a /Figure carrying /Alt. '
    + `This run: ${report.figures} figure(s), ${report.artifacts} artifact(s).`,
    [inners[2][0], inners[2][1], inners[2][2], inners[2][3] - 4],
    { size: 8.5, color: INK, lineSpacing: 1.3 });

  // Card 4 — why hand-tagging exists here at all.
  addText(page,
    'This page, and the three that follow it, are filled after the AutoTag pass '
    + '— they report on the finished document, so they cannot exist before it. '
    + 'They are tagged by hand instead, through StructTreeRoot.Append plus '
    + 'StructElement.MarkContent. That is the authoring API beside the heuristic '
    + 'one, and it cannot double-tag: AutoTag has already run and does not run '
    + 'again.',
    [inners[3][0], inners[3][1], inners[3][2], inners[3][3] - 4],
    { size: 8.5, color: INK, lineSpacing: 1.3 });

  addText(page,
    'AutoTag({ title }) also sets /ViewerPreferences /DisplayDocTitle — a title '
    + 'alone does not satisfy PDF/UA unless the viewer is told to show it. The '
    + 'validation section that follows reports the result.',
    [50, 112, 545, 140], { size: 8.5, color: MUTED, lineSpacing: 1.35 });
}
```

- [ ] **Step 4: Restructure the tail of `main.ts`**

1. Add the imports:

```ts
import { addTaggedShowcase, handTagPage, runAutoTag } from './tagged.js';
```

2. Add the destination constant:

```ts
export const DEST_TAGGED = 'section.tagged';
```

3. Allocate the tagged page **without filling it**, immediately after the `layersPage` block from Task 3, and add its `Section` entry last:

```ts
// Filled in the late phase: this page reports on the finished document, so it
// cannot be written until the document is finished.
const taggedPage = doc.AddPage(PageFormat.A4).page;
```

```ts
  { dest: DEST_TAGGED, title: 'Tagged PDF & Logical Structure', subtype: 'tagged', page: taggedPage },
```

4. Replace the whole block from the `// --- Optimize ---` comment down to (but not including) `doc.WriteTo(OUTPUT_PATH);` with:

```ts
// --- Optimize -------------------------------------------------------------
// The Go original calls SubsetFonts() here. It has no counterpart: a font added
// with AddFontFile is subset and embedded at Save automatically, covering only
// the glyphs actually drawn, so DejaVu Sans lands at ~12 KB rather than 739 KB
// with no explicit step. Optimize's font pass targets fonts read from an opened
// document and therefore reports nothing for this one — the dedup and
// recompress passes still earn their keep.
//
// This MUST run before the tagging pass below. Optimize's dedup pass merges
// byte-identical streams; run after MCIDs are embedded it can fuse two pages'
// content streams, and the /ParentTree then maps one page's MCIDs onto
// another's content.
const report = doc.Optimize({ fonts: true, dedup: true, compress: true, dr: false });
console.log(`optimize: ${report.fonts.length} font program(s) shrunk, `
  + `${report.dedup.merged} duplicate stream(s) merged, `
  + `${report.compress.streams} recompressed, `
  + `${(report.bytesSaved / 1024).toFixed(1)} KB saved`);

// --- Tag the whole document -----------------------------------------------
// Exactly one pass, over finished content. AutoTag appends into whatever tree
// exists and re-walks every text block, so a second call — or any hand-tagging
// before this point — would double-tag the same content.
const tagReport = runAutoTag(doc);
console.log(`autotag: ${tagReport.headings} heading(s), ${tagReport.paragraphs} paragraph(s), `
  + `${tagReport.tables} table(s), ${tagReport.figures} figure(s), `
  + `${tagReport.artifacts} artifact(s)`);

// --- Late phase: the pages that report on the finished document ------------
// Filled after tagging because they describe its result, then hand-tagged so
// they are not left as untagged content.
addTaggedShowcase(doc, taggedPage, tagReport);
addUnifiedFooter(taggedPage, taggedPage.Number, doc.Pages.length);
handTagPage(doc, taggedPage, 'Tagged PDF');

doc.WriteTo(OUTPUT_PATH);
```

Note the footer: `addUnifiedFooter` already ran over every page earlier in the file, but the late pages get their content after that, so each needs its own call. The page count is stable by now — no pages are added after the render section.

- [ ] **Step 5: Run and verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run example:showcase`
Expected: exit 0, an `autotag: …` line with non-zero counts, `all checks passed`, and the six new structure checks printed.

Open the PDF and confirm the Tagged PDF page shows four cards with real numbers in card 1 and a real indented tree in card 2 — not zeros and not an empty list.

- [ ] **Step 6: Commit**

```bash
git add _examples/feature-showcase/tagged.ts _examples/feature-showcase/main.ts _examples/feature-showcase/verify.ts
git commit -m "$(cat <<'EOF'
feat(example): tag the showcase and report what AutoTag produced

One AutoTag pass over the finished document, then a section page reporting its
real counts and an excerpt of the tree it built.

Two orderings are load-bearing and documented at the call site. Optimize now
runs before tagging: its dedup pass merges byte-identical streams, which would
fuse two pages' content once MCIDs are embedded and leave the /ParentTree
mapping one page's MCIDs onto another's. And there is exactly one AutoTag call,
because autoTag appends into the existing tree and re-walks every text block —
hand-tagging first would double-tag everything.

The section page is filled after the pass, since it reports on it, so it is
hand-tagged through Append + MarkContent. That establishes the late-fill phase
the validation, HTML and signing sections slot into.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: PDF/A · PDF/X · PDF/UA validation

**Files:**
- Create: `_examples/feature-showcase/compliance.ts`
- Modify: `_examples/feature-showcase/main.ts`
- Modify: `_examples/feature-showcase/verify.ts`

**Interfaces:**
- Consumes: `doc.ValidatePdfA(level: PdfALevel)`, `doc.ValidatePdfX(level: PdfXLevel)`, `doc.ValidatePdfUa()` — all returning `ValidationReport` with `Issues: ValidationIssue[]`, `Errors`, `Warnings`, `Passed`; `ValidationIssue` is `{ rule: string; severity: 'error'|'warning'; message: string; clause?: string; … }`. `doc.ConvertToPdfA(level, opts?)` returns `ConversionReport` = `{ applied: ConvertAction[]; unresolved: ValidationIssue[]; passed: boolean }`, `ConvertAction` = `{ rule: string; action: string; … }`. `createTable(defaults)` / `page.AddTable(table, x, top, opts)` as used in `sales.ts`.
- Produces: `addComplianceShowcase(doc: Document, page: Page): void`; `DEST_COMPLIANCE = 'section.compliance'` exported from `main.ts`.

- [ ] **Step 1: Write the failing verification**

Append a seventh group in `verify.ts`:

```ts
  // 7. The compliance page reports real validator findings.
  const compliance = doc.Pages.find((p) => p.GetText().includes('Standards Validation'));
  check(compliance !== undefined, 'the compliance page is present');
  const complianceText = compliance!.GetText();
  check(complianceText.includes('FontEmbedded'),
    'the PDF/A findings name the unembedded Standard-14 faces');
  check(existsSync('docs/feature-showcase-pdfa.pdf'),
    'the PDF/A conversion sibling was written');
```

Add `import { existsSync } from 'node:fs';` at the top of `verify.ts`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run example:showcase`
Expected: FAIL — `Error: showcase verification failed: the compliance page is present`

- [ ] **Step 3: Write `compliance.ts`**

Create `_examples/feature-showcase/compliance.ts`:

```ts
import { writeFileSync } from 'node:fs';
import type { Document, Page, ValidationReport } from '../../src/index.js';
import { createTable } from '../../src/index.js';
import { addText, pageHeight, pageWidth, sectionHeader, DEEP_NAVY, GREEN, INK, MUTED, NAVY } from './theme.js';

const PDFA_PATH = 'docs/feature-showcase-pdfa.pdf';

/** Rule id -> how many issues carry it, and at what severity. */
interface RuleCount { rule: string; severity: string; count: number; clause: string }

function summarize(report: ValidationReport): RuleCount[] {
  const by = new Map<string, RuleCount>();
  for (const issue of report.Issues) {
    const key = `${issue.rule} ${issue.severity}`;
    const existing = by.get(key);
    if (existing) existing.count++;
    else by.set(key, {
      rule: issue.rule,
      severity: issue.severity,
      count: 1,
      clause: issue.clause ?? '',
    });
  }
  // Errors first, then by descending count — the most load-bearing findings top.
  return [...by.values()].sort((a, b) =>
    (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1));
}

function verdict(report: ValidationReport): string {
  return report.Passed
    ? `PASS — ${report.Warnings.length} warning(s)`
    : `FAIL — ${report.Errors.length} error(s), ${report.Warnings.length} warning(s)`;
}

export function addComplianceShowcase(doc: Document, page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Standards Validation — PDF/A · PDF/X · PDF/UA',
    'real findings from this very document  •  ConvertToPdfA and what it could not fix');

  const pdfa = doc.ValidatePdfA('2b');
  const pdfx = doc.ValidatePdfX('4');
  const pdfua = doc.ValidatePdfUa();

  console.log(`validate: PDF/A-2b ${verdict(pdfa)}; PDF/X-4 ${verdict(pdfx)}; `
    + `PDF/UA ${verdict(pdfua)}`);

  addText(page,
    'These are this document\'s own validation results, produced on this run — '
    + 'not a curated example. It does not pass PDF/A-2b, and the reasons are '
    + 'worth seeing: the Standard-14 faces this showcase stamps with are not '
    + 'embedded, and there is no /OutputIntent. That is what a first run over '
    + 'your own files will look like.',
    [50, 636, w - 50, 700], { size: 10, color: INK, lineSpacing: 1.35 });

  const verdicts: Array<[string, ValidationReport]> = [
    ['PDF/A-2b', pdfa], ['PDF/X-4', pdfx], ['PDF/UA-1', pdfua],
  ];
  verdicts.forEach(([label, r], i) => {
    const x = 50 + i * ((w - 100) / 3);
    addText(page, label, [x, 604, x + 150, 620],
      { font: 'Helvetica-Bold', size: 11, color: NAVY });
    addText(page, verdict(r), [x, 588, x + 160, 602],
      { size: 9, color: r.Passed ? GREEN : [0.70, 0.20, 0.15] });
  });

  // --- The findings table --------------------------------------------------
  const table = createTable({
    font: 'Helvetica',
    fontSize: 8.5,
    outerBorder: { width: 1, color: DEEP_NAVY },
    border: { width: 0.4, color: [0.80, 0.80, 0.80] },
    padding: { top: 3, right: 5, bottom: 3, left: 5 },
  });
  table.setColumnWidths([{ fixed: 96 }, { fixed: 62 }, { fixed: 46 }, { fixed: 42 }, { fixed: 249 }]);

  const header = table.addRow(undefined, {
    minHeight: 20, background: DEEP_NAVY,
    font: 'Helvetica-Bold', fontSize: 9, color: [1, 1, 1],
  });
  for (const [label, align] of [['Rule', 'left'], ['Standard', 'left'],
    ['Severity', 'left'], ['Count', 'right'], ['Clause', 'left']] as Array<[string, 'left' | 'right']>) {
    header.addCell(label, { align, valign: 'center' });
  }
  table.setRepeatingRowsCount(1);

  let zebra = 0;
  for (const [standard, report] of verdicts) {
    for (const rc of summarize(report)) {
      const row = table.addRow(undefined,
        zebra++ % 2 === 1 ? { background: [0.97, 0.97, 0.98] } : {});
      row.addCell(rc.rule, { align: 'left' });
      row.addCell(standard, { align: 'left' });
      row.addCell(rc.severity, {
        align: 'left',
        color: rc.severity === 'error' ? [0.70, 0.20, 0.15] : [0.65, 0.45, 0.05],
      });
      row.addCell(String(rc.count), { align: 'right' });
      row.addCell(rc.clause, { align: 'left', fontSize: 7.5, color: MUTED });
    }
  }

  const res = page.AddTable(table, 50, 570, {
    width: w - 100, autoPaginate: false, bottomMargin: 150,
  });
  void res;

  // --- Conversion ----------------------------------------------------------
  // ExtractPages gives an independent copy: the live document still has to be
  // saved unconverted, so ConvertToPdfA must never touch it.
  const copy = doc.ExtractPages(doc.Pages.map((_, i) => i + 1));
  const conversion = copy.ConvertToPdfA('2b');
  writeFileSync(PDFA_PATH, copy.Save());
  console.log(`pdf/a convert: ${conversion.applied.length} action(s) applied, `
    + `${conversion.unresolved.length} unresolved -> ${PDFA_PATH}`);

  addText(page, 'ConvertToPdfA(\'2b\') on a copy', [50, 128, w - 50, 142],
    { font: 'Helvetica-Bold', size: 11, color: NAVY });

  const appliedRules = [...new Set(conversion.applied.map((a) => a.rule))];
  const unresolvedRules = [...new Set(conversion.unresolved.map((i) => i.rule))];
  addText(page,
    `Wrote ${PDFA_PATH}. Applied ${conversion.applied.length} action(s)`
    + (appliedRules.length ? ` covering ${appliedRules.join(', ')}` : '')
    + `. ${conversion.unresolved.length} issue(s) remain unresolved`
    + (unresolvedRules.length ? ` (${unresolvedRules.join(', ')})` : '')
    + `. Result: ${conversion.passed ? 'passes' : 'still fails'} PDF/A-2b. `
    + 'Conversion runs on an ExtractPages copy — the live document still has to '
    + 'be saved unconverted, so it is never touched.',
    [50, 74, w - 50, 124], { size: 8.5, color: INK, lineSpacing: 1.3 });

  void h;
}
```

- [ ] **Step 4: Wire it into `main.ts`**

1. Import:

```ts
import { addComplianceShowcase } from './compliance.js';
```

2. Destination constant:

```ts
export const DEST_COMPLIANCE = 'section.compliance';
```

3. Allocate the page unfilled, beside `taggedPage`:

```ts
const compliancePage = doc.AddPage(PageFormat.A4).page;
```

4. `Section` entry, after the tagged entry:

```ts
  { dest: DEST_COMPLIANCE, title: 'Standards Validation — PDF/A · PDF/X · PDF/UA', subtype: 'compliance', page: compliancePage },
```

5. In the late phase, after the `handTagPage(doc, taggedPage, …)` line:

```ts
addComplianceShowcase(doc, compliancePage);
addUnifiedFooter(compliancePage, compliancePage.Number, doc.Pages.length);
handTagPage(doc, compliancePage, 'Standards Validation');
```

- [ ] **Step 5: Run and verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run example:showcase`
Expected: exit 0, a `validate: …` line showing PDF/A-2b FAIL, a `pdf/a convert: …` line, `all checks passed`.

Open the PDF: the compliance page shows three verdicts and a findings table with real rule ids (`FontEmbedded` among them) and real counts. Confirm `docs/feature-showcase-pdfa.pdf` exists and opens.

- [ ] **Step 6: Commit**

```bash
git add _examples/feature-showcase/compliance.ts _examples/feature-showcase/main.ts _examples/feature-showcase/verify.ts
git commit -m "$(cat <<'EOF'
feat(example): report real PDF/A, PDF/X and PDF/UA findings

Runs all three validators over the finished document and renders the findings
through the table-authoring layer, grouped by rule with real counts.

The document genuinely fails PDF/A-2b — the Standard-14 faces it stamps with
are not embedded and there is no /OutputIntent — and the page says so. Showing
a pass here would mean validating a doctored copy; the honest failure is what a
first run over a user's own files looks like.

ConvertToPdfA runs on an ExtractPages copy and writes a sibling, because the
live document still has to be saved unconverted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: HTML export

**Files:**
- Create: `_examples/feature-showcase/htmlexport.ts`
- Modify: `_examples/feature-showcase/main.ts`
- Modify: `_examples/feature-showcase/verify.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `doc.ToHtml(opts?: HtmlOptions): string` where `HtmlOptions` is `{ mode?: 'semantic'|'fixed'; box?: 'crop'|'media'; annotations?: boolean; fonts?: 'map'|'embed'|'embed-all'; fragment?: boolean; title?: string }`.
- Produces: `addHtmlShowcase(doc: Document, page: Page): void`; `DEST_HTML = 'section.html'` exported from `main.ts`.

- [ ] **Step 1: Write the failing verification**

Append an eighth group in `verify.ts`:

```ts
  // 8. Both HTML siblings exist, and the semantic one took the tagged path.
  for (const p of ['docs/feature-showcase.html', 'docs/feature-showcase-fixed.html']) {
    check(existsSync(p), `${p} was written`);
  }
  const semantic = readFileSync('docs/feature-showcase.html', 'utf8');
  check(semantic.length > 4096, 'the semantic export has substantial content');
  check(/<h[1-6][ >]/.test(semantic),
    'the semantic export emitted heading markup (proving the tagged path)');
```

Extend the `node:fs` import in `verify.ts` to `import { existsSync, readFileSync } from 'node:fs';`.

The heading assertion is the load-bearing one: `ToHtml` falls back to `untaggedBody` when `GetStructTree()` is null, and that fallback does not emit `<h1>`–`<h6>` from the structure tree. So this check fails if the ordering in Task 4 ever regresses and HTML export runs before tagging.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run example:showcase`
Expected: FAIL — `Error: showcase verification failed: docs/feature-showcase.html was written`

- [ ] **Step 3: Write `htmlexport.ts`**

Create `_examples/feature-showcase/htmlexport.ts`:

```ts
import { writeFileSync } from 'node:fs';
import type { Document, Page } from '../../src/index.js';
import { addText, cardGrid, pageWidth, sectionHeader, INK, MUTED, NAVY } from './theme.js';

const SEMANTIC_PATH = 'docs/feature-showcase.html';
const FIXED_PATH = 'docs/feature-showcase-fixed.html';

function kb(s: string): string {
  return `${(Buffer.byteLength(s, 'utf8') / 1024).toFixed(1)} KB`;
}

/** The first `count` lines of `html` that carry visible markup, trimmed and
 *  clipped to `width` characters so they fit a card without wrapping. */
function excerpt(html: string, count: number, width: number): string[] {
  return html
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, count)
    .map((l) => (l.length > width ? `${l.slice(0, width - 1)}…` : l));
}

export function addHtmlShowcase(doc: Document, page: Page): void {
  const w = pageWidth(page);

  sectionHeader(page, 'HTML Export',
    'semantic reflowable markup  •  fixed positioned pages  •  fonts embedded as WOFF');

  // Semantic mode reflows from the structure tree, so this must run after the
  // tagging pass — ToHtml falls back to a heuristic body when GetStructTree()
  // is null, and the export loses its heading structure silently.
  const semantic = doc.ToHtml();
  const fixed = doc.ToHtml({ mode: 'fixed', fonts: 'embed' });

  writeFileSync(SEMANTIC_PATH, semantic, 'utf8');
  writeFileSync(FIXED_PATH, fixed, 'utf8');
  console.log(`html: ${SEMANTIC_PATH} (${kb(semantic)}), ${FIXED_PATH} (${kb(fixed)})`);

  addText(page,
    'The same document, exported two ways. Semantic mode walks the structure '
    + 'tree the previous section built and emits reflowable markup — headings, '
    + 'paragraphs, lists, tables, images as data URIs — which reads in a browser '
    + 'at any width. Fixed mode reproduces each page as positioned SVG and '
    + 'absolutely-placed text, inlining every embeddable font program as a '
    + 'base64 WOFF @font-face so the page looks the same without the reader '
    + 'having the fonts.',
    [50, 620, w - 50, 700], { size: 10, color: INK, lineSpacing: 1.35 });

  const inners = cardGrid(page, [
    `Semantic — ${SEMANTIC_PATH.split('/').pop()}  (${kb(semantic)})`,
    `Fixed — ${FIXED_PATH.split('/').pop()}  (${kb(fixed)})`,
  ], { cols: 1, rows: 2, left: 50, right: w - 50, top: 606, bottom: 150, gapY: 18 });

  const paint = (inner: [number, number, number, number], html: string): void => {
    const lines = excerpt(html, 16, 104);
    lines.forEach((line, i) => {
      const y = inner[3] - 12 - i * 10.5;
      if (y < inner[1]) return;
      addText(page, line, [inner[0], y, inner[2], y + 9.5], { size: 7, color: MUTED });
    });
  };
  paint(inners[0], semantic);
  paint(inners[1], fixed);

  addText(page,
    'Both files are build products, regenerated on every run and excluded from '
    + 'git. Open them beside this PDF to compare: the semantic export reflows, '
    + 'the fixed export does not.',
    [50, 118, w - 50, 142], { size: 8.5, color: MUTED, lineSpacing: 1.35 });

  void NAVY;
}
```

- [ ] **Step 4: Wire it into `main.ts`**

1. Import:

```ts
import { addHtmlShowcase } from './htmlexport.js';
```

2. Destination constant:

```ts
export const DEST_HTML = 'section.html';
```

3. Allocate the page unfilled, beside `compliancePage`:

```ts
const htmlPage = doc.AddPage(PageFormat.A4).page;
```

4. `Section` entry, after the compliance entry:

```ts
  { dest: DEST_HTML, title: 'HTML Export', subtype: 'html', page: htmlPage },
```

5. In the late phase, after the compliance block:

```ts
addHtmlShowcase(doc, htmlPage);
addUnifiedFooter(htmlPage, htmlPage.Number, doc.Pages.length);
handTagPage(doc, htmlPage, 'HTML Export');
```

Order matters here: `addHtmlShowcase` exports the document *as it stands*, so it runs after the tagged and compliance pages are filled and before the signing page. The exports will not contain the signing page's text — that is expected and honest, since signing happens after the PDF is written.

- [ ] **Step 5: Add the siblings to `.gitignore`**

Append to `.gitignore`:

```
# feature-showcase build products (docs/feature-showcase.pdf is committed)
docs/feature-showcase.html
docs/feature-showcase-fixed.html
docs/feature-showcase-pdfa.pdf
docs/feature-showcase-signed.pdf
```

- [ ] **Step 6: Run and verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run example:showcase`
Expected: exit 0, an `html: …` line with two sizes, `all checks passed`.

Open `docs/feature-showcase.html` in a browser: it should show headings and flowing paragraphs, and reflow when the window narrows. Open `docs/feature-showcase-fixed.html`: it should look like the PDF pages.

Run: `git status --short`
Expected: the four sibling files do NOT appear.

- [ ] **Step 7: Commit**

```bash
git add _examples/feature-showcase/htmlexport.ts _examples/feature-showcase/main.ts _examples/feature-showcase/verify.ts .gitignore
git commit -m "$(cat <<'EOF'
feat(example): export the showcase to HTML, both modes

Semantic mode reflows from the structure tree the tagging section builds; fixed
mode reproduces positioned pages with every embeddable font inlined as a base64
WOFF @font-face. Both siblings are written on each run and gitignored.

The section runs after tagging deliberately: ToHtml falls back to a heuristic
body when GetStructTree() is null, and the export loses its heading structure
silently. verify.ts asserts heading markup in the semantic output, so an
ordering regression fails the build rather than degrading quietly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Digital signatures

Signing appends incrementally and the signed bytes must not be mutated afterwards, so this runs **last, on the saved file** — never on the live document.

**Files:**
- Create: `_examples/feature-showcase/signcred.ts`
- Create: `_examples/feature-showcase/signing.ts`
- Modify: `_examples/feature-showcase/main.ts`
- Modify: `_examples/feature-showcase/verify.ts`

**Interfaces:**
- Consumes: `Document.OpenFile(path)`; `doc.Certify(signer, opts)` and `doc.Sign(signer, opts)` — both `async`; `doc.VerifySignatures(): Promise<SignatureReport[]>`. A `Signer` may be a `CmsSigner`: `{ certificate: Uint8Array; privateKey: KeyObject }`. `SignOptions.appearance` is `{ page: number /* 0-based */; rect: [x1, y1, x2, y2]; text?: string; image?: Uint8Array }`. `CertifyOptions.permissions` is `DocMdpPermission` = `'no-changes' | 'form-fill' | 'form-fill-and-annotate'` — note `'form-fill'`, not `'form-filling'`. `SignatureReport` is `{ name; integrity: 'valid'|'tampered'; signature: 'valid'|'invalid'; coversWholeFile: boolean; docMDP: 'ok'|'violated'|'n/a'; signerCert?: { subject; issuer; serialNumber; notBefore; notAfter }; … }`.
- Produces:
  - `mintSigner(commonName: string): { certificate: Uint8Array; privateKey: KeyObject }` from `signcred.ts`
  - `SIGNATURE_RECT: [number, number, number, number]` from `signing.ts`
  - `addSigningShowcase(page: Page): void`
  - `signSavedDocument(sourcePath: string, signaturePageIndex: number): Promise<void>`
  - `DEST_SIGN = 'section.signing'` exported from `main.ts`

- [ ] **Step 1: Write the failing verification**

Append a ninth group in `verify.ts`. It needs a re-open plus an async call, so add a separate exported function at the end of the file rather than extending the synchronous one:

```ts
/** The signed sibling: two signatures, both intact, with the certification's
 *  DocMDP verdict clean. Separate from verifySavedDocument because it must
 *  open a different file and VerifySignatures is async. */
export async function verifySignedDocument(path: string): Promise<void> {
  console.log('verifying signed sibling:');
  check(existsSync(path), `${path} was written`);
  const doc = Document.OpenFile(path);
  const reports = await doc.VerifySignatures();
  check(reports.length === 2, `the sibling carries two signatures (${reports.length})`);
  reports.forEach((r, i) => {
    check(r.integrity === 'valid', `signature ${i + 1} (${r.name}) has an intact /ByteRange digest`);
    check(r.signature === 'valid', `signature ${i + 1} (${r.name}) verifies cryptographically`);
  });
  check(reports[0].docMDP === 'ok',
    'the certification signature\'s DocMDP verdict is ok');
  check(reports[reports.length - 1].coversWholeFile,
    'the last signature covers the whole file');
  console.log('signed sibling verified');
}
```

- [ ] **Step 2: Run it to make sure it fails**

It is not called yet, so first wire the call (Step 6 below) — or simply confirm the compile-time gate. For this step, run:

Run: `npm run example:showcase`
Expected: exit 0 (the new function is unreferenced). This is the one task whose failing state is established at Step 6; note it and continue.

- [ ] **Step 3: Write `signcred.ts`**

Create `_examples/feature-showcase/signcred.ts`:

```ts
// Signing credentials, minted fresh on every run: an RSA keypair plus a
// self-signed X.509 certificate, assembled with the library's own DER encoder.
// No checked-in secrets, and nothing that can expire.
//
// This mirrors test/helpers/build-signer.ts. It is duplicated rather than
// imported because _examples must not depend on test/ — the published package
// ships neither, but an example that breaks when a test helper is refactored is
// a bad example.

import { generateKeyPairSync, sign as cryptoSign, KeyObject } from 'node:crypto';
import { der } from '../../src/asn1.js';

const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const CN = '2.5.4.3';

function name(commonName: string): Uint8Array {
  return der.sequence(der.set(der.sequence(der.oid(CN), der.utf8String(commonName))));
}

export interface MintedSigner {
  certificate: Uint8Array;
  privateKey: KeyObject;
  commonName: string;
}

/** An RSA-2048 keypair and a self-signed certificate naming `commonName`. */
export function mintSigner(commonName: string): MintedSigner {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certAlgId = der.sequence(der.oid(SHA256_WITH_RSA), der.null_());
  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));

  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),                             // version v3
    der.integer(BigInt(Date.now())),                             // serialNumber
    certAlgId,                                                   // signature
    name(commonName),                                            // issuer
    der.sequence(
      der.utcTime(new Date(Date.UTC(2020, 0, 1))),
      der.utcTime(new Date(Date.UTC(2049, 11, 31))),
    ),                                                           // validity
    name(commonName),                                            // subject (self-signed)
    spki,                                                        // subjectPublicKeyInfo
  );

  const sig = new Uint8Array(cryptoSign('sha256', tbs, privateKey));
  const certificate = der.sequence(tbs, certAlgId, der.bitString(sig));
  return { certificate, privateKey, commonName };
}
```

- [ ] **Step 4: Write `signing.ts`**

Create `_examples/feature-showcase/signing.ts`:

```ts
import type { Page } from '../../src/index.js';
import { Document } from '../../src/index.js';
import { addText, pageWidth, sectionHeader, INK, MUTED, NAVY } from './theme.js';
import { mintSigner } from './signcred.js';

export const SIGNED_PATH = 'docs/feature-showcase-signed.pdf';

/** Where the certification signature's visible widget lands on the signing
 *  page. Exported so the unsigned document can draw the same rect as an empty
 *  placeholder, and the two provably agree. */
export const SIGNATURE_RECT: [number, number, number, number] = [50, 430, 290, 530];

/** The page in the *unsigned* document. It explains what the sibling contains
 *  and outlines the rect the signature will occupy there. */
export function addSigningShowcase(page: Page): void {
  const w = pageWidth(page);

  sectionHeader(page, 'Digital Signatures',
    'certification with DocMDP  •  an approval signature  •  incremental append  •  verification');

  addText(page,
    'This document is deliberately left unsigned — signing would freeze it '
    + 'against the regeneration this example exists to perform. Instead, the '
    + 'run re-opens the finished PDF and writes a signed sibling: first a '
    + 'certification (author) signature carrying a DocMDP transform that permits '
    + 'form filling and nothing more, then a second approval signature over the '
    + 'result.',
    [50, 620, w - 50, 700], { size: 10, color: INK, lineSpacing: 1.35 });

  addText(page,
    'Two signatures rather than one, because the second is what exercises the '
    + 'incremental-append path: the first signature\'s bytes must survive '
    + 'verbatim underneath it. A single signature would not distinguish an '
    + 'append from a full rewrite. Credentials are minted on every run — an '
    + 'RSA-2048 keypair and a self-signed certificate built with the library\'s '
    + 'own DER encoder — so there is nothing checked in and nothing to expire.',
    [50, 548, w - 50, 612], { size: 10, color: INK, lineSpacing: 1.35 });

  // The placeholder outline: the same rect the certification will occupy in the
  // sibling, drawn here so the two can be compared side by side.
  const g = page.Graphics();
  g.save().setStrokeColor([0.70, 0.72, 0.82]).setLineWidth(1).setDash([5, 4])
    .rect(SIGNATURE_RECT[0], SIGNATURE_RECT[1],
      SIGNATURE_RECT[2] - SIGNATURE_RECT[0], SIGNATURE_RECT[3] - SIGNATURE_RECT[1])
    .stroke().restore();
  g.apply();

  addText(page, 'Signature appears here in the signed sibling',
    [SIGNATURE_RECT[0] + 10, SIGNATURE_RECT[1] + 40,
      SIGNATURE_RECT[2] - 10, SIGNATURE_RECT[1] + 62],
    { size: 9.5, color: MUTED, align: 'center' });

  addText(page,
    'Open docs/feature-showcase-signed.pdf to see it filled. The console output '
    + 'of this run reports each signature\'s signer, integrity, cryptographic '
    + 'validity, byte-range coverage and DocMDP verdict.',
    [SIGNATURE_RECT[2] + 24, 452, w - 50, 528],
    { size: 9, color: MUTED, lineSpacing: 1.35 });

  void NAVY;
}

/** Re-open `sourcePath`, certify it, sign it again, and write the sibling.
 *
 *  Runs on the saved file rather than the live document because signing appends
 *  incrementally: the signed bytes must not be mutated afterwards, and the live
 *  document still has a full rewrite ahead of it. `signaturePageIndex` is
 *  0-based, as SignatureAppearance requires. */
export async function signSavedDocument(
  sourcePath: string, signaturePageIndex: number,
): Promise<void> {
  const doc = Document.OpenFile(sourcePath);
  const author = mintSigner('Aspose Showcase Author');
  const approver = mintSigner('Aspose Showcase Approver');

  await doc.Certify(
    { certificate: author.certificate, privateKey: author.privateKey },
    {
      permissions: 'form-fill',
      reason: 'Certifying the feature showcase',
      location: 'Prague, CZ',
      name: author.commonName,
      fieldName: 'ShowcaseCertification',
      appearance: {
        page: signaturePageIndex,
        rect: SIGNATURE_RECT,
        text: `Certified by ${author.commonName}\n`
          + 'DocMDP: form filling permitted\n'
          + 'Aspose.PDF FOSS for TypeScript',
      },
    },
  );

  await doc.Sign(
    { certificate: approver.certificate, privateKey: approver.privateKey },
    {
      reason: 'Approved for publication',
      name: approver.commonName,
      fieldName: 'ShowcaseApproval',
      subFilter: 'PAdES',
    },
  );

  doc.WriteTo(SIGNED_PATH);
  console.log(`signed: ${SIGNED_PATH}`);

  const reports = await Document.OpenFile(SIGNED_PATH).VerifySignatures();
  for (const r of reports) {
    console.log(`  ${r.name}: signer=${r.signerCert?.subject ?? '(unparsed)'} `
      + `integrity=${r.integrity} signature=${r.signature} `
      + `coversWholeFile=${r.coversWholeFile} docMDP=${r.docMDP}`);
  }
}
```

- [ ] **Step 5: Wire it into `main.ts`**

1. Imports:

```ts
import { addSigningShowcase, signSavedDocument, SIGNED_PATH } from './signing.js';
import { verifySavedDocument, verifySignedDocument } from './verify.js';
```

(the second replaces the existing `verify.js` import line)

2. Destination constant:

```ts
export const DEST_SIGN = 'section.signing';
```

3. Allocate the page unfilled, beside `htmlPage`:

```ts
const signingPage = doc.AddPage(PageFormat.A4).page;
```

4. `Section` entry, last in the array:

```ts
  { dest: DEST_SIGN, title: 'Digital Signatures', subtype: 'signing', page: signingPage },
```

5. In the late phase, after the HTML block and before `doc.WriteTo(OUTPUT_PATH)`:

```ts
addSigningShowcase(signingPage);
addUnifiedFooter(signingPage, signingPage.Number, doc.Pages.length);
handTagPage(doc, signingPage, 'Digital Signatures');
```

6. Replace the tail of the file — from `doc.WriteTo(OUTPUT_PATH);` to the end — with:

```ts
doc.WriteTo(OUTPUT_PATH);
console.log(`wrote ${OUTPUT_PATH} (${doc.Pages.length} pages)`);

verifySavedDocument(OUTPUT_PATH, sections);

// --- Signing --------------------------------------------------------------
// Last of all, and on the saved file rather than the live document: signing
// appends incrementally, so the signed bytes must not be mutated afterwards.
// The main artifact stays unsigned on purpose — signing it would freeze it
// against the regeneration this example exists to perform.
await signSavedDocument(OUTPUT_PATH, signingPage.Number - 1);
await verifySignedDocument(SIGNED_PATH);
```

`Page.Number` is 1-based and `SignatureAppearance.page` is 0-based, hence the `- 1`.

Top-level `await` needs no config change: `target: ES2022` with `module: NodeNext` already permits it in an ESM module.

- [ ] **Step 6: Run and verify**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run example:showcase`
Expected: exit 0, ending with:
- `signed: docs/feature-showcase-signed.pdf`
- two `ShowcaseCertification` / `ShowcaseApproval` lines with `integrity=valid signature=valid`
- `verifying signed sibling:` followed by its checks and `signed sibling verified`

Open `docs/feature-showcase-signed.pdf` in Acrobat Reader. It will report the signatures as valid-but-untrusted (self-signed certificates have no trust anchor — expected). Confirm the visible signature block appears on the Digital Signatures page in the rect the unsigned PDF outlines.

- [ ] **Step 7: Commit**

```bash
git add _examples/feature-showcase/signcred.ts _examples/feature-showcase/signing.ts _examples/feature-showcase/main.ts _examples/feature-showcase/verify.ts
git commit -m "$(cat <<'EOF'
feat(example): certify and sign a sibling of the saved showcase

Re-opens the written PDF, adds a certification signature with a DocMDP
transform permitting form filling, then a second approval signature, and
verifies both. Two signatures rather than one because the second is what
exercises incremental append: the first's bytes must survive verbatim beneath
it, which a single signature would not distinguish from a full rewrite.

Runs last and on the saved file, never the live document — signed bytes must
not be mutated afterwards. The main artifact stays unsigned deliberately, since
signing would freeze it against regeneration; its signing page outlines the
same rect the sibling fills, so the two can be compared.

Credentials are minted per run (RSA-2048 + a self-signed cert built with the
library's own DER encoder). Nothing checked in, nothing to expire.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Find the showcase section**

Run: `grep -n "feature-showcase" README.md`

- [ ] **Step 2: Update the section list and document the siblings**

In the passage describing `docs/feature-showcase.pdf`, extend the list of what the showcase covers with the six new sections:

```markdown
- **Barcodes & QR codes** — Code 128, EAN-13, UPC-A, EAN-8 and QR at two
  error-correction levels, as vector modules or a 1-bit `/ImageMask` stencil.
- **Optional-content layers** — a floor plan across five OCGs, one nested and
  one default-off, with an image and a barcode bound to layers of their own.
- **Tagged PDF** — one `AutoTag` pass over the whole document, plus
  hand-authored elements via `StructTreeRoot.Append` and
  `StructElement.MarkContent`.
- **HTML export** — the same document as reflowable semantic markup and as
  positioned pages with fonts inlined as WOFF.
- **Standards validation** — this document's own PDF/A-2b, PDF/X-4 and PDF/UA-1
  findings, and what `ConvertToPdfA` could and could not fix.
- **Digital signatures** — a certification signature with a DocMDP transform
  plus an approval signature, written to a signed sibling and verified.
```

Then add, immediately after that list:

```markdown
Running `npm run example:showcase` regenerates `docs/feature-showcase.pdf`
(the committed artifact) and four build products alongside it, all gitignored:

| File | What it is |
|---|---|
| `docs/feature-showcase.html` | reflowable semantic export |
| `docs/feature-showcase-fixed.html` | positioned export, fonts embedded as WOFF |
| `docs/feature-showcase-pdfa.pdf` | `ConvertToPdfA('2b')` applied to a copy |
| `docs/feature-showcase-signed.pdf` | certified + approval-signed copy |

The showcase does **not** pass PDF/A-2b, and its validation section says so: it
stamps with Standard-14 faces that are not embedded and carries no
`/OutputIntent`. That is deliberate — the honest report is more useful than a
doctored one.
```

- [ ] **Step 3: Verify the docs match reality**

Run: `npm run example:showcase`
Expected: exit 0. Confirm every file named in the new table exists:

Run: `ls -l docs/feature-showcase.pdf docs/feature-showcase.html docs/feature-showcase-fixed.html docs/feature-showcase-pdfa.pdf docs/feature-showcase-signed.pdf`
Expected: all five present.

Run: `git status --short`
Expected: only `README.md` (and a regenerated `docs/feature-showcase.pdf`) appear — none of the four siblings.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/feature-showcase.pdf
git commit -m "$(cat <<'EOF'
docs: describe the showcase's TypeScript-only sections

Lists the six new sections and the four sibling build products, and states
plainly that the showcase fails PDF/A-2b and why — the validation section
reports its own honest findings rather than a curated pass.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Session close

- [ ] **Step 1: Run both gates one final time**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm test`
Expected: the full vitest suite passes. The example is not covered by it, but the `theme.ts`/`vector.ts` refactor and any incidental `src/` touch must not have regressed anything.

Run: `npm run example:showcase`
Expected: exit 0, ending with `signed sibling verified`.

- [ ] **Step 2: File follow-ups**

Anything deferred during implementation gets a `bd` issue — not a TODO comment, not a markdown list:

```bash
bd create "<title>" -d "<what and why>"
```

- [ ] **Step 3: Push**

Work is not complete until this succeeds:

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: layout and outputs → Tasks 2-7 plus the `.gitignore` in Task 6; barcodes → Task 2; layers, including the text-has-no-layer-option constraint → Task 3; tagging order, the single `AutoTag` pass and the `Optimize` reorder → Task 4; validation with the honest PDF/A failure and the `ExtractPages` copy → Task 5; HTML export after tagging → Task 6; signing on the saved file with two signatures and run-time credentials → Task 7; shared `cardGrid` → Task 1; verification → distributed across Tasks 2-7 as the failing-test step of each; testing gates → every task; documentation → Task 8.

**Placeholder scan.** No TBD/TODO markers, no "similar to Task N", no "add appropriate error handling". Every code step carries the actual code.

**Type consistency.** `cardGrid(page, labels, opts): Box[]` is defined in Task 1 and called with that signature in Tasks 2, 3, 4 and 6. `handTagPage(doc, page, heading)` is defined in Task 4 and called with that signature in Tasks 5, 6 and 7. `SIGNATURE_RECT` and `SIGNED_PATH` are defined in Task 7 and used only there and in `main.ts`. `mintSigner(commonName)` returns `{ certificate, privateKey, commonName }`, which matches the `CmsSigner` shape `Document.Certify`/`Sign` accept. `AutoTagReport` field names (`headings`, `paragraphs`, `figures`, `artifacts`, `tables`) match `src/autotag.ts`. `SignatureReport` field names (`integrity`, `signature`, `coversWholeFile`, `docMDP`, `signerCert.subject`) match `src/sigverify.ts`. `ConversionReport` (`applied`, `unresolved`, `passed`) matches `src/conversion.ts`.

**One known rough edge, flagged rather than hidden.** Task 7 Step 2 cannot show a red test before the code exists, because the new verification function is unreferenced until Step 5 wires it. The failing state is established at Step 6 instead. Every other task has a genuine red-then-green cycle.
