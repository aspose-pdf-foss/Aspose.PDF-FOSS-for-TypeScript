# Annotations + XMP Metadata — Design Spec (Phase 3)

Date: 2026-06-18

## Context

This is **Phase 3** of the content-authoring roadmap
(`docs/superpowers/specs/2026-06-17-content-authoring-design.md`). Phases 1,
1b, 2a, and 2b have shipped on `main`: a buffered `PageGraphics` drawing layer
(`graphics.ts`), shared page-content helpers (`pagecontent.ts`), image
embedding (`imageembed.ts`), text stamping (`stamp.ts`), encrypted `Save`
(`encrypt.ts`), and form-field appearance generation (`appearance.ts` + `da.ts`
+ Standard-14 metrics in `metrics.ts`).

Today the library can *read* annotations only as raw dictionaries:
`Page.Annotations` ([src/page.ts](../../../src/page.ts)) returns `PdfDict[]`.
There is no typed model and no way to **create or edit** annotations. Document
metadata is supported only through the `/Info` dictionary
([src/metadata.ts](../../../src/metadata.ts)); the XMP metadata stream at
`/Root /Metadata` is neither read nor written.

Phase 3 delivers two independent tracks:

1. **Annotations** — a typed model over `/Annots`, plus create/edit/delete and
   four concrete subtype families (text notes, links, text-markup, stamps),
   with `/AP` appearance streams built on the shipped drawing + appearance
   layers.
2. **XMP metadata** — read and write the document-level XMP packet, kept
   consistent with `/Info`.

The tracks share only this spec; they can be implemented in parallel.

## Goals

- A typed `Annotation` model (base class + subclasses) exposing the common
  annotation fields with live setters, mirroring the `Field`/`Page` live-dict
  pattern.
- Typed `Page.Add*` methods to create text notes, links, text-markup
  (highlight/underline/strikeout/squiggly), and stamps; `Page.RemoveAnnotation`
  to delete.
- `/AP` appearance generation for markup and stamp annotations, reusing
  `buildAppearanceXObject`/`installAP` and the `PageGraphics`/`pagecontent`
  machinery — no parallel drawing path.
- `Document.GetXmp`/`SetXmp` for the `/Root /Metadata` XMP packet, with shared
  fields auto-mirrored between `/Info` and XMP.
- Zero runtime dependencies (only `node:` built-ins, already used). XMP is
  parsed and built with a lightweight scan — **no XML library**.

## Non-goals (Phase 3)

- Annotation subtypes other than `Text`, `Link`, the text-markup family
  (`Highlight`/`Underline`/`StrikeOut`/`Squiggly`), and `Stamp`. No `FreeText`,
  `Ink`, `Line`, `Square`/`Circle`, `Polygon`/`PolyLine`, `Popup` management,
  `Sound`/`Movie`/`Screen`, `Redact`, `3D`, or `RichMedia`. (`Widget`
  annotations remain owned by the form code.)
- Blend modes / transparency groups. Highlight appearances use a plain fill and
  rely on `/CA` constant opacity (documented limitation).
- Computing `/QuadPoints` from a text search, and annotation/field
  **flattening** — both deferred to Phase 4.
- Arbitrary custom XMP schemas. v1 reads/writes the known Dublin Core, XMP
  basic, and PDF schemas; the original packet's `raw` text is preserved for
  round-tripping but not structurally edited beyond those schemas.
- CMYK / ICC / Separation colors. Annotation colors are DeviceRGB `0..1` only
  (matching the drawing-layer non-goals).

## Module A — Annotation model & read API

### Public surface

```ts
// page.ts — BREAKING: return type changes from PdfDict[] to Annotation[]
get Annotations(): Annotation[]
```

