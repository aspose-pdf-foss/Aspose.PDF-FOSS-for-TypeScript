# PDF/A conversion / remediation — design

**Date:** 2026-06-29
**Status:** Approved (design); plan pending
**Scope:** Second sub-project of the "PDF/A conformance" epic. Builds on the
PDF/A validator ([pdfavalidate.ts](../../../src/pdfavalidate.ts), shipped) to
remediate a document toward conformance, then re-validate.

## Context

The validator `doc.ValidatePdfA(level)` reports a curated, machine-decidable set
of PDF/A defects with stable rule ids. This sub-project adds the write
counterpart: `doc.ConvertToPdfA(level, opts)` mutates the live model to fix the
defects it can fix deterministically, then re-runs the validator so the returned
report is exactly as honest as the validator itself.

The library is pure TypeScript, zero runtime dependencies, no rendering. So
remediations requiring rendering (transparency flattening), external assets
(embedding a font whose program is absent), or codecs the library lacks
(LZW/JPX/JBIG2 transcoding) are out of scope and are reported as **unresolved**
rather than attempted.

Existing infrastructure this builds on:

- `validatePdfA(doc, catalog, level)` and the shared `ValidationIssue` /
  `ValidationReport` types ([validation.ts](../../../src/validation.ts)).
- XMP read/build ([xmp.ts](../../../src/xmp.ts)); `buildXmp` currently emits
  dc/xmp/pdf properties but **not** the PDF/A identification schema.
- Form-field and annotation appearance generation
  ([appearance.ts](../../../src/appearance.ts), [form.ts](../../../src/form.ts),
  [annotation.ts](../../../src/annotation.ts)); `doc.FlattenForm` /
  field appearance regeneration already exist.
- Simple-font encodings and the Adobe-glyph-name→Unicode resolver
  ([encoding.ts](../../../src/encoding.ts)) for `/ToUnicode` synthesis.

## Goals

1. `doc.ConvertToPdfA(level, opts?)` targets `b` (parts 1/2/3) and `u` (parts
   2/3), applies every deterministic remediation, removes prohibited constructs
   that can only be removed, and returns a `ConversionReport` listing what was
   applied and what remains unresolved.
2. The report's `unresolved` is **exactly** the set of `ValidatePdfA(level)`
   errors remaining after conversion — conversion never claims a fix the
   validator would not confirm.
3. Destructive removals are on by default (so output actually converges) and
   recorded; `opts.preserve` opts specific categories out (they then appear as
   `unresolved`).

## Non-goals (reported unresolved, not attempted)

- Embedding a font whose program is absent (`FontEmbedded`).
- Flattening transparency for part 1 (`Transparency`) — the message suggests
  targeting part 2/3.
- Transcoding LZW/JPX/JBIG2 streams (`LZW`, `ImageFilter`) — no codec.
- Resolving external streams (`ExternalStream`) or reference XObjects
  (`ReferenceXObject`); fixing a malformed `/ICCBased` N (`ICCBasedN`);
  synthesizing `/CIDSet` (`FontCIDSet`).
- Level `a` (auto-tagging untagged content) — separate future sub-project.
- `Encryption` is not a remediation step: `Save()` always emits unencrypted
  output, so re-validation never sees `/Encrypt`.

## Approach

New module `src/pdfaconvert.ts` exposes
`convertToPdfA(doc, catalog, level, opts): ConversionReport`. The facade
`Document.ConvertToPdfA(level, opts)` supplies the catalog (mirroring
`ValidatePdfA`).

The engine runs an ordered list of remediation passes. Each pass is a pure-ish
function `(ctx) => ConvertAction[]` that mutates the live model and returns the
actions it performed; the engine concatenates them into `applied`. Passes
self-gate by part/level and consult `opts.preserve`. After all passes:

```
applied = passes.flatMap(run)
unresolved = validatePdfA(doc, catalog, level).Errors
report = { applied, unresolved, passed: unresolved.length === 0 }
```

