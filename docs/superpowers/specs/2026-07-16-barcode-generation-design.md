# Barcode generation (1D Code128/EAN + 2D QR) — design

Issue: `aspose-pdf-foss-for-ts-66f` (P3, feature)

## Goal

Pure-TS, zero-dependency barcode **generators** that emit either vector graphics
or an image XObject placeable on a page. Symbologies: Code128, EAN-13 (plus its
table-sharing cousins UPC-A and EAN-8), and QR. Recognition/decoding is out of
scope.

## Architecture

Pure generators feeding a placement layer, mirroring how `imageembed.ts` (build)
feeds `Page.AddImage` (place).

- **`src/barcode.ts`** — public 1D generators and the shared **module model**.
  Zero PDF knowledge: payload in → module geometry out.
- **`src/qr.ts`** — the QR encoder (segment encoding, Reed–Solomon ECC over
  GF(256), matrix layout + function patterns, data masking with penalty-based
  mask selection). Kept separate because it is the largest, most self-contained
  piece. Exports `makeQr`, re-exported through `barcode.ts`.
- **`src/barcodeplace.ts`** — turns a `BarcodeModel` into page content (vector
  rectangles or a 1-bit `/ImageMask` stencil) plus optional human-readable text.
- **`Page.AddBarcode`** in `src/page.ts` — a thin wrapper over `barcodeplace.ts`,
  consistent with the existing `Page.Add*` surface (`AddImage`, `AddText`).

### Module model (the interface between the two halves)

```ts
/** 1D: a row of alternating bar/space runs measured in unit modules.
 *  modules[0] is a bar; runs alternate bar, space, bar, ... */
interface LinearBarcode {
  kind: 'linear';
  modules: number[];   // run widths in unit modules
  text?: string;       // human-readable payload (digits) for HRI
}

/** 2D: a square matrix of dark/light modules, row-major. */
interface MatrixBarcode {
  kind: 'matrix';
  size: number;        // modules per side
  dark: boolean[];     // length size*size, true = dark
}

type BarcodeModel = LinearBarcode | MatrixBarcode;
```

### Generators (all exported for low-level use)

- `makeCode128(data: string): LinearBarcode` — full Code128 with automatic code
  set selection (A/B/C) and optimal switching: Code C for even-length digit runs,
  A for control chars, B otherwise; Start/Stop, modulo-103 checksum, quiet zones.
  Full ASCII 0–127.
- `makeEan13(digits: string): LinearBarcode` — 12 or 13 digits; the 13th (check)
  digit is validated if supplied, computed if omitted.
- `makeUpcA(digits: string): LinearBarcode` — 11 or 12 digits (shares EAN tables).
- `makeEan8(digits: string): LinearBarcode` — 7 or 8 digits.
- `makeQr(data: string, opts?: { ecc?: 'L'|'M'|'Q'|'H'; version?: number }):
  MatrixBarcode` — automatic mode selection (numeric / alphanumeric / byte-UTF-8),
  all four ECC levels, automatic version sizing 1..40 (overridable via `version`),
  penalty-based mask selection.

Invalid input (non-digit EAN payload, wrong length, checksum mismatch,
data too large for the chosen version/ECC) throws `TypeError` or `PdfParseError`.

## Public placement API

```ts
page.AddBarcode(spec: BarcodeSpec,
                rect: [x, y, w, h],
                opts?: AddBarcodeOptions): void;

type BarcodeSpec =
  | { type: 'code128'; data: string }
  | { type: 'ean13' | 'upca' | 'ean8'; data: string }
  | { type: 'qr'; data: string; ecc?: 'L'|'M'|'Q'|'H'; version?: number };

interface AddBarcodeOptions {
  render?: 'vector' | 'raster';   // default 'vector'
  color?: [number, number, number];  // dark-module RGB 0..1, default [0,0,0]
  quietZone?: boolean;            // include spec-required margins, default true
  text?: boolean;                 // human-readable digits under 1D barcode;
                                  //   default true for ean13/upca/ean8, false for code128
  layer?: Layer;                  // OCG tagging, as AddImage
  tag?: StructElement;            // logical-structure tagging, as AddImage
}
```

Placement fills `rect` preserving the symbology's geometry: a 1D barcode stretches
its bars across the width at the given height (quiet zones inside the rect when
`quietZone`); a QR matrix is drawn as a centered square. When `text` is on, the
HRI digits occupy a strip at the bottom of the rect and the bars take the
remainder.

## Rendering

- **Vector (default).** Coalesce adjacent dark modules into filled rectangles and
  emit them on a `PageGraphics`: one `re` per bar for 1D, one `re` per dark run
  per row for 2D, all painted with a single `f`. Crisp at any zoom; smallest
  output at typical barcode sizes.
- **Raster.** Build a 1-bit `/ImageMask` stencil XObject (one bit per module,
  MSB-first rows padded to byte boundaries) and paint it in `color`, scaled to
  `rect` with a `cm`. Idiomatic and tiny for barcodes; reuses the XObject and
  own-resources registration used by `imageembed.ts`. No PNG/JPEG encoder needed.

## Human-readable text (HRI)

When `text` is enabled, the payload digits are drawn beneath a 1D barcode via the
existing `Page.AddText` (Standard-14 Helvetica), horizontally sized to the
barcode width. Reuses the text-stamping layer — no new font work. Ignored for QR.

## Testing (`test/barcode.test.ts`)

Strategy: **known-vector fixtures for exact correctness, plus a light 1D
round-trip for scannability** (chosen over shipping a full QR decoder).

1. **Known-vector fixtures** — module output asserted byte-for-byte against
   authoritative references:
   - Code128: the `CODE128` / documented spec sample width sequence.
   - EAN-13, UPC-A, EAN-8: known-good encodings (e.g. `5901234123457`), including
     check-digit computation.
   - QR: the ISO/IEC 18004 Annex worked example (`01234567`, version 1, ECC M)
     matrix, plus a byte-mode string against a reference matrix.
2. **Light round-trip** — a small `decode1D` width-ratio reader in
   `test/helpers/` decodes Code128 / EAN / UPC-A / EAN-8 back to the source
   string, proving scannability cheaply. No QR decoder (QR covered by exact-matrix
   fixtures).
3. **Placement smoke tests** — `AddBarcode` in both `vector` and `raster` mode
   yields a saveable PDF whose page content (or `/XObject` `/ImageMask`) contains
   the expected operators; invalid payloads throw `TypeError` / `PdfParseError`.

Fixtures are built programmatically in `test/helpers/`, matching existing style.

## Docs

Add a "Barcodes" subsection to the README public-API overview describing
`Page.AddBarcode`, the spec/options, and the exported low-level generators.

## Non-goals

- Barcode **recognition / decoding** (deferred to a larger image-processing
  effort).
- Additional symbologies (Code39, PDF417, DataMatrix, Aztec, ITF, etc.).
- Micro-QR and structured-append QR.