`Page.Annotations` now returns typed wrappers. Each element is an instance of
`Annotation` or one of its subclasses, chosen by `/Subtype`; an unrecognized
subtype yields a base `Annotation`. Every wrapper still exposes `.Dict` as a raw
escape hatch, so callers who relied on the old `PdfDict[]` can read
`page.Annotations.map(a => a.Dict)`.

### Class hierarchy (`src/annotation.ts`)

```ts
class Annotation {
  constructor(doc: Document, dict: PdfDict);   // live-dict handle
  get Dict(): PdfDict;                          // raw escape hatch
  get Subtype(): string;                        // read-only, from /Subtype

  get Rect(): [number, number, number, number];
  set Rect(r): void;                            // /Rect — 4 finite numbers
  get Color(): [number, number, number] | undefined;
  set Color(c): void;                           // /C — RGB 0..1, undefined deletes
  get Contents(): string | undefined;
  set Contents(s): void;                        // /Contents (text string)
  get Name(): string | undefined;
  set Name(s): void;                            // /NM (annotation name)
  get ModDate(): Date | string | undefined;
  set ModDate(d): void;                         // /M
  get Flags(): number;
  set Flags(n): void;                           // /F bitfield
  get Print(): boolean;  set Print(b): void;    // /F bit 3 (value 4)
  get Hidden(): boolean; set Hidden(b): void;   // /F bit 2 (value 2)
  get Opacity(): number | undefined;
  set Opacity(a): void;                         // /CA — 0..1
}

class TextAnnotation extends Annotation {        // /Subtype /Text
  get Icon(): string | undefined;  set Icon(s): void;   // /Name
  get Open(): boolean;             set Open(b): void;    // /Open
}

class LinkAnnotation extends Annotation {        // /Subtype /Link
  get Action(): LinkAction | undefined;          // parsed from /A (URI / GoTo)
  get Dest(): OutlineDest | undefined;           // parsed from /Dest (reuses outline.ts parseDest)
}

class MarkupAnnotation extends Annotation {      // /Highlight|/Underline|/StrikeOut|/Squiggly
  get MarkupType(): 'highlight' | 'underline' | 'strikeout' | 'squiggly';
  get QuadPoints(): number[];  set QuadPoints(q): void;  // /QuadPoints (8*n)
}

class StampAnnotation extends Annotation {       // /Subtype /Stamp
  get StampName(): string | undefined;  set StampName(s): void;  // /Name
}
```

Validation matches `stamp.ts`/`page.ts` style: setters throw `TypeError` on
non-finite numbers, wrong array lengths, or out-of-range colors/opacity. Date
reads reuse `parsePdfDate`; date writes reuse `formatPdfDate`. Text reads/writes
reuse `decodePdfText`/`encodePdfText`.

`wrapAnnotation(doc, dict): Annotation` is the internal factory that selects the
subclass from `/Subtype`.

## Module B — Annotation create / edit / delete

### Public surface (`src/page.ts`)

```ts
AddTextNote(opts: TextNoteOptions): TextAnnotation;
AddLink(opts: LinkOptions): LinkAnnotation;
AddHighlight(opts: MarkupOptions): MarkupAnnotation;
AddUnderline(opts: MarkupOptions): MarkupAnnotation;
AddStrikeOut(opts: MarkupOptions): MarkupAnnotation;
AddSquiggly(opts: MarkupOptions): MarkupAnnotation;
AddStamp(opts: StampOptions): StampAnnotation;
RemoveAnnotation(a: Annotation | PdfDict): void;

interface TextNoteOptions {
  rect: [number, number, number, number];
  contents?: string;
  icon?: string;          // /Name — Note (default), Comment, Help, Insert, Key, …
  open?: boolean;         // default false
  color?: [number, number, number];
  author?: string;        // /T
}
interface LinkOptions {
  rect: [number, number, number, number];
  action: GoToAction | UriAction;
  border?: number;        // border width in points; default 0 (invisible)
}
type GoToAction = { type: 'goto'; page: number; view?: OutlineView };
type UriAction  = { type: 'uri'; uri: string };
type LinkAction = GoToAction | UriAction;       // also the LinkAnnotation.Action read type
// `view` reuses outline.ts's OutlineView; GoTo dests are encoded via encodeDest.

interface MarkupOptions {
  quads: number[];        // /QuadPoints, length a multiple of 8
  color?: [number, number, number];   // default yellow for highlight, black otherwise
  contents?: string;
  opacity?: number;       // /CA, 0..1
}
interface StampOptions {
  rect: [number, number, number, number];
  name?: string;          // standard stamp name (Approved, Confidential, Draft, …)
  text?: string;          // custom text stamp (mutually exclusive with image)
  image?: Uint8Array;     // custom image stamp (JPEG/PNG, reuses AddImage)
  color?: [number, number, number];   // frame/text color for text/standard stamps
}
```

