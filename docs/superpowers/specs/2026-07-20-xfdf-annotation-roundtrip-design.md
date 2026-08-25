# XFDF / FDF annotation round-trip

Issue: `aspose-pdf-foss-for-ts-73p`
Builds on: `aspose-pdf-foss-for-ts-e1p` (FDF/XFDF form-data container)

Carry annotations through the two standard data-exchange formats, alongside the
field values that already travel there: the FDF `/Annots` array (PDF object
syntax, PDF 32000-1 §12.7.7) and the XFDF `<annots>` element vocabulary (ISO
19444-1). Self-contained and zero-dependency, layered on the existing
`Annotation` model in `src/annotation.ts` and the container from e1p.

## Scope

In scope: the 18 XFDF annotation types — `text`, `highlight`, `underline`,
`squiggly`, `strikeout`, `square`, `circle`, `line`, `polygon`, `polyline`,
`ink`, `freetext`, `stamp`, `caret`, `sound`, `link`, `fileattachment`,
`popup` — plus the FDF `/Annots` array of annotation dictionaries.

Out of scope, deliberately:

- **Widget annotations.** They are form fields; they travel through the
  `<fields>` / `/Fields` path built in e1p and are excluded from this one
  unconditionally. Exporting a widget twice, in two vocabularies, could only
  produce conflicts on import.
- **Vendor-extension elements.** An element outside the 18 is reported, not
  guessed at. See "Unknown types" below.
- **Page geometry transforms.** `/Rotate` and `/UserUnit` are not applied; see
  "Coordinates".
- **Rendering rich text.** `/RC` is transported verbatim, matching the `/RV`
  treatment e1p gave form fields.

## The neutral model

`formdata.ts` reduces fields to *strings* because XFDF has no type system and a
field value is a scalar. Annotations are structural, not scalar, so reducing
them to strings would mean inventing a third vocabulary that both formats
translate through — and losing whatever neither vocabulary anticipated.

Instead the neutral model **is the PDF annotation dictionary**. XFDF becomes one
more serialization of it; FDF is already that serialization.

```ts
interface AnnotData {
  /** 0-based page index — XFDF's own convention for the page attribute. */
  page: number;
  /** The annotation dict, self-contained: refs to other objects inlined,
   *  except /AP, which stays a stream object. */
  dict: PdfDict;
}
```

`FormData` gains an optional `annots?: AnnotData[]`. One data file can carry
both fields and annotations, which is what real-world XFDF does.

## Architecture

Three new modules, mirroring the e1p split that kept field semantics and format
quirks apart:

| Module | Responsibility | Depends on |
|---|---|---|
| `src/annotdata.ts` | Format-neutral middle. The only module here that touches pages or `/Annots`. | `document.ts`, `page.ts`, `annotation.ts` |
| `src/xfdfannot.ts` | `<annots>` ↔ `AnnotData[]`. Owns the element/attribute table. | `xml.ts`, `types.ts` |
| `src/fdfannot.ts` | `/Annots` subgraph inline (export) and graft (import). | `extractor.ts`, `types.ts` |

`fdf.ts` and `xfdf.ts` stay container-only — they gain a call to read/write the
annotation section and nothing else. That is the split that let e1p be tested
on its own, and it holds here.

### Data flow

```
Export:  doc --collectAnnots(opts)--> AnnotData[] --writeFdf/writeXfdf--> bytes
Import:  bytes --readFdf/readXfdf--> AnnotData[] --applyAnnots--> ImportReport
```

## FDF: deep copy

FDF `/Annots` is an array of annotation dictionaries in PDF syntax, so export is
a subgraph copy rather than a translation.

`src/fdfannot.ts` follows every reference reachable from each annotation dict
and inlines the whole subgraph into the FDF as indirect objects, rewriting refs
to the new numbering. This is built on the existing `cloneShallow` and
`rewriteRefs` primitives in `extractor.ts` — the same pair the page-extraction
path uses — not on new graph machinery.

**As built:** `writeFdf` assembles its output as bytes rather than as a string.
An appearance stream's payload is arbitrary binary, and the previous
string-concatenation path would have latin1-decoded it and then UTF-8 re-encoded
every byte above `0x7F` on the way out — silently corrupting any compressed or
image-bearing appearance. Field values were never exposed to this, because
`serializeString` octal-escapes everything outside printable ASCII.

Consequences, all intended:

- `/AP` and its resource subtree travel as real streams. Fidelity is exact.
- `/Popup` and `/IRT` links between exported annotations survive as refs.
- The FDF is self-contained; import is a graft, needing nothing from the
  originating document.

A reference **out** of the annotation subgraph and into page or document
structure (`/P`, `/Parent`, `/StructParent`) is dropped rather than inlined —
following it would drag the page tree into the data file. `/P` is redundant with
`AnnotData.page`; the structure link cannot be meaningful in another document.

## XFDF: the vocabulary table

One declarative table drives both read and write, so the two directions cannot
drift apart:

