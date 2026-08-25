# PDF/X validation + conversion — design

Issue: `aspose-pdf-foss-for-ts-i9n`. Date: 2026-07-21.

Print-production conformance (ISO 15930) built on the PDF/A validator/converter
architecture: a `Rule[]` list over a read-only context, a `Pass[]` list that
mutates the live model, and the shared `ValidationReport` / `ConversionReport`.

## Scope

Levels: **X-1a** (ISO 15930-4, CMYK/spot only, no transparency), **X-3**
(ISO 15930-6, device-independent color allowed), **X-4** (ISO 15930-7,
transparency and optional content allowed), **X-4p** (X-4 with the output-intent
profile referenced externally rather than embedded).

Out of scope: X-5 (partial exchange), color-managed rendering, transparency
flattening, raster image color conversion.

## API surface

```ts
export type PdfXLevel = '1a' | '3' | '4' | '4p';

doc.ValidatePdfX(level: PdfXLevel): ValidationReport
doc.ConvertToPdfX(level: PdfXLevel, opts?: PdfXConvertOptions): ConversionReport

interface PdfXConvertOptions {
  /** Embed this profile as /DestOutputProfile. Omitted → registered-name intent. */
  iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
  /** Registered characterization name when no profile is embedded. Default 'CGATS TR 001'. */
  outputCondition?: string;
  /** External profile URL/filename — required for '4p' when no profile is embedded. */
  outputProfileRef?: string;
  /** /Info /Trapped value to write when absent. Default 'False'. */
  trapped?: 'True' | 'False';
  /** Opt-in naive DeviceRGB → DeviceCMYK content rewrite. Default false. */
  convertColor?: boolean;
  /** Destructive-removal categories to skip (then reported unresolved). */
  preserve?: ConvertCategory[];
}
```

No new report types: `ValidationReport` and `ConversionReport` are reused as-is,
so the PDF/X APIs mirror `ValidatePdfA` / `ConvertToPdfA` exactly. `PdfXLevel`
and `PdfXConvertOptions` are exported from `index.ts` beside `PdfALevel`.

The bundled sRGB profile (`srgb.ts`) is **not** a usable default here: X-1a needs
a CMYK print condition. Rather than bundle a multi-megabyte CMYK ICC profile, the
default conversion emits an output intent carrying only a registered
characterization name (`/OutputConditionIdentifier`, default `CGATS TR 001`),
which ISO 15930 permits in place of an embedded `/DestOutputProfile`. Callers
who need an embedded profile pass `iccProfile`.

## Module layout

The shared scan machinery is hoisted out of `pdfavalidate.ts` into a neutral
module, following the codebase's format-neutral-middle pattern (`formdata.ts`,
`annotdata.ts`):

- **`validatectx.ts`** (new): `Ctx`, `memo`, `filterNames`, `allObjects`,
  `nameOf`, `pageScans` / `PageScan`, `extGStates`, `eachAnnotation`,
  `blendModeName`, `xmpText`, `enumerateFonts`, `hasFontProgram`, plus the rule
  bodies both standards share (encryption, external streams, PostScript and
  reference XObjects, font embedding) as parameterized predicates. `Ctx` becomes
  generic — `part`/`level` move to a PDF/A-specific `ACtx extends Ctx`.
- **`pdfavalidate.ts`**: keeps its `Rule[]` and entry point only (~550 lines
  after the move), re-exporting the moved helpers so downstream imports keep
  working.
- **`pdfxvalidate.ts`** (new): `PdfXLevel`, `XCtx extends Ctx { level }`, the
  PDF/X `Rule[]`, and `validatePdfX(doc, catalog, level)`.
- **`pdfxconvert.ts`** (new): the `Pass[]` and
  `convertToPdfX(doc, catalog, level, opts)`, mirroring `pdfaconvert.ts`.
- **`pdfxcolor.ts`** (new): the opt-in `DeviceRGB → DeviceCMYK` content rewrite
  over `editcontent.ts`, isolated so the default path never loads it.

`document.ts` gains `ValidatePdfX` / `ConvertToPdfX` next to the PDF/A pair,
passing the catalog the same way.

### PageScan extension

`PageScan.usesDeviceColor: boolean` becomes `colorSpaces: Set<string>` holding
the space names actually seen (`DeviceRGB`, `DeviceCMYK`, `DeviceGray`,
`ICCBased`, `CalRGB`, `Lab`, `Separation`, `DeviceN`, `Indexed`). X-1a's rule is
per-space, not "device or not". PDF/A's two existing callers reduce over the set
(`DeviceGray|DeviceRGB|DeviceCMYK` present ⇒ the old boolean), so their behavior
is unchanged.

## Rule table

