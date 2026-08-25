# Phase 5 — Page Composition & Navigation (design)

Content-authoring roadmap **Phase 5**, the first phase after the Phase 4
redaction/editing epic (`aspose-pdf-foss-for-ts-638`) closed. This spec is the
shared design for the Phase 5 epic and blocks its implementation children.

Phase 5 adds **document-to-document composition** (place one page's content onto
another as a reusable Form XObject: watermarks, letterheads, backgrounds, N-up
imposition, page resize/scale) and rounds out **navigation metadata** (logical
page labels and named destinations). It introduces no new runtime dependencies
and does not change the full-rewrite `Save` model.

## Scope

Two tracks over one new foundation:

1. **Composition** (`compose.ts`) — an *import-page-as-Form-XObject* primitive,
   then overlay/underlay stamping (same- or cross-document), N-up imposition, and
   page resize/scale built on it.
2. **Navigation metadata** (`pagelabels.ts`, plus `outline.ts` extensions) —
   `/PageLabels` read/write with label resolution, and named-destination CRUD.

### Key decisions (resolved during design)

- **Optimization is out of scope.** Object/stream dedup, image downsampling, and
  font subsetting are deferred to a later phase; they need codecs and a
  subsetter that do not exist yet. Phase 5 stays composition + navigation.
- **Import via wrap-as-XObject (object-graph copy).** The page-import primitive
  reuses `extractPage` to obtain a self-contained graph, remaps it into the
  target document (the existing `importPage` ref-remap step), and wraps it in a
  Form XObject. The XObject is **shareable** — placed once per N-up cell or once
  per overlaid page — which the inline-splice alternative cannot offer.
- **N-up returns a new `Document`.** Imposition changes page count and size, so
  it is non-destructive, mirroring `Split` / `ExtractPages`.
- **Crop-to-content is deferred.** A tight bounding box around marks needs
  vector-path bounds the library does not compute today (the content visitor
  yields glyph/image quads only). `Resize` takes an explicit box instead.

### Dependencies (all shipped on `main`)

- `extractor.ts` — `extractPage(doc, pageDict, policy) → { objects, pageNum }`
  (self-contained graph), `cloneShallow`, `rewriteRefs`.
- `document.ts` — `importPage` / `importPages` (cross-document object-graph copy
  with old→new ref remapping), `Split`, `ExtractPages`, `Merge`.
- `pagecontent.ts` — `appendContent` (q/Q-wrapped splice), `ensureOwnResources` /
  `ensureOwnSubdict` (copy-on-write resource dicts), `registerExtGState`,
  `freshKey`, `streamOf`, `num`.
- `page.ts` — `Page.Contents`, `Page.Resources`, the five boundary boxes
  (read/write), `Rotate` (read/write).
- `outline.ts` — `parseDest` / `encodeDest` and the `OutlineDest` / `OutlineView`
  model (reused for named destinations).
- `text.ts` — affine matrix helpers (`mul` / `apply` / `translate`).

## Foundation — import a page as a Form XObject (`compose.ts`)

```ts
// @internal — the primitive the whole composition track is built on.
function importPageAsXObject(target: Document, src: Page): PdfRef
```

Algorithm:

1. **Copy the source graph.** `extractPage(src.Document, src.Dict, policy)` yields
   a self-contained object map (content streams + resources, inheritance already
   flattened). Remap it into `target` with a fresh old→new ref map (reusing the
   `importPage` remap loop: clone-shallow each object, `rewriteRefs`, allocate a
   `target` object number). When `src.Document === target`, the copy still runs —
   stamping a page onto itself must not create a cycle.
2. **Concatenate content.** Join the source page's (decoded) content streams into
   one byte buffer; this becomes the XObject stream body. Streams are decoded on
   read (existing `Page.Contents`) and re-stored uncompressed (Phase 5 does not
   re-compress; the compressed-`Save` path can compress later).
3. **Build the Form XObject dict:**
   - `/Type /XObject`, `/Subtype /Form`, `/FormType 1`.
   - `/BBox` = the source **CropBox** (fall back to MediaBox).
   - `/Matrix` = identity, adjusted for the source page `/Rotate` so the imported
     content is upright in the XObject's coordinate space (90/180/270 handled
     with the same matrices `appearance.ts` already uses for widget rotation).
   - `/Resources` = the remapped page resources.
4. Allocate and return the XObject `PdfRef` in `target`.

A clone is produced per import call; callers that place the same source on many
pages call once and reuse the returned ref (the XObject is shared, the `Do` is
repeated).

### Underlay support (`pagecontent.ts` extension)