```ts
type AttrKind = 'text' | 'name' | 'num' | 'nums' | 'bool' | 'color' | 'date' | 'flags';
interface AttrSpec { attr: string; key: string; kind: AttrKind }
```

**Common to all types:**

| XFDF attribute | Dict key | Kind |
|---|---|---|
| `page` | — (`AnnotData.page`) | num |
| `rect` | `/Rect` | nums |
| `color` | `/C` | color |
| `interior-color` | `/IC` | color |
| `opacity` | `/CA` | num |
| `flags` | `/F` | flags |
| `date` | `/M` | date |
| `creationdate` | `/CreationDate` | date |
| `title` | `/T` | text |
| `subject` | `/Subj` | text |
| `name` | `/NM` | text |
| `intent` | `/IT` | name |

**Per-type:**

| XFDF attribute | Dict key | Types |
|---|---|---|
| `coords` | `/QuadPoints` | highlight, underline, squiggly, strikeout, link |
| `inklist` | `/InkList` | ink |
| `vertices` | `/Vertices` | polygon, polyline |
| `start`, `end` | `/L` | line |
| `head`, `tail` | `/LE` | line |
| `icon` | `/Name` | text, stamp, fileattachment, sound |
| `symbol` | `/Sy` | caret |
| `fringe` | `/RD` | square, circle, caret, freetext |
| `rotation` | `/Rotate` | freetext |
| `width` | `/BS /W` | all with a border |

**Child elements:**

| Element | Dict key |
|---|---|
| `<contents>` | `/Contents` (text) |
| `<contents-richtext>` | `/RC` (verbatim markup) |
| `<defaultappearance>` | `/DA` |
| `<defaultstyle>` | `/DS` |
| `<appearance>` | `/AP` (see below) |
| `<popup>` | nested popup annotation |

Formats: colors are `#RRGGBB`; `flags` is a comma-separated name list
(`print`, `hidden`, `invisible`, `nozoom`, `norotate`, `noview`, `readonly`,
`locked`, `togglenoview`); number lists are comma-separated, and `inklist`
separates subpaths with `;`. Dates are PDF date strings (`D:20260720120000Z`)
in *both* formats, so they pass through verbatim with no conversion.

### Coordinates

Every coordinate — `rect`, `coords`, `vertices`, `inklist`, `start`, `end` — is
in PDF default user space with a bottom-left origin, identical to the dict entry
it maps to. No flipping, scaling, or translation happens in either direction.

`/Rotate` and `/UserUnit` are deliberately not applied. A rotated page's
annotations round-trip in unrotated user space, which is self-consistent and
matches what the dict already holds. Applying the page transform would make
export depend on page state that import cannot verify still holds.

### Unknown types

An element outside the 18 is reported in `skippedAnnots` with
`"unsupported annotation type"`. It is not passed through as a synthesized
`/Subtype`: we would be writing dicts the library cannot render, flatten, or
validate, and a misspelled element name would silently become a bogus
annotation rather than a visible skip.

Within the 18, `sound` and `caret` have no typed class in `annotation.ts`. They
need none — import synthesizes the dict from the attribute table exactly as it
does for the other 16, and export reads the dict directly. The typed classes are
an authoring convenience, not a dependency of this path.

## Appearance transport

FDF gets appearance fidelity for free from the deep copy.

XFDF's `<appearance>` element is base64, but the standard does not pin down the
payload, and producers disagree. Ours is defined explicitly:

> **base64 of the annotation's `/AP` `/N` Form XObject, serialized as a
> single-object PDF fragment** — written by `serialize.ts`, read back by
> `ObjectParser`.

Import treats a payload it cannot parse — a foreign producer's encoding, or
corrupt base64 — as **absent, not as an error**: the element is dropped and the
appearance is regenerated from the annotation's properties. So the round trip is
byte-exact against our own output, and degrades to property fidelity against
anyone else's, which is the best available outcome without a normative encoding
to implement.

This is a deviation from strict interoperability. It is recorded here, and any
further divergence found during implementation gets an **As built:** note in
this spec — the convention e1p used for its XML-module and async-wrapper
deviations.

### Fallback regeneration

When no usable appearance arrives, `/AP` is regenerated from the imported
properties using the existing generators. Those generators are currently welded
into the creation functions in `annotation.ts` (`addMarkup`, `addSquare`,
`addLine`, `addFreeText`, …), which take an options object and build a fresh
annotation; there is no entry point that regenerates for an existing dict.

The implementation extracts appearance *generation* into its own module,
leaving `annotation.ts` with the model and the `Add*` API, and exposes:

```ts
regenerateAppearance(doc: Document, dict: PdfDict): boolean  // false: no generator for this subtype
```

This mirrors the split that already exists between `annotation.ts` and
`annotappearance.ts` (read-only `/AP` *resolution*), and it takes a file that has
grown to 1733 lines back toward one clear purpose. It is a refactor in service of
this feature, not a general cleanup: only the generation functions move.

Subtypes with no generator (`sound`, `caret`, a custom `stamp` with no incoming
appearance) import with no `/AP`. That is reported, not thrown.