| Rule | 1a | 3 | 4 / 4p |
|---|---|---|---|
| `PdfxIdentification` — XMP `pdfxid:GTS_PDFXVersion`; plus `/Info /GTS_PDFXVersion` for 1a/3 | ✓ | ✓ | ✓ |
| `OutputIntent` — exactly one `S=GTS_PDFX`, with embedded `/DestOutputProfile` **or** registered `/OutputConditionIdentifier`; `4p` also accepts `/DestOutputProfileRef` | ✓ | ✓ | ✓ |
| `OutputIntentColor` — profile `/N` is 4 or 1 | ✓ | – | – |
| `Trapped` — `/Info /Trapped` is `True` or `False`, never `Unknown` or absent | ✓ | ✓ | ✓ |
| `PageGeometry` — every page has `/TrimBox` or `/ArtBox` (not both); `/BleedBox` ⊆ `/MediaBox` | ✓ | ✓ | ✓ |
| `FontEmbedded` — PDF/A's logic unchanged | ✓ | ✓ | ✓ |
| `Encryption`, `ExternalStream`, `PostScriptXObject`, `ReferenceXObject` — reused | ✓ | ✓ | ✓ |
| `ProhibitedColor` — no `DeviceRGB` / `CalRGB` / `Lab` / `ICCBased` | ✓ | – | – |
| `ColorWithoutIntent` — a device space whose component count disagrees with the output-intent profile's `/N` (e.g. `DeviceRGB` under an `N=4` CMYK intent) | – | ✓ | ✓ |
| `Transparency` — groups, `/SMask`, non-`Normal` `/BM`, `CA`/`ca` < 1 | ✓ | ✓ | – |
| `OptionalContent` — `/OCProperties` present | ✓ | ✓ | – |
| `Annotations` — must sit outside `/TrimBox` ∪ `/BleedBox`; prohibited subtypes | ✓ | ✓ | ✓ |
| `Actions` — no JavaScript / Launch / embedded-file / URI actions | ✓ | ✓ | ✓ |
| `EmbeddedFiles` — `/Names /EmbeddedFiles` or `/FileAttachment` present | ✓ | ✓ | – |
| `TransferHalftone` — no `/TR`, `/TR2`, `/HTP`; halftone types 1 and 5 only | ✓ | ✓ | ✓ |
| `Filters` — no `LZWDecode`; no `JPXDecode` for 1a/3 | ✓ | ✓ | partial |
| `Version` — header/catalog ceiling 1.4 for 1a/3, 1.6 for 4 | ✓ | ✓ | ✓ |

Each issue carries an ISO 15930 clause reference in `ValidationIssue.clause`.

## Converter passes

Structural passes, in order — most delegate to the corresponding PDF/A pass body:

1. `identificationPass` — XMP `pdfxid:GTS_PDFXVersion` plus `/Info /GTS_PDFXVersion` for 1a/3.
2. `outputIntentPass` — registered-name form by default; embedded `/DestOutputProfile` when `iccProfile` is given; `/DestOutputProfileRef` for `4p`.
3. `trappedPass` — write `/Info /Trapped` when absent or `Unknown`.
4. `pageGeometryPass` — `/TrimBox` ← `/CropBox` ← `/MediaBox` when absent.
5. `fileIdPass`, `versionPass` — reused from `pdfaconvert.ts`.
6. `annotationPass` — drop prohibited subtypes; annotations overlapping the trim area are **reported, never moved**.
7. `actionsPass`, `embeddedFilesPass`, `optionalContentPass` — reused, gated by level.
8. `transferHalftonePass` — strip `/TR`, `/TR2`, `/HTP`; strip non-conformant halftones.
9. `colorPass` — **only when `opts.convertColor`**.

`colorPass` performs a naive `1 − c` `DeviceRGB → DeviceCMYK` rewrite of `rg`,
`RG`, `sc`, `scn` operators and `DeviceRGB` colorspace resources through
`editcontent.ts`. It is documented as approximate and unsuitable for
color-critical work: without the destination profile the result is not
colorimetrically correct. Raster images are not rewritten — an RGB image still
lands in `unresolved`.

### Not attempted

Reported as unresolved errors naming the offending page or object, never
silently fixed:

- Live transparency for X-1a/X-3 — there is no flattener in the library.
- Fonts with no embeddable program.
- RGB raster images under X-1a.
- Annotations overlapping the trim area (moving them changes the printed page).

This is the decidable-subset caveat the acceptance criteria require documenting:
`ConvertToPdfX` reaches structural conformance, and `passed: false` with a
populated `unresolved` list is a legitimate and expected outcome.

## Testing

`test/helpers/build-pdfx-pdf.ts` builds a minimal conformant X-1a / X-3 / X-4
document with knobs to violate exactly one rule at a time.
`test/pdfxvalidate.test.ts` and `test/pdfxconvert.test.ts` mirror the existing
PDF/A tests in structure and style.

Every rule must be proven load-bearing: break the code path it covers and confirm
the suite goes red. A rule that passes on the first run is not yet evidence of
anything.

One real-world fixture in `test/fixtures/pdfx/` — a genuine PDF/X file from
Ghostscript's `-dPDFX` output — asserted to validate clean, with a
`PROVENANCE.md` recording producer and version, the exact command, SHA-256 of
input and output, and what the fixture does and does not cover. This covers the
one class the builders cannot: our validator and our builder agreeing with each
other and both disagreeing with ISO 15930.

## Documentation

`README.md` gains PDF/X to its Features and API overview sections, and the
decidable-subset caveat to Limitations. `CLAUDE.md`'s architecture list gains
`pdfxvalidate.ts` / `pdfxconvert.ts` / `pdfxcolor.ts` / `validatectx.ts`.

## Known risk

The rule table is written from working knowledge of PDF/X, not from the ISO 15930
text. Some entries are likely wrong in detail — most probably:

- the registered-name-without-embedded-profile allowance, which the entire
  default conversion path rests on;
- X-4's position on embedded files and `JPXDecode`;
- the exact `/Info` versus XMP identification split per level.

Two mitigations. The Ghostscript fixture fails loudly if we over-enforce against
real conformant output. And any rule whose clause cannot be substantiated during
implementation ships as `severity: 'warning'`, not `'error'`, so an unverified
rule can never wrongly fail a good document.