`appendContent` today only appends (existing content wrapped in `q/Q`, body
after). Add a sibling:

```ts
export function prependContent(doc: Document, page: Page, body: Uint8Array): void
```

It inserts `body` (q/Q-wrapped) **before** the existing content so an underlay
draws behind it. Both share a small internal helper so the splice/normalize
logic is not duplicated.

## Track A — Composition: public API

### A1 — `page.StampWith`

```ts
page.StampWith(src: Page, opts?: StampWithOptions): void

interface StampWithOptions {
  mode?: 'overlay' | 'underlay';      // default 'overlay' (on top)
  rect?: [number, number, number, number];  // target box; default = fit src BBox to this page's CropBox
  opacity?: number;                   // 0..1, via registerExtGState; default 1
  rotate?: 0 | 90 | 180 | 270;        // extra rotation of the placed content; default 0
}
```

`importPageAsXObject(this.Document, src)` once, register it under this page's COW
`/Resources /XObject` (fresh `Fm` key), compute the placement matrix that maps
the XObject `/BBox` (through any `rotate`) onto `rect` (the same BBox→box mapping
flatten/L1 uses), then `appendContent` (overlay) or `prependContent` (underlay)
a `q [gs] <cm> /Fmk Do Q` body. Opacity registers/reuses an `/ExtGState`.

### A2 — `doc.Overlay`

```ts
doc.Overlay(src: Page | Document, opts?: OverlayOptions): void

interface OverlayOptions {
  pages?: number[];        // 1-based target pages; default = all pages
  underlay?: boolean;      // default false (overlay)
  rect?: [number, number, number, number];
  opacity?: number;
  rotate?: 0 | 90 | 180 | 270;
}
```

Convenience over `StampWith` for the common "letterhead / watermark / background
on every page" case. When `src` is a `Document`, its **first page** is used (a
single-page stamp source is the norm; document arg is sugar so callers need not
write `src.Pages[0]`). The source page is imported **once** and the shared
XObject ref is placed on each target page (register per target page's resources,
reuse the same object). Cross-document import leaves the source document
untouched.

### A3 — `doc.NUp`

```ts
doc.NUp(cols: number, rows: number, opts?: NUpOptions): Document

interface NUpOptions {
  pageSize?: [number, number];   // output sheet size; default derived from source page size * grid
  margin?: number;               // outer margin in points; default 0
  gutter?: number;               // spacing between cells; default 0
  order?: 'row' | 'column';      // cell fill order; default 'row'
}
```

Returns a **new** imposed `Document`. For every group of `cols*rows` source
pages: create one output sheet, import each source page as an XObject, and place
it scaled-to-fit into its grid cell (preserving aspect ratio, centered in the
cell). The last sheet may be partly empty. The source document is unmodified.
Validates `cols >= 1`, `rows >= 1` (else `RangeError`).

### A4 — `page.Resize` / `page.Scale`

```ts
page.Resize(box: [number, number, number, number], opts?: { scaleContent?: boolean }): void
page.Scale(factor: number): void
```

- `Resize` sets MediaBox and CropBox to `box`. With `scaleContent: true`
  (default `false`), it wraps existing content in a `cm` that maps the old
  CropBox onto `box` (anisotropic scale + translate), so the visible content
  fills the new box; with `false` the boxes change but content keeps its
  coordinates. Other boxes (Bleed/Trim/Art) that fall outside the new box are
  left as-is (documented; callers manage them explicitly).
- `Scale` multiplies content and all boundary boxes by a uniform `factor > 0`
  (content wrapped in `factor 0 0 factor 0 0 cm`). `RangeError` for non-finite or
  non-positive factors; malformed `box` throws `TypeError`.

## Track B — Navigation metadata

### B1 — Page labels (`pagelabels.ts`)

The `/Root /PageLabels` number tree maps page indices to label dictionaries.

```ts
doc.GetPageLabels(): PageLabel[]
doc.SetPageLabels(labels: PageLabel[]): void
doc.PageLabelFor(pageIndex: number): string   // 0-based page index → resolved label

interface PageLabel {
  startIndex: number;   // 0-based page index where this range begins
  style?: 'decimal' | 'roman' | 'Roman' | 'alpha' | 'Alpha' | 'none';
  prefix?: string;      // label prefix (e.g. "A-")
  start?: number;       // first numeric value in the range (default 1)
}
```

- `GetPageLabels` parses the number tree into ascending `PageLabel` ranges
  (`/S` style → enum, `/P` prefix, `/St` start). Leniently read.
- `SetPageLabels` validates and writes a fresh number tree under
  `/Root /PageLabels` (sorted by `startIndex`; first range must start at 0 or a
  `RangeError` is thrown). An empty array removes `/PageLabels`.