## Cross-references between annotations

`/Popup` and `/IRT` point at sibling annotations, which a name-free format
cannot express.

Export assigns every exported annotation a stable `/NM`, minting one where the
document has none, and references siblings by that name: `<popup>` as a nested
child element, `/IRT` as an `inreplyto` attribute.

Import is two-pass — graft every dict first, then resolve names to refs. A name
that resolves to nothing has its key dropped; a dangling `/Popup` is not an
error worth failing an import over.

**As built:** the name-link normalization happens in `annotdata.ts` for *both*
formats, rather than `/Popup` and `/IRT` surviving as refs on the FDF path as
this section originally said. Those keys form a reference cycle (`/Popup` →
popup → `/Parent` → back), and a self-contained dict cannot hold one, so
`collectAnnots` strips them and lifts them into the `popupName` / `inReplyTo`
fields of `AnnotData`; `writeFdfAnnots` rebuilds real refs between the objects
it emits. The outcome is as specified — popup and reply links survive both
formats — by a mechanism that cannot cycle and keeps the two formats symmetric.

## Public API

```ts
// document.ts
ExportFdf(opts?: ExportFormDataOptions): Uint8Array
ExportXfdf(opts?: ExportFormDataOptions): Uint8Array
ImportFdf(bytes: Uint8Array, opts?: ImportOptions): ImportReport
ImportXfdf(bytes: Uint8Array, opts?: ImportOptions): ImportReport

interface ExportFormDataOptions {
  includeEmpty?: boolean;
  file?: string;
  /** Include annotations. Default false. */
  annotations?: boolean;
}

interface ImportOptions {
  /** Apply annotations from the data file. Default false. */
  annotations?: boolean;
}

interface ImportReport {
  imported: string[];
  skipped: { name: string; reason: string }[];
  sourceFile?: string;
  sourceId?: [string, string];
  /** Annotations applied. Empty unless opts.annotations. */
  importedAnnots: { page: number; subtype: string; name?: string }[];
  /** Annotations present in the data file that were not applied. */
  skippedAnnots: { page?: number; subtype?: string; reason: string }[];
}
```

The flag defaults to `false` in both directions, so nothing an existing caller
does changes shape.

### Import semantics

Annotations are matched by `/NM` against the target page's existing `/Annots`:
a match is **replaced**, everything else is **appended**. Importing the same
file twice is therefore idempotent rather than doubling every comment on the
page — the behaviour a round-trip feature has to have.

An annotation whose `page` is out of range is skipped with `"no such page"`.

The four `node.ts` wrappers gain the same options, unchanged in shape otherwise.

## Error handling

Consistent with e1p: `PdfParseError` only for a container that cannot be read at
all. Everything annotation-level is reported.

| Situation | Result |
|---|---|
| Element outside the 18 types | `skippedAnnots`, `"unsupported annotation type"` |
| `page` out of range | `skippedAnnots`, `"no such page"` |
| `page` missing or non-numeric | `skippedAnnots`, `"missing page index"` |
| Malformed coordinate list | `skippedAnnots`, `"malformed <attr>"` |
| Unparseable `<appearance>` | Applied without it; appearance regenerated. Not reported as a skip. |
| No generator for the subtype | Applied with no `/AP`. Not reported as a skip. |
| Dangling `/Popup` or `inreplyto` | Key dropped. Not reported. |

Export from a document with no annotations returns a well-formed data file with
an empty (or absent) annotation section, never an error.

## Testing

Vitest, extending the existing `test/helpers/build-form-pdf.ts` fixture with an
annotation-bearing builder. Format-module tests use literal byte fixtures and
need no PDF.

Round-trip, per format:

- export → import → verify properties, for each of the 18 types
- `/AP` byte-identical across an XFDF round trip (our own `<appearance>`)
- `/AP` byte-identical across an FDF round trip (deep copy)
- `/Popup` and `/IRT` relinked to the right sibling
- rich text (`/RC`) preserved byte-for-byte
- import twice → annotation count unchanged, `/NM` matched and replaced
- widget annotations absent from the export
- `annotations` unset → export contains no annotation section, import applies none

Degradation and skips:

- `<appearance>` with corrupt base64 → imports, `/AP` regenerated, not reported
- subtype with no generator and no appearance → imports without `/AP`
- element outside the 18 → skipped with reason, other annotations still applied
- `page` out of range / missing → skipped with reason
- dangling `inreplyto` → key dropped, annotation still applied

Format-level:

- XFDF attribute formats: `#RRGGBB` color, comma flags, `;` inklist subpaths
- XFDF namespace present and absent (as e1p established)
- FDF subgraph inline: refs rewritten, `/P` and `/StructParent` dropped
- a literal Acrobat-shaped XFDF fixture parses and applies

## Documentation

`README.md` gains the `annotations` option on the four methods, the extended
`ImportReport`, and a Limitations note covering the `<appearance>` encoding
convention and the untransformed-coordinates rule.