A per-run context carries the resolved catalog, parsed `{ part, level }`, the
resolved ICC profile (caller's or bundled sRGB), the `preserve` set, and a bound
`resolve`.

Rejected alternatives: a separate "what changed" diff mechanism (the validator
re-run is simpler and authoritative); producing a new `Document` rather than
mutating in place (inconsistent with the library's live-mutation model).

## Public API

```ts
// document.ts
ConvertToPdfA(level: PdfALevel, opts?: ConvertOptions): ConversionReport;

// pdfaconvert.ts
export type ConvertCategory =
  | 'javascript' | 'multimedia' | 'embeddedFiles' | 'xfa' | 'optionalContent'
  | 'postScript';

export interface ConvertOptions {
  /** Output-intent ICC profile. Defaults to a bundled public-domain sRGB. */
  iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
  /** Destructive-removal categories to skip (then reported unresolved). */
  preserve?: ConvertCategory[];
}

export interface ConvertAction {
  /** Validator rule id this addresses, e.g. 'OutputIntent'. */
  rule: string;
  /** What was done, human-readable, e.g. 'Added sRGB OutputIntent'. */
  action: string;
  /** Located object/page when applicable. */
  object?: PdfRef;
  page?: Page;
}

export interface ConversionReport {
  applied: ConvertAction[];
  unresolved: ValidationIssue[];   // == ValidatePdfA(level).Errors post-conversion
  passed: boolean;                 // unresolved.length === 0
}
```

## Remediation passes

Each row names the validator rule(s) it targets.

### Additive / clearing (no data loss)

| pass | rules | behavior |
|---|---|---|
| identification XMP | `Metadata`, `PdfaIdentification`, `XmpInfoConsistency` | merge XMP: set `pdfaid:part`/`conformance` for the target; copy `/Info` `Title`/`Author`/`Subject`/`Keywords` into the matching XMP fields so they agree |
| output intent | `OutputIntent`, `DeviceColorWithoutIntent` | if no PDF/A `/OutputIntents` entry, add one (`/S /GTS_PDFA1`, `/OutputConditionIdentifier`, `/DestOutputProfile` = the resolved ICC stream) |
| version | `Version` | set catalog `/Version` to the part ceiling (`1.4` part 1, `1.7` parts 2/3) when the current version exceeds it; ensure the serialized header matches |
| file id | `FileID` | if the trailer has no `/ID`, generate a 16-byte id pair |
| annotation flags | `AnnotationFlags`, `AnnotationOpacity` | set the Print bit, clear Hidden/NoView/Invisible on every annotation `/F`; set `/CA`→1 (part 1) |
| forms | `NeedAppearances` | regenerate field appearances, then set AcroForm `/NeedAppearances` false (delete the key) |
| annotation appearances | `AnnotationAppearance` | generate `/AP /N` for fields and stamp/markup annotations via the appearance layer; annotations it cannot build are left for the validator to report |
| cosmetic | `BlendMode`, `ImageInterpolate`, `RenderingIntent`, `FontEncoding` | reset non-standard ExtGState `/BM`→`/Normal`; image `/Interpolate`→false; non-standard rendering intents (image `/Intent` and content `ri` operands)→`/RelativeColorimetric`; drop `/Encoding` from symbolic TrueType fonts |
| toUnicode (level u) | `ToUnicode` | for each simple font lacking `/ToUnicode` that has a standard or `/Differences` encoding, synthesize and attach a `/ToUnicode` CMap from the encoding→Unicode tables; fonts that cannot be mapped are left to the validator |

### Removals (default on; `opts.preserve` opts out, then reported unresolved)

| pass | category | rules | behavior |
|---|---|---|---|
| javascript/actions | `javascript` | `Actions`, `AdditionalActions` | delete prohibited actions from `/OpenAction`, annotation/field `/A`, every `/AA` slot, and the `/Names /JavaScript` tree; part 1 deletes `/AA` entirely |
| multimedia annots | `multimedia` | `AnnotationSubtype` | remove `/Movie`/`/Sound`/`/Screen`/`/3D`/`/RichMedia` annotations from their pages' `/Annots` |
| xfa | `xfa` | `XFA` | delete `/AcroForm /XFA` |
| optional content | `optionalContent` | `OptionalContent` (part 1) | delete catalog `/OCProperties` and `/OCGs`/`/OCMD` `/OC` keys on XObjects/annotations (best-effort; marked-content `/OC … BDC` left in place, harmless once `/OCProperties` is gone) |
| embedded files | `embeddedFiles` | `EmbeddedFiles` | part 1: remove the `/Names /EmbeddedFiles` tree and `/FileAttachment` annots; parts 2/3: set `/AFRelationship` (default `/Unspecified`) on each spec lacking one |
| postscript xobjects | `postScript` | `PostScriptXObject` | remove `/Subtype /PS` XObjects from resources |

### Report-only (always unresolved when present)

`FontEmbedded`, `Transparency` (part 1), `LZW`, `ImageFilter`,
`ExternalStream`, `ReferenceXObject`, `ICCBasedN`, `FontCIDSet`. These passes do
not exist; the rules simply remain after conversion and surface in `unresolved`.
For part-1 `Transparency`, the validator's existing message stands; conversion
adds no special hint mechanism (a plain unresolved issue, whose message already
references part-1 transparency limits, is sufficient).

## Enabling changes

- **`xmp.ts`** — add `pdfaPart?: number` and `pdfaConformance?: string` to
  `XmpMetadata`; `buildXmp` emits an `rdf:Description` carrying
  `xmlns:pdfaid` + `pdfaid:part`/`pdfaid:conformance` when set; `readXmp` parses
  them back (so round-trips and `XmpUpdate` work). Additive; existing callers
  unaffected.
- **`src/srgb.ts`** — a committed public-domain sRGB ICC profile as a base64
  constant plus a decoder to `Uint8Array` and its `n` (3). Data, not a runtime
  dependency. Used as the default `iccProfile`.
- **`src/pdfaconvert.ts`** — the engine, passes, and `ConvertToPdfA` types.
  Depends on `validation.ts`, `pdfavalidate.ts` (re-validate), `xmp.ts`
  (identification), `appearance.ts`/`form.ts` (appearances), `encoding.ts`
  (`/ToUnicode` synthesis), `srgb.ts` (default profile), `content.ts` (rewriting
  `ri` operands).

## Module boundaries

- `pdfaconvert.ts` owns the passes and report assembly; each pass is an
  independently-testable function with no shared mutable state beyond `ctx` and
  the document it mutates.
- `document.ts` gains only the thin `ConvertToPdfA` wrapper and the
  `ConvertOptions`/`ConversionReport` re-exports.
- `index.ts` exports `ConvertOptions`, `ConvertAction`, `ConversionReport`,
  `ConvertCategory`.
- `/ToUnicode` synthesis and the `ri`-operand content rewrite live in small
  helpers within `pdfaconvert.ts` (or `pdfaconvert-tounicode.ts` if the CMap
  builder grows past ~60 lines), keeping the main engine file focused.

## Testing (TDD)

Reuse `test/helpers/build-pdfa-pdf.ts`. New `test/pdfaconvert.test.ts`:

- **Per remediable rule:** build the violating fixture, `ConvertToPdfA`, assert
  (a) a `ConvertAction` with the expected `rule` is in `applied`, and (b) a
  fresh `ValidatePdfA(level)` no longer reports that rule.
- **Removals:** assert the prohibited construct is gone and recorded; with the
  matching `opts.preserve` entry, assert it is **kept** and instead appears in
  `unresolved`.
- **Report-only rules:** build a fixture (e.g. non-embedded font), convert,
  assert the rule is in `unresolved` and `passed === false`.
- **Identification round-trip:** convert a titled fixture; re-open the saved
  bytes; assert `GetXmp()` carries the pdfaid part/conformance and the title
  matches `/Info`.
- **Full round-trip:** take a messy-but-achievable fixture (device color, no
  output intent, JS action, `/NeedAppearances`, multimedia annot, missing
  `/ID`), `ConvertToPdfA('2b')`, then `Save()`→`Open()`→
  `ValidatePdfA('2b').Passed === true`.
- **Level u:** a simple font without `/ToUnicode` (standard encoding) converts so
  `ToUnicode` clears at `2u`.

`npm run typecheck` and `npm test` green before close.

## Documentation

`README.md` "Features" gains a PDF/A conversion bullet (`doc.ConvertToPdfA`,
the applied/removed/unresolved model, `opts.iccProfile`/`preserve`). "Limitations"
notes the report-only set (non-embedded fonts, part-1 transparency,
LZW/JPX/JBIG2, external streams) and that conversion re-validates so `passed`
mirrors `ValidatePdfA`.