### Shared create behaviour

Every `Add*` allocates a dict via `Document.allocObject`, sets `/Type /Annot`,
the appropriate `/Subtype`, the validated `/Rect`, `/F` = **Print (4)** by
default, `/M` = current time (`formatPdfDate`), and `/P` → the page's own
indirect reference. The new ref is appended to the page's **own** `/Annots`
array (created when absent; the inherited/parent array is never mutated). The
method returns the corresponding typed wrapper.

`RemoveAnnotation` removes the matching ref from the page's `/Annots`
(comparing by dict identity, accepting either an `Annotation` or a raw
`PdfDict`); it is a no-op if the annotation is not on the page.

The four markup methods are thin wrappers over one private builder that differs
only by `/Subtype` and the appearance-drawing routine.

### Validation & errors

- `rect` / `quads` / `color` must be finite numbers of the right length →
  `TypeError`.
- `quads.length` must be a positive multiple of 8 → `TypeError`.
- `AddStamp` with both `text` and `image`, or with neither `name`/`text`/`image`
  → `TypeError`.
- Unsupported stamp image (CMYK JPEG, interlaced PNG, …) → whatever `AddImage`
  already throws (`UnsupportedFeatureError`/`PdfParseError`).

## Module C — Appearance generation

Reuses `buildAppearanceXObject(doc, geom, std, fontKey, body)` and `installAP`
from [src/appearance.ts](../../../src/appearance.ts), plus the operator-string
conventions used by `PageGraphics`/`stamp.ts`. Appearance bodies are composed as
PDF content fragments and formatted with the shared `num()` from `pagecontent.ts`.

- **Text, Link:** no `/AP`. Viewers render the text-note icon natively, and a
  link with `border = 0` is intentionally invisible.
- **Markup:** build a `/AP /N` Form XObject whose `/BBox` is the bounding box of
  `/QuadPoints`.
  - *Highlight:* fill each quad with `/C` (default yellow) at `/CA` opacity —
    plain fill, no blend mode.
  - *Underline / StrikeOut:* stroke a horizontal line across each quad at the
    bottom / vertical-middle.
  - *Squiggly:* stroke a zig-zag along the bottom of each quad.
- **Stamp:**
  - *Custom text* / *standard name:* a framed label appearance — a stroked
    border plus the text centered via `metrics.ts` measurement (standard-name
    stamps use the name as the label, since Acrobat's stamp artwork is not
    shipped).
  - *Custom image:* build the image XObject through the `AddImage` pipeline
    (`imageembed.ts`) and emit `q  w 0 0 h 0 0 cm /Im Do  Q` inside the
    appearance form, registering the XObject in the form's `/Resources`.

All generated appearances honor `/CA` via a reused `/ExtGState` (the existing
`registerExtGState` helper) when opacity `< 1`.

## Module D — XMP metadata

### Public surface (`src/document.ts`)