- `PageLabelFor` resolves a page index to its rendered label
  (`prefix + numeral(style, start + offset)`), with `decimal`/`roman`/`Roman`/
  `alpha`/`Alpha` numeral formatting; `none` yields just the prefix.

### B2 — Named destinations (`outline.ts` extension)

Manage the modern `/Root /Names /Dests` name tree (and read the legacy
`/Root /Dests` dictionary), reusing the existing destination codecs.

```ts
doc.GetNamedDestinations(): NamedDestination[]
doc.SetNamedDestination(name: string, dest: OutlineDest): void
doc.RemoveNamedDestination(name: string): void

interface NamedDestination { name: string; dest: OutlineDest; }
```

- `GetNamedDestinations` merges both sources (name-tree entries and the legacy
  dict), decoding each value with `parseDest`. Returned sorted by name.
- `SetNamedDestination` upserts into the `/Names /Dests` name tree (creating
  `/Names` and the tree as needed), encoding `dest` with `encodeDest`. Writes a
  single-node tree (a flat `/Names` array) — sufficient for the document sizes
  this library targets; no balanced-tree rebalancing.
- `RemoveNamedDestination` deletes the entry from the name tree and the legacy
  dict; removing the last entry prunes the now-empty containers.

## Module / file layout

| Module | Track | Responsibility |
|---|---|---|
| `compose.ts` | A | `importPageAsXObject` primitive + `StampWith` / `Overlay` / `NUp` / `Resize` / `Scale` |
| `pagecontent.ts` (extend) | A | add `prependContent` (underlay) beside `appendContent` |
| `pagelabels.ts` | B | `/PageLabels` number-tree read/write + label resolution |
| `outline.ts` (extend) | B | named-destination name-tree CRUD (reuses `parseDest`/`encodeDest`) |
| `page.ts` / `document.ts` (wire) | A,B | public methods delegating to the modules above |

## Errors

- `TypeError` — malformed rectangles/boxes, non-finite arguments, wrong arity
  (consistent with the rest of the public API).
- `RangeError` — `NUp` grid `< 1`; non-positive `Scale` factor; out-of-range page
  numbers; `SetPageLabels` first range not starting at index 0.
- `UnsupportedFeatureError` — reserved for genuinely unsupported source content
  (none expected in Phase 5; import copies whatever the source page references).

## Testing strategy

Per-issue vitest TDD with programmatic fixture builders in `test/helpers/`:

- A page carrying content + its own resources (font/image) to import.
- A two-document fixture for cross-document overlay (letterhead onto every page),
  asserting the **source document is unmodified** after the stamp.
- A multi-page document for N-up (verify cell count, placement matrices, that the
  result is a new Document with the expected page count/size).
- A page with non-trivial boxes for `Resize` / `Scale`.
- A `/PageLabels` fixture with multiple ranges (roman front matter → decimal
  body) for label resolution.
- A name-tree (and legacy-dict) fixture for named-destination CRUD.

Every operation asserts a `Save()` / `Open` round-trip.

## Non-goals (Phase 5)

- **Optimization** — object/stream dedup, image downsampling/recompression, font
  subsetting (separate later phase; needs codecs + a subsetter).
- **Crop-to-content** — tight box around marks (needs vector-path bounds not
  computed today).
- **Transparency-group / blend-mode flattening** when stamping (best-effort
  appearance, consistent with the Phase 3/4 non-goal).
- **Balanced name-tree rebalancing** — a flat `/Names` array is written.
- **Linearization** ("fast web view") and incremental/append-only save.

## Beads decomposition

Epic `Phase 5 — Page composition & navigation`, children:

| ID | Title | Depends on |
|---|---|---|
| 5.1 | Phase 5 design spec (this document) | — |
| 5.2 | C0 — `importPageAsXObject` primitive + `prependContent` underlay splice | 5.1 |
| 5.3 | C1 — `page.StampWith` (single-page overlay/underlay) | 5.2 |
| 5.4 | C2 — `doc.Overlay` (multi-page / cross-document) | 5.3 |
| 5.5 | C3 — `doc.NUp` imposition (new Document) | 5.2 |
| 5.6 | C4 — `page.Resize` / `page.Scale` geometry | 5.1 |
| 5.7 | N1 — `/PageLabels` read/write + resolution | 5.1 |
| 5.8 | N2 — named-destination CRUD | 5.1 |

Each child follows the repo's spec → plan → implementation cycle with vitest TDD,
matching the Phase 4 structure. README (Features, API overview, Limitations) is
updated as each public API lands.