```ts
GetXmp(): XmpMetadata;
SetXmp(update: XmpUpdate): void;

interface XmpMetadata {
  title?: string;                 // dc:title
  authors?: string[];             // dc:creator (ordered)
  description?: string;           // dc:description
  subjects?: string[];            // dc:subject (keywords as a bag)
  keywords?: string;              // pdf:Keywords
  creatorTool?: string;           // xmp:CreatorTool
  producer?: string;              // pdf:Producer
  createDate?: Date | string;     // xmp:CreateDate
  modifyDate?: Date | string;     // xmp:ModifyDate
  rights?: string;                // dc:rights — XMP-only example field
  raw?: string;                   // original packet text, preserved on read
}
type XmpUpdate = {
  [K in keyof Omit<XmpMetadata, 'raw'>]?: XmpMetadata[K] | null;  // null deletes
};
```

### Read (`src/xmp.ts`)

`readXmp(bytes): XmpMetadata` decodes the `/Root /Metadata` stream (Flate-decoded
when `/Filter /FlateDecode` is present, though XMP packets are conventionally
stored uncompressed) and scans it for the known schema elements with a small set
of tag patterns — no XML parser. RDF container values (`rdf:Alt`/`rdf:Bag`/
`rdf:Seq`) are read by collecting their `rdf:li` items. Dates parse via ISO-8601
(`new Date(...)`, falling back to the raw string). Malformed or partial XMP is
read **leniently**: unparseable fields are skipped, never thrown, and the full
packet text is returned in `raw`.

`Document.GetXmp()` returns an empty `XmpMetadata` (`{}`) when no `/Metadata`
stream exists.

### Write (`src/xmp.ts` + `document.ts`)

`buildXmp(meta): string` emits a well-formed packet:
`<?xpacket begin?> … <x:xmpmeta><rdf:RDF><rdf:Description …> … </rdf:Description>
</rdf:RDF></x:xmpmeta> … <?xpacket end?>`, with proper XML escaping. `SetXmp`
merges the update over the current `GetXmp()` value (`null` deletes a field),
rebuilds the packet, and installs it as a `/Type /Metadata /Subtype /XML` stream
(uncompressed) at `/Root /Metadata` via `allocObject`. `Save()`'s mark-sweep
serializes the new stream with no serializer change.

### Auto-mirror between `/Info` and XMP

Shared fields are written to **both** dictionaries from a single normalized
update, so the two never drift:

| Logical field   | `/Info` key      | XMP property        |
|-----------------|------------------|---------------------|
| title           | `/Title`         | `dc:title`          |
| author          | `/Author`        | `dc:creator`        |
| subject         | `/Subject`       | `dc:description`    |
| keywords        | `/Keywords`      | `pdf:Keywords`      |
| creator (tool)  | `/Creator`       | `xmp:CreatorTool`   |
| producer        | `/Producer`      | `pdf:Producer`      |
| creationDate    | `/CreationDate`  | `xmp:CreateDate`    |
| modDate         | `/ModDate`       | `xmp:ModifyDate`    |

`SetMetadata` continues to update `/Info` and *additionally* writes the
overlapping fields into the XMP packet (creating it if needed). `SetXmp`
likewise writes the overlapping fields back into `/Info`. To avoid recursion,
both paths funnel through one internal routine that writes each side once;
XMP-only fields (e.g. `dc:rights`) are left untouched in `/Info`, and
`/Info`-only custom keys are left untouched in XMP. `/Info` strings are scalar,
so the mirror joins `dc:creator` items with `, ` when projecting to `/Author`.

## Data flow

```
page.AddHighlight(opts) ─▶ alloc /Annot dict ─▶ append to page /Annots
                               │
                               ├─▶ buildAppearanceXObject(...) ─▶ /AP /N
                               └─▶ MarkupAnnotation wrapper (returned)

doc.SetMetadata(update) ─┬─▶ applyUpdate(/Info, update)        (existing)
                         └─▶ mirror shared fields ─▶ buildXmp ─▶ /Root /Metadata

doc.SetXmp(update) ──────┬─▶ merge over GetXmp() ─▶ buildXmp ─▶ /Root /Metadata
                         └─▶ mirror shared fields ─▶ /Info

Save() mark-sweeps /Root (+ /Info) ─▶ new annot/AP/XObject/Metadata objects serialized
```

## Testing

TDD with vitest; fixtures built programmatically in `test/helpers/`.

- **Annotation model:** build a page with mixed annotation subtypes; assert
  `Page.Annotations` returns the right subclass per `/Subtype`, that getters
  decode `/Rect`/`/C`/`/Contents`/`/F`/dates, and that `.Dict` exposes the raw
  dict. Assert setter round-trips mutate the live dict.
- **Create/delete:** for each `Add*`, assert the new dict's `/Type`/`/Subtype`/
  `/Rect`/`/F`/`/M`/`/P`, that it lands in the page's own `/Annots`, and that a
  `Save()`→`Open()` round-trip reads it back through the typed accessor. Assert
  `RemoveAnnotation` removes exactly the target. Assert `TypeError` on bad
  geometry/color/quads and the `AddStamp` argument constraints.
- **Appearances:** parse the generated `/AP /N` stream with
  `parseContentStream` and assert the expected fill/stroke/`Do` operators and
  `/BBox`; assert highlight uses `/CA`; assert image stamps register an XObject
  reachable by the existing image extractor.
- **Links:** assert `/A /URI` and `/A /GoTo /D` (and the `LinkAnnotation.Action`/
  `.Dest` read side, reusing `outline.ts` dest resolution).
- **XMP:** craft fixtures with and without an existing packet; assert
  `GetXmp()` parses dc/xmp/pdf fields and ordered `dc:creator`/`dc:subject`;
  assert `buildXmp` round-trips through `readXmp`; assert malformed XMP reads
  leniently; assert the `/Info`↔XMP mirror in both directions
  (`SetMetadata`→XMP, `SetXmp`→`/Info`) and that XMP-only/`/Info`-only fields are
  left alone.

New helpers: `test/helpers/build-annot-target.ts`, `test/helpers/build-xmp-pdf.ts`.

## Public API / docs

- `index.ts` exports `Annotation`, `TextAnnotation`, `LinkAnnotation`,
  `MarkupAnnotation`, `StampAnnotation`, the option interfaces, `XmpMetadata`,
  and `XmpUpdate`.
- README: add "Annotations" and "XMP metadata" subsections; update the Features
  list and API-overview table; note the **breaking change** to
  `Page.Annotations` and the new error cases; remove annotations/XMP from the
  Limitations section as appropriate.

## Files

- New: `src/annotation.ts` (model + subclasses + create/edit helpers),
  `src/xmp.ts` (parse/build), `test/helpers/build-annot-target.ts`,
  `test/helpers/build-xmp-pdf.ts`, `test/annotation.test.ts`, `test/xmp.test.ts`.
- Changed: `src/page.ts` (typed `Annotations`, `Add*`, `RemoveAnnotation`),
  `src/document.ts` (`GetXmp`/`SetXmp`, mirror in `SetMetadata`),
  `src/index.ts`, `README.md`.

## Implementation sequencing (beads)

Epic `aspose-pdf-foss-for-ts-tum`. This spec is `…-crz`.

```
crz (spec) ─┬─▶ tpa  Annotation model + read API
            │        └─▶ pjo  Lifecycle (create/edit/delete)
            │                 ├─▶ fu3  Text (sticky note) annotations
            │                 ├─▶ c9p  Link annotations (GoTo + URI)
            │                 ├─▶ vpm  Markup (highlight/underline/strikeout/squiggly)
            │                 └─▶ 82t  Stamp annotations + appearance
            └─▶ rwn  XMP metadata read
                     └─▶ 82q  XMP metadata write / sync
```

Each downstream issue gets its own plan under `docs/superpowers/plans/`.
