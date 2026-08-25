# PDF/X Validation + Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.ValidatePdfX(level)` and `doc.ConvertToPdfX(level, opts)` for ISO 15930 levels X-1a, X-3, X-4 and X-4p, reusing the PDF/A rule/pass architecture.

**Architecture:** The scan machinery shared by both standards is hoisted out of `src/pdfavalidate.ts` into a new neutral `src/validatectx.ts`. `src/pdfxvalidate.ts` holds a `Rule[]` evaluated over a read-only context; `src/pdfxconvert.ts` holds a `Pass[]` that mutates the live object model and then re-validates. Both return the existing `ValidationReport` / `ConversionReport` types — no new report shapes.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, Node built-ins only.

Spec: [docs/superpowers/specs/2026-07-21-pdfx-validation-conversion-design.md](../specs/2026-07-21-pdfx-validation-conversion-design.md)
Issue: `aspose-pdf-foss-for-ts-i9n`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins (`zlib`, `crypto`, `fs`). Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension: `import { Ctx } from './validatectx.js'`.
- **Strict TypeScript.** `npm run typecheck` must be clean.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError` from `src/errors.ts`.
- **Both gates green before closing the issue:** `npm run typecheck` and `npm test`.
- **Task tracking is `bd`**, not TodoWrite or markdown TODO lists. The issue is `aspose-pdf-foss-for-ts-i9n`.
- **Any rule whose ISO 15930 clause cannot be substantiated ships as `severity: 'warning'`, never `'error'`.** An unverified rule must not be able to fail a conformant document.
- **Commit messages** end with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/validatectx.ts` | Create | Neutral scan machinery: `Ctx`, `memo`, `filterNames`, `allObjects`, `nameOf`, `pageScans`/`PageScan`, `extGStates`, `eachAnnotation`, `blendModeName`, `xmpText`, `enumerateFonts`, `hasFontProgram`, `usesDeviceColor` |
| `src/pdfavalidate.ts` | Modify | Keeps only its `Rule[]` + `validatePdfA`; imports the rest |
| `src/pdfxvalidate.ts` | Create | `PdfXLevel`, `XCtx`, PDF/X `Rule[]`, `validatePdfX` |
| `src/pdfxconvert.ts` | Create | `PdfXConvertOptions`, `Pass[]`, `convertToPdfX` |
| `src/pdfxcolor.ts` | Create | Opt-in `DeviceRGB → DeviceCMYK` content rewrite |
| `src/xmp.ts` | Modify | `pdfxVersion` field: read + build |
| `src/document.ts` | Modify | `ValidatePdfX` / `ConvertToPdfX`; `ensureInfo` becomes `@internal` |
| `src/index.ts` | Modify | Export `PdfXLevel`, `PdfXConvertOptions` |
| `test/helpers/build-pdfx-pdf.ts` | Create | Fixture builder with per-rule violation knobs |
| `test/pdfxvalidate.test.ts` | Create | Rule tests |
| `test/pdfxconvert.test.ts` | Create | Pass tests |
| `test/fixtures/pdfx/` | Create | One real Ghostscript `-dPDFX` file + `PROVENANCE.md` |

Only `validatePdfA`, `parseLevel` and `PdfALevel` are imported from `pdfavalidate.ts` elsewhere in the tree (`document.ts`, `index.ts`, `pdfaconvert.ts`), so Task 1's hoist is invisible outside the module.

---

### Task 1: Hoist shared scan machinery into `validatectx.ts`

Pure refactor. The existing PDF/A suite is the guard: it must stay green with zero test edits.

**Files:**
- Create: `src/validatectx.ts`
- Modify: `src/pdfavalidate.ts`
- Test: `test/pdfavalidate.test.ts` (unchanged — used as the regression guard)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  ```ts
  export interface Ctx {
    doc: Document;
    catalog: PdfDict;
    R(o: PdfObject | undefined): PdfObject;
    cache: Map<string, unknown>;
  }
  export function memo<T>(ctx: Ctx, key: string, fn: () => T): T;
  export function nameOf(ctx: Ctx, dict: PdfDict, key: string): string | undefined;
  export function filterNames(dict: PdfDict, R: Ctx['R']): string[];
  export function allObjects(ctx: Ctx): [PdfRef, PdfObject][];
  export interface PageScan {
    page: Page;
    colorSpaces: Set<string>;
    inlineImageFilters: string[];
    renderingIntents: string[];
  }
  export function pageScans(ctx: Ctx): PageScan[];
  export function usesDeviceColor(scan: PageScan): boolean;
  export function extGStates(ctx: Ctx): { ref?: PdfRef; dict: PdfDict }[];
  export function eachAnnotation(ctx: Ctx): { ref?: PdfRef; dict: PdfDict; page: Page }[];
  export function blendModeName(ctx: Ctx, dict: PdfDict): string | undefined;
  export function xmpText(ctx: Ctx): string | undefined;
  export function enumerateFonts(ctx: Ctx): { ref?: PdfRef; dict: PdfDict }[];
  export function hasFontProgram(ctx: Ctx, descriptor: PdfObject | undefined): boolean;
  ```

- [ ] **Step 1: Run the PDF/A suite to record the green baseline**

Run: `npx vitest run test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS. Note the test count — it must be identical at the end of this task.

- [ ] **Step 2: Create `src/validatectx.ts` by moving code verbatim**

Move these declarations out of `src/pdfavalidate.ts` unchanged, except as noted below: `Ctx` (drop the `part` and `level` fields), `memo`, `filterNames`, `allObjects`, `nameOf` (add `export`), `PageScan`, `DEVICE_COLOR_OPS`, `DEVICE_CS`, `INLINE_FILTER_ABBREV`, `inlineFilterNames`, `pageScans`, `concatContents`, `extGStates`, `blendModeName`, `eachAnnotation`, `xmpText`, `enumerateFonts`, `descendantFont`, `hasFontProgram`.

The file header:

```ts
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isDict, isName, isArray, isStream, isRef,
} from './types.js';
import { inflateStream } from './flate.js';
import { parseContentStream } from './content.js';
import type { Page } from './page.js';

/** Per-run context shared (read-only) across the rules of any validator. */
export interface Ctx {
  doc: Document;
  catalog: PdfDict;
  /** Bound `doc.resolve`. */
  R(o: PdfObject | undefined): PdfObject;
  /** Memo store for shared scans (fonts, content scan, …). */
  cache: Map<string, unknown>;
}
```

- [ ] **Step 3: Change `PageScan.usesDeviceColor` to `colorSpaces`**

PDF/X needs per-space granularity (X-1a prohibits `DeviceRGB` specifically, not device color as a class), so the boolean becomes a set. In `validatectx.ts`:

```ts
export interface PageScan {
  page: Page;
  /** Every color space named by the page's content, e.g. 'DeviceRGB', 'ICCBased'. */
  colorSpaces: Set<string>;
  inlineImageFilters: string[];
  renderingIntents: string[];
}

/** Operators that set color in a device space, mapped to that space. */
const DEVICE_COLOR_OPS: Record<string, string> = {
  g: 'DeviceGray', G: 'DeviceGray',
  rg: 'DeviceRGB', RG: 'DeviceRGB',
  k: 'DeviceCMYK', K: 'DeviceCMYK',
};

/** Abbreviated and full names of the device spaces. */
const DEVICE_CS: Record<string, string> = {
  DeviceGray: 'DeviceGray', G: 'DeviceGray',
  DeviceRGB: 'DeviceRGB', RGB: 'DeviceRGB',
  DeviceCMYK: 'DeviceCMYK', CMYK: 'DeviceCMYK',
};

/** True when the scan saw any device-dependent color space. */
export function usesDeviceColor(scan: PageScan): boolean {
  return scan.colorSpaces.has('DeviceGray')
    || scan.colorSpaces.has('DeviceRGB')
    || scan.colorSpaces.has('DeviceCMYK');
}
```

Inside `pageScans`, replace the three `scan.usesDeviceColor = true` assignments:

```ts
        const deviceOp = DEVICE_COLOR_OPS[op.operator];
        if (deviceOp !== undefined) scan.colorSpaces.add(deviceOp);
        if (op.operator === 'cs' || op.operator === 'CS') {
          const a = op.operands[0];
          if (isName(a)) {
            const dev = DEVICE_CS[a.name];
            if (dev !== undefined) scan.colorSpaces.add(dev);
            else scan.colorSpaces.add(resolveSpaceFamily(ctx, resDict, a.name));
          }
        }
```

and for the inline-image branch:

```ts
          const cs = ctx.R(idict.get('CS')) ?? ctx.R(idict.get('ColorSpace'));
          if (isName(cs)) {
            const dev = DEVICE_CS[cs.name];
            if (dev !== undefined) scan.colorSpaces.add(dev);
          }
```

Named spaces resolve through the page's `/Resources /ColorSpace` to their family name:

```ts
/** The family of a named color space from /Resources /ColorSpace, e.g. an
 *  /ICCBased or /Separation array's first element. Falls back to the name. */
function resolveSpaceFamily(ctx: Ctx, resDict: PdfDict | undefined, name: string): string {
  if (!resDict) return name;
  const csDict = ctx.R(resDict.get('ColorSpace'));
  if (!isDict(csDict)) return name;
  const entry = ctx.R(csDict.get(name));
  if (isName(entry)) return DEVICE_CS[entry.name] ?? entry.name;
  if (isArray(entry) && entry.length > 0) {
    const family = ctx.R(entry[0]);
    if (isName(family)) return family.name;
  }
  return name;
}
```

The scan's initializer becomes `{ page, colorSpaces: new Set<string>(), inlineImageFilters: [], renderingIntents: [] }`.

- [ ] **Step 4: Update `pdfavalidate.ts` to consume the neutral module**

`Ctx` there becomes PDF/A-specific and the file imports the rest:

```ts
import {
  type Ctx as BaseCtx, memo, nameOf, filterNames, allObjects, pageScans, usesDeviceColor,
  extGStates, eachAnnotation, blendModeName, xmpText, enumerateFonts, hasFontProgram,
} from './validatectx.js';

/** PDF/A run context: the shared scan context plus the conformance target. */
export interface Ctx extends BaseCtx { part: 1 | 2 | 3; level: 'b' | 'u' | 'a'; }
```

The two callers of the old boolean become `usesDeviceColor(s)`:

```ts
const outputIntentRule: Rule = (ctx) => {
  const usesDevice = pageScans(ctx).some(usesDeviceColor);
  // …unchanged…
```

```ts
const deviceColorRule: Rule = (ctx) => {
  const state = pdfaOutputIntentProfile(ctx);
  if (state !== 'missing') return [];
  return pageScans(ctx).flatMap((s) =>
    usesDeviceColor(s)
      ? [{ rule: 'DeviceColorWithoutIntent', severity: 'error' as const, clause: 'ISO 19005-1 §6.2.3.3', page: s.page,
          message: 'Page uses device-dependent color without a matching PDF/A OutputIntent.' }]
      : []);
};
```

`validatePdfA` keeps building its context exactly as before — the extra `part`/`level` fields now come from the extending interface.

- [ ] **Step 5: Run typecheck and the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, with the same test count as Step 1. A refactor that changes behavior has failed.

- [ ] **Step 6: Prove the moved scan is still load-bearing**

Temporarily make `pageScans` return `[]`, run `npx vitest run test/pdfavalidate.test.ts`, and confirm the output-intent and device-color tests go **red**. Revert the mutation and re-run to green. If the suite stayed green, the scan was never being exercised and that is a finding to report before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/validatectx.ts src/pdfavalidate.ts
git commit -F - <<'EOF'
refactor: hoist shared validator scans into validatectx.ts

PDF/X needs the same all-objects walk, content color scan, ExtGState
collection and annotation walk that PDF/A does. Moves them to a neutral
module and widens PageScan.usesDeviceColor into a colorSpaces set, since
PDF/X-1a's rule is per-space rather than device-or-not.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 2: XMP `pdfxid` support

**Files:**
- Modify: `src/xmp.ts:4-20` (`XmpMetadata`), `src/xmp.ts:101` (`readXmp`), `src/xmp.ts:145` (`buildXmp`)
- Test: `test/xmp.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `XmpMetadata.pdfxVersion?: string` — the `pdfxid:GTS_PDFXVersion` value, e.g. `'PDF/X-4'`. Readable via `doc.GetXmp()`, writable via `doc.SetXmp({ pdfxVersion })`.

- [ ] **Step 1: Write the failing test**

Append to `test/xmp.test.ts`:

```ts
describe('XMP — pdfxid', () => {
  it('round-trips pdfxid:GTS_PDFXVersion through SetXmp/GetXmp', () => {
    const doc = Document.Open(buildSimplePdf());
    doc.SetXmp({ pdfxVersion: 'PDF/X-4' });
    const reopened = Document.Open(doc.Save());
    expect(reopened.GetXmp().pdfxVersion).toBe('PDF/X-4');
  });

  it('reads the element form as well as the attribute form', () => {
    const packet = '<rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/">'
      + '<pdfxid:GTS_PDFXVersion>PDF/X-1a:2003</pdfxid:GTS_PDFXVersion></rdf:Description>';
    expect(readXmp(new TextEncoder().encode(packet)).pdfxVersion).toBe('PDF/X-1a:2003');
  });
});
```

Use whatever simple-document helper `test/xmp.test.ts` already imports; do not add a new one.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/xmp.test.ts`
Expected: FAIL — `pdfxVersion` is not a property of the update type (typecheck error) or reads back `undefined`.

- [ ] **Step 3: Add the field**

In `XmpMetadata`, beside the `pdfaid` fields:

```ts
  pdfxVersion?: string;           // pdfxid:GTS_PDFXVersion (PDF/X identification)
```

In `readXmp`, beside the `pdfaid` extraction:

```ts
  const pdfxAttr = /pdfxid:GTS_PDFXVersion\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfxid:GTS_PDFXVersion>\s*([^<]+?)\s*<\/pdfxid:GTS_PDFXVersion>/.exec(raw);
  if (pdfxAttr) meta.pdfxVersion = pdfxAttr[1].trim();
```

In `buildXmp`, beside `pdfaDesc`:

```ts
  const pdfxDesc = meta.pdfxVersion !== undefined
    ? `\n  <rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"`
      + ` pdfxid:GTS_PDFXVersion="${escapeXml(meta.pdfxVersion)}"/>`
    : '';
```

and concatenate `pdfxDesc` into the packet body wherever `pdfaDesc` is concatenated.

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/xmp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/xmp.ts test/xmp.test.ts
git commit -F - <<'EOF'
feat(xmp): read and write pdfxid:GTS_PDFXVersion

PDF/X identification lives in the pdfxid namespace, the counterpart of
pdfaid. Both attribute and element forms are read; the attribute form is
written.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 3: Fixture builder + validator skeleton (identification & output intent)

The first slice that produces something runnable end to end: the builder, the `Rule[]` scaffolding, the two identification rules, and the public entry point.

**Files:**
- Create: `test/helpers/build-pdfx-pdf.ts`, `src/pdfxvalidate.ts`, `test/pdfxvalidate.test.ts`
- Modify: `src/document.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `Ctx`, `memo`, `nameOf`, `allObjects`, `pageScans`, `PageScan` from `validatectx.js` (Task 1); `XmpMetadata.pdfxVersion` (Task 2).
- Produces:
  ```ts
  export type PdfXLevel = '1a' | '3' | '4' | '4p';
  export interface XCtx extends Ctx { level: PdfXLevel }
  export function validatePdfX(doc: Document, catalog: PdfDict, level: PdfXLevel): ValidationReport;
  export function pdfxOutputIntent(ctx: XCtx): PdfDict | undefined;
  export function xVersionString(level: PdfXLevel): string;   // 'PDF/X-1a:2003' | 'PDF/X-3:2003' | 'PDF/X-4'
  // test helper
  export function buildPdfxPdf(opts?: PdfxOptions, level?: PdfXLevel): Uint8Array;
  ```
  Note `xVersionString('4p')` returns `'PDF/X-4'` — X-4p is identified as X-4 and distinguished only by how the output-intent profile is supplied.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-pdfx-pdf.ts`, mirroring `build-pdfa-pdf.ts`'s structure (raw PDF text indexed by object number, classic xref, `enc`/`byteLen` helpers). Copy the `// --- assemble ---` block — `test/helpers/build-pdfa-pdf.ts:164-184`, the offset walk, xref table and trailer — verbatim; only the object bodies and the options interface differ. A conformant X-4 document with knobs:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

export interface PdfxOptions {
  // identification
  omitXmp?: boolean;            // drop /Root /Metadata
  pdfxVersion?: string;         // override pdfxid:GTS_PDFXVersion
  omitInfoVersion?: boolean;    // drop /Info /GTS_PDFXVersion (1a/3 only)
  // output intent
  omitOutputIntent?: boolean;   // drop /OutputIntents
  intentSubtype?: string;       // override /S (default GTS_PDFX)
  twoIntents?: boolean;         // two GTS_PDFX intents
  registeredNameOnly?: boolean; // /OutputConditionIdentifier, no /DestOutputProfile
  unregisteredNameOnly?: boolean; // an unregistered identifier and no profile
  externalProfileRef?: boolean; // /DestOutputProfileRef instead (X-4p)
  iccN?: number;                // /DestOutputProfile /N (default 4)
  // structure
  omitTrapped?: boolean;        // drop /Info /Trapped
  trapped?: string;             // /Info /Trapped value (default 'False')
  omitTrimBox?: boolean;        // page has neither /TrimBox nor /ArtBox
  bothTrimAndArt?: boolean;     // page has both
  bleedOutsideMedia?: boolean;  // /BleedBox not inside /MediaBox
  headerVersion?: string;       // %PDF-x.y (default '1.6')
  omitId?: boolean;
  // color
  contentColor?: 'k' | 'rg' | 'none';  // content color operator (default 'k')
  iccBasedSpace?: boolean;      // /Resources /ColorSpace with an /ICCBased array
  // fonts
  fontEmbedded?: boolean;       // default true
  // transparency / layers / files
  transparencyGroup?: boolean;
  lowAlpha?: boolean;
  optionalContent?: boolean;
  embeddedFile?: boolean;       // catalog /Names /EmbeddedFiles name tree
  // annotations / actions
  annotInsideTrim?: boolean;    // annot whose /Rect overlaps /TrimBox
  movieAnnot?: boolean;
  jsAction?: boolean;
  // filters / halftone
  lzwStream?: boolean;
  jpxImage?: boolean;
  transferFunction?: boolean;   // ExtGState /TR
  badHalftone?: boolean;        // ExtGState /HT of /HalftoneType 6
}

export function buildPdfxPdf(opts: PdfxOptions = {}, level: PdfXLevel = '4'): Uint8Array
```

Baseline geometry: `/MediaBox [0 0 200 200]`, `/TrimBox [10 10 190 190]`, `/BleedBox [5 5 195 195]`. Baseline content: `0 0 0 1 k\nBT /F1 12 Tf 50 50 Td (Hi) Tj ET\n` (DeviceCMYK — legal at every level). Baseline `/Info`: `<< /Title (Clean) /Trapped /False /GTS_PDFXVersion (PDF/X-4) >>`. Baseline output intent:

```
/OutputIntents [<< /Type /OutputIntent /S /GTS_PDFX
  /OutputConditionIdentifier (CGATS TR 001)
  /OutputCondition (Commercial and specialty printing)
  /RegistryName (http://www.color.org)
  /DestOutputProfile 8 0 R >>]
```

with object 8 a stream `<< /N 4 /Length 4 >>`. Baseline XMP carries `pdfxid:GTS_PDFXVersion="PDF/X-4"` (or the level's string) using the same packet shape as `build-pdfa-pdf.ts`'s `xmpPacket`, with the `pdfaid` description replaced by:

```
<rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" pdfxid:GTS_PDFXVersion="${version}"/>
```

For `level` `'1a'` or `'3'`, default `headerVersion` to `'1.4'` and include `/Info /GTS_PDFXVersion`; for `'4'`/`'4p'` default to `'1.6'`. For `'4p'`, default `externalProfileRef` to true.

- [ ] **Step 2: Write the failing tests**

Create `test/pdfxvalidate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfxPdf } from './helpers/build-pdfx-pdf.js';
import type { PdfXLevel } from '../src/pdfxvalidate.js';

const open = (bytes: Uint8Array) => Document.Open(bytes);
const rules = (bytes: Uint8Array, level: PdfXLevel = '4') =>
  open(bytes).ValidatePdfX(level).Errors.map((e) => e.rule);

describe('ValidatePdfX — harness', () => {
  it('clean X-4 document passes with zero errors and no warnings', () => {
    const report = open(buildPdfxPdf({}, '4')).ValidatePdfX('4');
    expect(report.Errors).toEqual([]);
    expect(report.Warnings).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('clean X-1a and X-3 documents pass', () => {
    expect(open(buildPdfxPdf({}, '1a')).ValidatePdfX('1a').Errors).toEqual([]);
    expect(open(buildPdfxPdf({}, '3')).ValidatePdfX('3').Errors).toEqual([]);
  });
});

describe('ValidatePdfX — identification', () => {
  it('flags a missing XMP packet', () => {
    expect(rules(buildPdfxPdf({ omitXmp: true }))).toContain('PdfxIdentification');
  });
  it('flags a GTS_PDFXVersion that disagrees with the requested level', () => {
    expect(rules(buildPdfxPdf({ pdfxVersion: 'PDF/X-1a:2003' }, '4'), '4'))
      .toContain('PdfxIdentification');
  });
  it('flags a missing /Info /GTS_PDFXVersion at 1a but not at 4', () => {
    expect(rules(buildPdfxPdf({ omitInfoVersion: true }, '1a'), '1a'))
      .toContain('PdfxIdentification');
    expect(rules(buildPdfxPdf({ omitInfoVersion: true }, '4'), '4'))
      .not.toContain('PdfxIdentification');
  });
});

describe('ValidatePdfX — output intent', () => {
  it('flags a missing output intent', () => {
    expect(rules(buildPdfxPdf({ omitOutputIntent: true }))).toContain('OutputIntent');
  });
  it('flags a non-GTS_PDFX intent subtype', () => {
    expect(rules(buildPdfxPdf({ intentSubtype: 'GTS_PDFA1' }))).toContain('OutputIntent');
  });
  it('flags two PDF/X output intents', () => {
    expect(rules(buildPdfxPdf({ twoIntents: true }))).toContain('OutputIntent');
  });
  it('accepts a registered characterization name with no embedded profile', () => {
    expect(rules(buildPdfxPdf({ registeredNameOnly: true }))).not.toContain('OutputIntent');
  });
  it('flags an unregistered identifier with no embedded profile', () => {
    expect(rules(buildPdfxPdf({ unregisteredNameOnly: true }))).toContain('OutputIntent');
  });
  it('accepts an external profile reference at 4p but not at 4', () => {
    expect(rules(buildPdfxPdf({ externalProfileRef: true }, '4p'), '4p'))
      .not.toContain('OutputIntent');
    expect(rules(buildPdfxPdf({ externalProfileRef: true }, '4'), '4'))
      .toContain('OutputIntent');
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run test/pdfxvalidate.test.ts`
Expected: FAIL — `Cannot find module '../src/pdfxvalidate.js'`.

- [ ] **Step 4: Write `src/pdfxvalidate.ts`**

```ts
import type { Document } from './document.js';
import { PdfObject, PdfDict, isDict, isName, isArray, isStream, isString } from './types.js';
import { ValidationReport, type ValidationIssue } from './validation.js';
import { type Ctx, memo, nameOf, xmpText } from './validatectx.js';

/** PDF/X conformance target. '4p' is X-4 with an externally referenced
 *  output-intent profile (ISO 15930-7). */
export type PdfXLevel = '1a' | '3' | '4' | '4p';

/** PDF/X run context: the shared scan context plus the conformance target. */
export interface XCtx extends Ctx { level: PdfXLevel }

type Rule = (ctx: XCtx) => ValidationIssue[];

/** The GTS_PDFXVersion string a level must declare. */
export function xVersionString(level: PdfXLevel): string {
  if (level === '1a') return 'PDF/X-1a:2003';
  if (level === '3') return 'PDF/X-3:2003';
  return 'PDF/X-4'; // '4' and '4p' both identify as PDF/X-4
}

/** True for the levels that predate PDF/X-4 and use the /Info key as well as XMP. */
function isLegacy(level: PdfXLevel): boolean { return level === '1a' || level === '3'; }

/** Entry point. The facade supplies the catalog (mirrors validatePdfA). */
export function validatePdfX(doc: Document, catalog: PdfDict, level: PdfXLevel): ValidationReport {
  const ctx: XCtx = { doc, catalog, level, R: (o) => doc.resolve(o), cache: new Map() };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) issues.push(...rule(ctx));
  return new ValidationReport(issues);
}

/** The document's /Info dictionary, or undefined. */
export function infoDict(ctx: XCtx): PdfDict | undefined {
  const info = ctx.R(ctx.doc.trailer.get('Info'));
  return isDict(info) ? info : undefined;
}

/** A /Info string entry's text, or undefined. */
export function infoString(ctx: XCtx, key: string): string | undefined {
  const info = infoDict(ctx);
  const v = info ? ctx.R(info.get(key)) : undefined;
  return isString(v) ? new TextDecoder('latin1').decode(v.bytes) : undefined;
}

// ---- identification --------------------------------------------------------

const identificationRule: Rule = (ctx) => {
  const want = xVersionString(ctx.level);
  const issues: ValidationIssue[] = [];
  const xmp = xmpText(ctx);
  if (xmp === undefined) {
    return [{ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-7 §6.2',
      message: 'No /Root /Metadata XMP packet; PDF/X requires pdfxid identification.' }];
  }
  const m = /pdfxid:GTS_PDFXVersion\s*=\s*["']([^"']+)["']/.exec(xmp)
    ?? /<pdfxid:GTS_PDFXVersion>\s*([^<]+?)\s*<\/pdfxid:GTS_PDFXVersion>/.exec(xmp);
  const got = m?.[1].trim();
  if (got === undefined) {
    issues.push({ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-7 §6.2',
      message: 'XMP carries no pdfxid:GTS_PDFXVersion.' });
  } else if (got !== want) {
    issues.push({ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-7 §6.2',
      message: `XMP declares pdfxid:GTS_PDFXVersion '${got}'; expected '${want}'.` });
  }
  if (isLegacy(ctx.level) && infoString(ctx, 'GTS_PDFXVersion') === undefined) {
    issues.push({ rule: 'PdfxIdentification', severity: 'error', clause: 'ISO 15930-4 §6.2',
      message: '/Info carries no /GTS_PDFXVersion key, required for PDF/X-1a and X-3.' });
  }
  return issues;
};

// ---- output intent ---------------------------------------------------------

/** Standard characterization names that may stand in for an embedded profile.
 *  A short registry subset; unknown names are treated as unregistered. */
const REGISTERED_CONDITIONS = new Set([
  'CGATS TR 001', 'CGATS TR 001 SWOP', 'CGATS TR 003', 'CGATS TR 005', 'CGATS TR 006',
  'FOGRA27', 'FOGRA28', 'FOGRA29', 'FOGRA30', 'FOGRA31', 'FOGRA32', 'FOGRA33',
  'FOGRA34', 'FOGRA35', 'FOGRA36', 'FOGRA37', 'FOGRA38', 'FOGRA39', 'FOGRA40',
  'FOGRA41', 'FOGRA42', 'FOGRA43', 'FOGRA44', 'FOGRA45', 'FOGRA46', 'FOGRA47',
  'FOGRA51', 'FOGRA52', 'IFRA26', 'IFRA30', 'JC200103', 'JCN2002', 'JCW2003',
  'EUROSB104', 'EUROSB204', 'PSO_Coated_300_NPscreen_ISO12647_eci',
]);

/** Every PDF/X output intent dict in the catalog. */
export function pdfxIntents(ctx: XCtx): PdfDict[] {
  return memo(ctx, 'xoi', () => {
    const ois = ctx.R(ctx.catalog.get('OutputIntents'));
    if (!isArray(ois)) return [];
    return ois.map(ctx.R).filter(isDict).filter((oi) => nameOf(ctx, oi, 'S') === 'GTS_PDFX');
  });
}

/** The single PDF/X output intent, or undefined when absent or ambiguous. */
export function pdfxOutputIntent(ctx: XCtx): PdfDict | undefined {
  const all = pdfxIntents(ctx);
  return all.length === 1 ? all[0] : undefined;
}

const outputIntentRule: Rule = (ctx) => {
  const all = pdfxIntents(ctx);
  if (all.length === 0) {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: 'No /OutputIntents entry with /S /GTS_PDFX; PDF/X requires exactly one.' }];
  }
  if (all.length > 1) {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: `Found ${all.length} PDF/X output intents; exactly one is permitted.` }];
  }
  const oi = all[0];
  const profile = ctx.R(oi.get('DestOutputProfile'));
  const external = ctx.R(oi.get('DestOutputProfileRef'));
  const idValue = ctx.R(oi.get('OutputConditionIdentifier'));
  const id = isString(idValue) ? new TextDecoder('latin1').decode(idValue.bytes).trim() : undefined;

  if (isStream(profile)) return [];
  if (ctx.level === '4p') {
    if (isDict(external) && external.get('F') !== undefined) return [];
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: 'PDF/X-4p requires /DestOutputProfileRef with a file specification when no profile is embedded.' }];
  }
  if (isDict(external)) {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-7 §6.3',
      message: '/DestOutputProfileRef is permitted only in PDF/X-4p.' }];
  }
  if (id !== undefined && REGISTERED_CONDITIONS.has(id)) return [];
  return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 15930-4 §6.3',
    message: id === undefined
      ? 'Output intent has neither /DestOutputProfile nor /OutputConditionIdentifier.'
      : `Output intent has no /DestOutputProfile and '${id}' is not a registered characterization name.` }];
};

const RULES: Rule[] = [identificationRule, outputIntentRule];
```

- [ ] **Step 5: Wire the facade**

In `src/document.ts`, add the import beside the PDF/A one:

```ts
import { validatePdfX, type PdfXLevel } from './pdfxvalidate.js';
```

and the method after `ValidatePdfA`:

```ts
  /** Validate the document against a curated, machine-decidable subset of
   *  PDF/X (ISO 15930, levels 1a/3/4/4p). Read-only; never mutates. */
  ValidatePdfX(level: PdfXLevel): ValidationReport {
    return validatePdfX(this, this.catalog(), level);
  }
```

In `src/index.ts`, beside the `PdfALevel` export:

```ts
export type { PdfXLevel } from './pdfxvalidate.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/pdfxvalidate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Prove both rules load-bearing**

Temporarily replace `RULES` with `[]`, re-run, and confirm every test except the two "clean document passes" cases goes **red**. Revert and re-run to green.

- [ ] **Step 8: Commit**

```bash
git add src/pdfxvalidate.ts src/document.ts src/index.ts test/helpers/build-pdfx-pdf.ts test/pdfxvalidate.test.ts
git commit -F - <<'EOF'
feat(pdfx): ValidatePdfX skeleton with identification and output-intent rules

Adds the PDF/X rule pipeline over the shared validatectx scans, the
fixture builder, and Document.ValidatePdfX. A registered characterization
name stands in for an embedded profile; X-4p takes the external
DestOutputProfileRef form instead.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 4: Structural rules — Trapped, page geometry, version, filters, reused PDF/A rules

**Files:**
- Modify: `src/pdfxvalidate.ts`, `test/pdfxvalidate.test.ts`

**Interfaces:**
- Consumes: `XCtx`, `infoDict`, `infoString`, `isLegacy` semantics from Task 3; `allObjects`, `filterNames`, `enumerateFonts`, `hasFontProgram` from `validatectx.js`.
- Produces: rule ids `Trapped`, `PageGeometry`, `Version`, `Filters`, `Encryption`, `ExternalStream`, `PostScriptXObject`, `ReferenceXObject`, `FontEmbedded`, `FileID`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pdfxvalidate.test.ts`:

```ts
describe('ValidatePdfX — structure', () => {
  it('flags a missing /Info /Trapped', () => {
    expect(rules(buildPdfxPdf({ omitTrapped: true }))).toContain('Trapped');
  });
  it('flags /Trapped /Unknown', () => {
    expect(rules(buildPdfxPdf({ trapped: 'Unknown' }))).toContain('Trapped');
  });
  it('accepts /Trapped /True', () => {
    expect(rules(buildPdfxPdf({ trapped: 'True' }))).not.toContain('Trapped');
  });
  it('flags a page with neither /TrimBox nor /ArtBox', () => {
    expect(rules(buildPdfxPdf({ omitTrimBox: true }))).toContain('PageGeometry');
  });
  it('flags a page carrying both /TrimBox and /ArtBox', () => {
    expect(rules(buildPdfxPdf({ bothTrimAndArt: true }))).toContain('PageGeometry');
  });
  it('flags a /BleedBox outside the /MediaBox', () => {
    expect(rules(buildPdfxPdf({ bleedOutsideMedia: true }))).toContain('PageGeometry');
  });
  it('flags an over-ceiling version at 1a but not at 4', () => {
    expect(rules(buildPdfxPdf({ headerVersion: '1.6' }, '1a'), '1a')).toContain('Version');
    expect(rules(buildPdfxPdf({ headerVersion: '1.6' }, '4'), '4')).not.toContain('Version');
  });
  it('flags an LZW filter', () => {
    expect(rules(buildPdfxPdf({ lzwStream: true }))).toContain('Filters');
  });
  it('flags JPXDecode at 1a and 3 but not at 4', () => {
    expect(rules(buildPdfxPdf({ jpxImage: true }, '3'), '3')).toContain('Filters');
    expect(rules(buildPdfxPdf({ jpxImage: true }, '4'), '4')).not.toContain('Filters');
  });
  it('flags a missing /ID', () => {
    expect(rules(buildPdfxPdf({ omitId: true }))).toContain('FileID');
  });
  it('flags a non-embedded font', () => {
    expect(rules(buildPdfxPdf({ fontEmbedded: false }))).toContain('FontEmbedded');
  });
  it('flags an encrypted document', () => {
    const encrypted = Document.Open(buildPdfxPdf({})).Save({ encrypt: { userPassword: '' } });
    expect(Document.Open(encrypted).ValidatePdfX('4').Errors.map((e) => e.rule))
      .toContain('Encryption');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/pdfxvalidate.test.ts`
Expected: FAIL on every case in the new block.

- [ ] **Step 3: Implement the rules**

Add to `src/pdfxvalidate.ts` (extend the imports from `./validatectx.js` with `allObjects`, `filterNames`, `enumerateFonts`, `hasFontProgram`, and from `./types.js` with `isRef`, `PdfRef`):

```ts
const trappedRule: Rule = (ctx) => {
  const info = infoDict(ctx);
  const v = info ? ctx.R(info.get('Trapped')) : undefined;
  const val = isName(v) ? v.name : undefined;
  if (val === 'True' || val === 'False') return [];
  return [{ rule: 'Trapped', severity: 'error', clause: 'ISO 15930-4 §6.2',
    message: val === undefined
      ? '/Info has no /Trapped key; PDF/X requires /True or /False.'
      : `/Info /Trapped is /${val}; PDF/X requires /True or /False.` }];
};

/** A /MediaBox-style rectangle normalized to [llx, lly, urx, ury]. */
function rect(ctx: XCtx, v: PdfObject | undefined): [number, number, number, number] | undefined {
  const a = ctx.R(v);
  if (!isArray(a) || a.length !== 4) return undefined;
  const n = a.map((e) => ctx.R(e)).filter((e): e is number => typeof e === 'number');
  if (n.length !== 4) return undefined;
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

/** True when `inner` lies within `outer` (a half-point tolerance absorbs rounding). */
function within(inner: [number, number, number, number], outer: [number, number, number, number]): boolean {
  const t = 0.5;
  return inner[0] >= outer[0] - t && inner[1] >= outer[1] - t
    && inner[2] <= outer[2] + t && inner[3] <= outer[3] + t;
}

const pageGeometryRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const page of ctx.doc.Pages) {
    const trim = page.Dict.get('TrimBox');
    const art = page.Dict.get('ArtBox');
    if (trim === undefined && art === undefined) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page has neither /TrimBox nor /ArtBox; PDF/X requires one.' });
      continue;
    }
    if (trim !== undefined && art !== undefined) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page has both /TrimBox and /ArtBox; PDF/X permits only one.' });
    }
    const media = rect(ctx, page.Dict.get('MediaBox') ?? page.MediaBox);
    const bleed = rect(ctx, page.Dict.get('BleedBox'));
    if (media && bleed && !within(bleed, media)) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page /BleedBox extends outside the /MediaBox.' });
    }
    const t = rect(ctx, trim) ?? rect(ctx, art);
    const outer = bleed ?? media;
    if (t && outer && !within(t, outer)) {
      issues.push({ rule: 'PageGeometry', severity: 'error', clause: 'ISO 15930-7 §6.4', page,
        message: 'Page /TrimBox (or /ArtBox) extends outside the /BleedBox or /MediaBox.' });
    }
  }
  return issues;
};

const versionRule: Rule = (ctx) => {
  const ceiling = isLegacy(ctx.level) ? 1.4 : 1.6;
  const over = (v: string | undefined): boolean => v !== undefined && Number(v) > ceiling + 1e-9;
  const cat = nameOf(ctx, ctx.catalog, 'Version');
  if (over(ctx.doc.headerVersion()) || over(cat)) {
    return [{ rule: 'Version', severity: 'error', clause: 'ISO 15930-4 §6.1',
      message: `PDF version exceeds the ${xVersionString(ctx.level)} ceiling (${ceiling}).` }];
  }
  return [];
};

const filtersRule: Rule = (ctx) => {
  const banned = new Set(isLegacy(ctx.level) ? ['LZWDecode', 'JPXDecode'] : ['LZWDecode']);
  return allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const hit = filterNames(obj.dict, ctx.R).find((f) => banned.has(f));
    return hit === undefined ? [] : [{
      rule: 'Filters', severity: 'error' as const, clause: 'ISO 15930-4 §6.1', object,
      message: `Stream uses the prohibited /${hit} filter.`,
    }];
  });
};

const encryptionRule: Rule = (ctx) =>
  ctx.doc.trailer.get('Encrypt') === undefined ? [] : [{
    rule: 'Encryption', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: 'Document is encrypted; PDF/X forbids encryption.',
  }];

const fileIdRule: Rule = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  return isArray(id) && id.length === 2 ? [] : [{
    rule: 'FileID', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: 'Trailer has no /ID array; PDF/X requires a file identifier.',
  }];
};

const externalStreamRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && obj.dict.get('F') !== undefined
      ? [{ rule: 'ExternalStream', severity: 'error' as const, clause: 'ISO 15930-4 §6.1', object,
          message: 'Stream references external file data (/F); PDF/X requires embedded data.' }]
      : []);

const xobjectRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const sub = nameOf(ctx, obj.dict, 'Subtype');
    if (sub === 'PS' || obj.dict.get('PS') !== undefined) {
      return [{ rule: 'PostScriptXObject', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
        message: 'PostScript XObjects are prohibited in PDF/X.' }];
    }
    if (sub === 'Form' && obj.dict.get('Ref') !== undefined) {
      return [{ rule: 'ReferenceXObject', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
        message: 'Reference XObjects (/Ref) are prohibited in PDF/X.' }];
    }
    return [];
  });

const fontEmbeddedRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    const sub = nameOf(ctx, dict, 'Subtype');
    if (sub === 'Type0') {
      const desc = descendantDescriptor(ctx, dict);
      return hasFontProgram(ctx, desc) ? [] : [{
        rule: 'FontEmbedded', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
        message: 'Composite font is not embedded; PDF/X requires every font embedded.' }];
    }
    if (sub === 'Type3') return [];
    return hasFontProgram(ctx, ctx.R(dict.get('FontDescriptor'))) ? [] : [{
      rule: 'FontEmbedded', severity: 'error' as const, clause: 'ISO 15930-4 §6.2', object,
      message: 'Font is not embedded; PDF/X requires every font embedded.' }];
  });

/** The /FontDescriptor of a Type0 font's descendant. */
function descendantDescriptor(ctx: XCtx, font: PdfDict): PdfObject | undefined {
  const df = ctx.R(font.get('DescendantFonts'));
  if (!isArray(df) || df.length === 0) return undefined;
  const d = ctx.R(df[0]);
  return isDict(d) ? ctx.R(d.get('FontDescriptor')) : undefined;
}
```

Extend `RULES`:

```ts
const RULES: Rule[] = [
  identificationRule, outputIntentRule,
  trappedRule, pageGeometryRule, versionRule, filtersRule,
  encryptionRule, fileIdRule, externalStreamRule, xobjectRule, fontEmbeddedRule,
];
```

If `enumerateFonts` and `hasFontProgram` are not yet exported from `validatectx.ts`, export them there — do not duplicate the bodies.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pdfxvalidate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the geometry rule load-bearing**

Temporarily make `within` always return `true`, re-run, and confirm the `/BleedBox` test goes **red**. Revert and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add src/pdfxvalidate.ts test/helpers/build-pdfx-pdf.ts test/pdfxvalidate.test.ts
git commit -F - <<'EOF'
feat(pdfx): structural rules — trapped, page boxes, version, filters, fonts

Adds the level-gated structural rule set: /Info /Trapped, the TrimBox /
ArtBox / BleedBox geometry constraints, the version ceiling (1.4 for
1a/3, 1.6 for 4), prohibited filters, and the reused PDF/A rules for
encryption, external streams, XObjects and font embedding.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 5: Color rules

**Files:**
- Modify: `src/pdfxvalidate.ts`, `test/pdfxvalidate.test.ts`

**Interfaces:**
- Consumes: `pageScans`, `PageScan.colorSpaces` (Task 1); `pdfxOutputIntent` (Task 3).
- Produces: rule ids `ProhibitedColor`, `ColorWithoutIntent`, `OutputIntentColor`; helper `export function intentComponents(ctx: XCtx): number | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfX — color', () => {
  it('flags DeviceRGB content at 1a but not at 3 or 4', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a')).toContain('ProhibitedColor');
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '3'), '3')).not.toContain('ProhibitedColor');
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '4'), '4')).not.toContain('ProhibitedColor');
  });
  it('flags an ICCBased space at 1a', () => {
    expect(rules(buildPdfxPdf({ iccBasedSpace: true }, '1a'), '1a')).toContain('ProhibitedColor');
  });
  it('flags DeviceRGB under a CMYK output intent at 3 and 4', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '3'), '3')).toContain('ColorWithoutIntent');
    expect(rules(buildPdfxPdf({ contentColor: 'rg' }, '4'), '4')).toContain('ColorWithoutIntent');
  });
  it('accepts DeviceCMYK under a CMYK output intent', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'k' }, '4'), '4')).not.toContain('ColorWithoutIntent');
  });
  it('accepts DeviceGray under any intent', () => {
    expect(rules(buildPdfxPdf({ contentColor: 'none' }, '4'), '4')).not.toContain('ColorWithoutIntent');
  });
  it('flags an RGB output-intent profile at 1a', () => {
    expect(rules(buildPdfxPdf({ iccN: 3 }, '1a'), '1a')).toContain('OutputIntentColor');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/pdfxvalidate.test.ts -t color`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** The component count of the output-intent profile, or undefined when the
 *  profile is not embedded (registered-name and 4p forms). */
export function intentComponents(ctx: XCtx): number | undefined {
  const oi = pdfxOutputIntent(ctx);
  if (!oi) return undefined;
  const profile = ctx.R(oi.get('DestOutputProfile'));
  if (!isStream(profile)) return undefined;
  const n = ctx.R(profile.dict.get('N'));
  return typeof n === 'number' ? n : undefined;
}

/** Spaces X-1a forbids outright: everything but CMYK, Gray, and spot color. */
const X1A_PROHIBITED = new Set(['DeviceRGB', 'CalRGB', 'Lab', 'ICCBased']);

const prohibitedColorRule: Rule = (ctx) => {
  if (ctx.level !== '1a') return [];
  return pageScans(ctx).flatMap((s) => {
    const hits = [...s.colorSpaces].filter((c) => X1A_PROHIBITED.has(c));
    return hits.length === 0 ? [] : [{
      rule: 'ProhibitedColor', severity: 'error' as const, clause: 'ISO 15930-4 §6.3', page: s.page,
      message: `Page uses ${hits.join(', ')}; PDF/X-1a permits only DeviceGray, DeviceCMYK, Separation and DeviceN.`,
    }];
  });
};

const colorWithoutIntentRule: Rule = (ctx) => {
  const n = intentComponents(ctx);
  if (n === undefined) return []; // no embedded profile ⇒ nothing to disagree with
  const wanted = n === 4 ? 'DeviceCMYK' : n === 3 ? 'DeviceRGB' : undefined;
  if (wanted === undefined) return [];
  const other = wanted === 'DeviceCMYK' ? 'DeviceRGB' : 'DeviceCMYK';
  return pageScans(ctx).flatMap((s) =>
    s.colorSpaces.has(other)
      ? [{ rule: 'ColorWithoutIntent', severity: 'error' as const, clause: 'ISO 15930-6 §6.3', page: s.page,
          message: `Page uses ${other} but the output intent describes a ${wanted} condition (/N ${n}).` }]
      : []);
};

const outputIntentColorRule: Rule = (ctx) => {
  if (ctx.level !== '1a') return [];
  const n = intentComponents(ctx);
  if (n === undefined || n === 4 || n === 1) return [];
  return [{ rule: 'OutputIntentColor', severity: 'error', clause: 'ISO 15930-4 §6.3',
    message: `Output-intent profile has /N ${n}; PDF/X-1a requires a CMYK (4) or Gray (1) condition.` }];
};
```

Add all three to `RULES`. Note the ordering interaction the tests encode: at X-1a a `DeviceRGB` page trips `ProhibitedColor` *and* `ColorWithoutIntent`; both firing is correct and the tests assert per-rule membership, not exact lists.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pdfxvalidate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the scan drives these rules**

Temporarily make `pageScans` return `[]`, re-run, and confirm the `ProhibitedColor` and `ColorWithoutIntent` tests go **red** while `OutputIntentColor` stays green (it reads the profile, not the scan). Revert and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/pdfxvalidate.ts test/helpers/build-pdfx-pdf.ts test/pdfxvalidate.test.ts
git commit -F - <<'EOF'
feat(pdfx): color rules

X-1a admits only DeviceGray/DeviceCMYK/Separation/DeviceN; X-3 and X-4
admit device-independent color but must not contradict the output
intent's component count.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 6: Transparency, optional content, embedded files, transfer functions and halftones

**Files:**
- Modify: `src/pdfxvalidate.ts`, `test/pdfxvalidate.test.ts`

**Interfaces:**
- Consumes: `allObjects`, `extGStates`, `blendModeName` from `validatectx.js`.
- Produces: rule ids `Transparency`, `OptionalContent`, `EmbeddedFiles`, `TransferHalftone`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfX — transparency and layers', () => {
  it('flags a transparency group at 1a and 3 but not at 4', () => {
    expect(rules(buildPdfxPdf({ transparencyGroup: true }, '1a'), '1a')).toContain('Transparency');
    expect(rules(buildPdfxPdf({ transparencyGroup: true }, '3'), '3')).toContain('Transparency');
    expect(rules(buildPdfxPdf({ transparencyGroup: true }, '4'), '4')).not.toContain('Transparency');
  });
  it('flags ExtGState /ca below 1 at 3', () => {
    expect(rules(buildPdfxPdf({ lowAlpha: true }, '3'), '3')).toContain('Transparency');
  });
  it('flags optional content at 3 but not at 4', () => {
    expect(rules(buildPdfxPdf({ optionalContent: true }, '3'), '3')).toContain('OptionalContent');
    expect(rules(buildPdfxPdf({ optionalContent: true }, '4'), '4')).not.toContain('OptionalContent');
  });
  it('flags an embedded file at 1a but not at 4', () => {
    expect(rules(buildPdfxPdf({ embeddedFile: true }, '1a'), '1a')).toContain('EmbeddedFiles');
    expect(rules(buildPdfxPdf({ embeddedFile: true }, '4'), '4')).not.toContain('EmbeddedFiles');
  });
});

describe('ValidatePdfX — transfer functions and halftones', () => {
  it('flags an ExtGState transfer function', () => {
    expect(rules(buildPdfxPdf({ transferFunction: true }))).toContain('TransferHalftone');
  });
  it('flags a halftone of a prohibited type', () => {
    expect(rules(buildPdfxPdf({ badHalftone: true }))).toContain('TransferHalftone');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/pdfxvalidate.test.ts -t "transparency|halftone"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Reuse `isLegacy` from Task 3 — X-1a and X-3 are exactly the levels that prohibit
live transparency, optional content and embedded files. Do not introduce a second
predicate with the same body.

```ts
const transparencyRule: Rule = (ctx) => {
  if (!isLegacy(ctx.level)) return [];
  const issues: ValidationIssue[] = [];
  for (const [object, obj] of allObjects(ctx)) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!dict) continue;
    const grp = ctx.R(dict.get('Group'));
    if (isDict(grp) && nameOf(ctx, grp, 'S') === 'Transparency') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
        message: `Transparency group is prohibited in ${xVersionString(ctx.level)}.` });
    }
  }
  for (const { ref: object, dict } of extGStates(ctx)) {
    const sm = ctx.R(dict.get('SMask'));
    if (sm !== undefined && !(isName(sm) && sm.name === 'None')) {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
        message: 'ExtGState /SMask other than /None implies transparency.' });
    }
    const bm = blendModeName(ctx, dict);
    if (bm && bm !== 'Normal' && bm !== 'Compatible') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
        message: `ExtGState blend mode '${bm}' implies transparency.` });
    }
    for (const k of ['CA', 'ca']) {
      const v = ctx.R(dict.get(k));
      if (typeof v === 'number' && v < 1) {
        issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 15930-4 §6.4', object,
          message: `ExtGState /${k} ${v} (< 1) implies transparency.` });
      }
    }
  }
  return issues;
};

const optionalContentRule: Rule = (ctx) => {
  if (!isLegacy(ctx.level)) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  return [{ rule: 'OptionalContent', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: `Optional content (/OCProperties) is prohibited in ${xVersionString(ctx.level)}.` }];
};

const embeddedFilesRule: Rule = (ctx) => {
  if (!isLegacy(ctx.level)) return []; // X-4 permits embedded files
  // /FileAttachment annotations are the annotationsRule's business (Task 7);
  // reporting them here too would surface one defect under two rule ids.
  const names = ctx.R(ctx.catalog.get('Names'));
  if (!isDict(names) || names.get('EmbeddedFiles') === undefined) return [];
  return [{ rule: 'EmbeddedFiles', severity: 'error', clause: 'ISO 15930-4 §6.1',
    message: `Embedded files are prohibited in ${xVersionString(ctx.level)}.` }];
};

/** Halftone dictionary types PDF/X permits. */
const ALLOWED_HALFTONE_TYPES = new Set([1, 5]);

const transferHalftoneRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict } of extGStates(ctx)) {
    for (const k of ['TR', 'TR2']) {
      const v = ctx.R(dict.get(k));
      if (v !== undefined && !(isName(v) && v.name === 'Default')) {
        issues.push({ rule: 'TransferHalftone', severity: 'error', clause: 'ISO 15930-4 §6.2', object,
          message: `ExtGState /${k} transfer function is prohibited in PDF/X.` });
      }
    }
    if (dict.get('HTP') !== undefined) {
      issues.push({ rule: 'TransferHalftone', severity: 'error', clause: 'ISO 15930-4 §6.2', object,
        message: 'ExtGState /HTP is prohibited in PDF/X.' });
    }
    const ht = ctx.R(dict.get('HT'));
    const htDict = isStream(ht) ? ht.dict : isDict(ht) ? ht : undefined;
    if (htDict) {
      const t = ctx.R(htDict.get('HalftoneType'));
      if (typeof t === 'number' && !ALLOWED_HALFTONE_TYPES.has(t)) {
        issues.push({ rule: 'TransferHalftone', severity: 'error', clause: 'ISO 15930-4 §6.2', object,
          message: `Halftone type ${t} is prohibited; PDF/X permits types 1 and 5.` });
      }
    }
  }
  return issues;
};
```

Add all four to `RULES` and extend the `validatectx.js` import with `extGStates` and `blendModeName`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pdfxvalidate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdfxvalidate.ts test/helpers/build-pdfx-pdf.ts test/pdfxvalidate.test.ts
git commit -F - <<'EOF'
feat(pdfx): transparency, optional content, embedded files, halftone rules

Level-gated: X-1a and X-3 prohibit live transparency, layers and embedded
files; X-4 permits all three. Transfer functions and non-type-1/5
halftones are prohibited everywhere.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 7: Annotation and action rules

**Files:**
- Modify: `src/pdfxvalidate.ts`, `test/pdfxvalidate.test.ts`

**Interfaces:**
- Consumes: `eachAnnotation` from `validatectx.js`; `rect`/`within` from Task 4.
- Produces: rule ids `Annotations`, `Actions`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfX — annotations and actions', () => {
  it('flags an annotation overlapping the trim area', () => {
    expect(rules(buildPdfxPdf({ annotInsideTrim: true }))).toContain('Annotations');
  });
  it('flags a prohibited annotation subtype', () => {
    expect(rules(buildPdfxPdf({ movieAnnot: true }))).toContain('Annotations');
  });
  it('flags a JavaScript action', () => {
    expect(rules(buildPdfxPdf({ jsAction: true }))).toContain('Actions');
  });
});
```

The `annotInsideTrim` knob places a `/Text` annot at `/Rect [50 50 60 60]`, inside the baseline `/TrimBox [10 10 190 190]`. The `movieAnnot` knob places a `/Movie` annot at `/Rect [0 0 5 5]` — outside the trim box, so it can only trip on subtype.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/pdfxvalidate.test.ts -t "annotations and actions"`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** `FileAttachment` is prohibited only where embedded files are — X-4 permits
 *  both, so this must stay consistent with `embeddedFilesRule` (Task 6). */
function annotProhibited(ctx: XCtx, subtype: string): boolean {
  if (PROHIBITED_ANNOTS.has(subtype)) return true;
  return subtype === 'FileAttachment' && isLegacy(ctx.level);
}

/** True when the two rectangles share any area. */
function overlaps(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

const annotationsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    const sub = nameOf(ctx, dict, 'Subtype');
    if (sub !== undefined && annotProhibited(ctx, sub)) {
      issues.push({ rule: 'Annotations', severity: 'error', clause: 'ISO 15930-4 §6.5', object, page,
        message: `Annotation subtype /${sub} is prohibited in ${xVersionString(ctx.level)}.` });
      continue;
    }
    if (sub === 'Popup' || sub === 'Link') continue; // no printed mark of their own
    const r = rect(ctx, dict.get('Rect'));
    const zone = rect(ctx, page.Dict.get('BleedBox')) ?? rect(ctx, page.Dict.get('TrimBox'))
      ?? rect(ctx, page.Dict.get('ArtBox'));
    if (r && zone && overlaps(r, zone)) {
      issues.push({ rule: 'Annotations', severity: 'error', clause: 'ISO 15930-4 §6.5', object, page,
        message: 'Annotation /Rect overlaps the trim/bleed area; PDF/X requires annotations outside it.' });
    }
  }
  return issues;
};

const PROHIBITED_ACTIONS = new Set(['JavaScript', 'Launch', 'Movie', 'Sound', 'ImportData', 'ResetForm', 'URI']);

/** Every /S action type reachable from `actionObj` through /Next chains. */
function collectActionTypes(ctx: XCtx, actionObj: PdfObject | undefined, seen = new Set<PdfDict>()): string[] {
  const a = ctx.R(actionObj);
  if (!isDict(a) || seen.has(a)) return [];
  seen.add(a);
  const out: string[] = [];
  const s = nameOf(ctx, a, 'S');
  if (s !== undefined) out.push(s);
  const next = ctx.R(a.get('Next'));
  if (isArray(next)) for (const n of next) out.push(...collectActionTypes(ctx, n, seen));
  else if (isDict(next)) out.push(...collectActionTypes(ctx, a.get('Next'), seen));
  return out;
}

const actionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const check = (obj: PdfObject | undefined, where: string): void => {
    for (const t of collectActionTypes(ctx, obj)) {
      if (PROHIBITED_ACTIONS.has(t)) {
        issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 15930-4 §6.5',
          message: `${where} uses the prohibited /${t} action.` });
      }
    }
  };
  check(ctx.catalog.get('OpenAction'), 'Catalog /OpenAction');
  const aa = ctx.R(ctx.catalog.get('AA'));
  if (isDict(aa)) for (const v of aa.values()) check(v, 'Catalog /AA');
  for (const { dict } of eachAnnotation(ctx)) {
    check(dict.get('A'), 'Annotation /A');
    const annotAa = ctx.R(dict.get('AA'));
    if (isDict(annotAa)) for (const v of annotAa.values()) check(v, 'Annotation /AA');
  }
  return issues;
};
```

Add both to `RULES`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pdfxvalidate.test.ts && npm run typecheck`
Expected: PASS. The clean-document tests must still report zero errors — if the baseline fixture's annotations now trip `Annotations`, the fixture is wrong, not the rule.

- [ ] **Step 5: Commit**

```bash
git add src/pdfxvalidate.ts test/helpers/build-pdfx-pdf.ts test/pdfxvalidate.test.ts
git commit -F - <<'EOF'
feat(pdfx): annotation and action rules

Annotations must sit outside the trim/bleed area and may not use the
prohibited subtypes; JavaScript, Launch, URI and the other interactive
actions are prohibited.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 8: `ConvertToPdfX` — structural passes

**Files:**
- Create: `src/pdfxconvert.ts`, `test/pdfxconvert.test.ts`
- Modify: `src/document.ts` (add `ConvertToPdfX`; drop `private` from `ensureInfo`), `src/index.ts`

**Interfaces:**
- Consumes: `validatePdfX`, `PdfXLevel`, `xVersionString`, `pdfxIntents` (Tasks 3–7); `ConvertAction`/`ConversionReport` from `conversion.js`; `ConvertCategory` from `pdfaconvert.js`; `XmpMetadata.pdfxVersion` (Task 2).
- Produces:
  ```ts
  export interface PdfXConvertOptions {
    iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
    outputCondition?: string;
    outputProfileRef?: string;
    trapped?: 'True' | 'False';
    convertColor?: boolean;
    preserve?: ConvertCategory[];
  }
  export function convertToPdfX(
    doc: Document, catalog: PdfDict, level: PdfXLevel, opts?: PdfXConvertOptions,
  ): ConversionReport;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/pdfxconvert.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfxPdf } from './helpers/build-pdfx-pdf.js';

const convert = (bytes: Uint8Array, level: any = '4', opts?: any) => {
  const doc = Document.Open(bytes);
  const report = doc.ConvertToPdfX(level, opts);
  return { doc, report, reopened: () => Document.Open(doc.Save()) };
};

describe('ConvertToPdfX — identification', () => {
  it('writes pdfxid and the /Info key, and the result validates', () => {
    const { report, reopened } = convert(buildPdfxPdf({ omitXmp: true, omitInfoVersion: true }, '3'), '3');
    expect(report.applied.map((a) => a.rule)).toContain('PdfxIdentification');
    expect(reopened().ValidatePdfX('3').Errors.map((e) => e.rule))
      .not.toContain('PdfxIdentification');
  });
});

describe('ConvertToPdfX — output intent', () => {
  it('adds a registered-name intent when no profile is supplied', () => {
    const { report, reopened } = convert(buildPdfxPdf({ omitOutputIntent: true }));
    expect(report.applied.map((a) => a.rule)).toContain('OutputIntent');
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('OutputIntent');
  });

  it('embeds a supplied profile', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { reopened } = convert(buildPdfxPdf({ omitOutputIntent: true }), '4',
      { iccProfile: { bytes, n: 4, identifier: 'Custom CMYK' } });
    const doc = reopened();
    expect(doc.ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('OutputIntent');
  });

  it('leaves an existing conformant intent alone', () => {
    const { report } = convert(buildPdfxPdf({}));
    expect(report.applied.map((a) => a.rule)).not.toContain('OutputIntent');
  });
});

describe('ConvertToPdfX — structure', () => {
  it('writes /Trapped when absent', () => {
    const { report, reopened } = convert(buildPdfxPdf({ omitTrapped: true }));
    expect(report.applied.map((a) => a.rule)).toContain('Trapped');
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('Trapped');
  });

  it('honours opts.trapped', () => {
    const { doc } = convert(buildPdfxPdf({ omitTrapped: true }), '4', { trapped: 'True' });
    const reopened = Document.Open(doc.Save());
    expect(reopened.ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('Trapped');
  });

  it('adds a /TrimBox from the /MediaBox when absent', () => {
    const { report, reopened } = convert(buildPdfxPdf({ omitTrimBox: true }));
    expect(report.applied.map((a) => a.rule)).toContain('PageGeometry');
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('PageGeometry');
  });

  it('removes prohibited annotations and actions', () => {
    const { report, reopened } = convert(buildPdfxPdf({ movieAnnot: true, jsAction: true }));
    const applied = report.applied.map((a) => a.rule);
    expect(applied).toContain('Annotations');
    expect(applied).toContain('Actions');
    const errors = reopened().ValidatePdfX('4').Errors.map((e) => e.rule);
    expect(errors).not.toContain('Annotations');
    expect(errors).not.toContain('Actions');
  });

  it('strips transfer functions', () => {
    const { reopened } = convert(buildPdfxPdf({ transferFunction: true }));
    expect(reopened().ValidatePdfX('4').Errors.map((e) => e.rule)).not.toContain('TransferHalftone');
  });

  it('converts a plain fixture to a passing X-4 document', () => {
    const { report } = convert(buildPdfxPdf({
      omitXmp: true, omitOutputIntent: true, omitTrapped: true, omitTrimBox: true,
    }));
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe('ConvertToPdfX — what it refuses to fix', () => {
  it('reports live transparency at 1a as unresolved rather than flattening', () => {
    const { report } = convert(buildPdfxPdf({ lowAlpha: true }, '1a'), '1a');
    expect(report.unresolved.map((e) => e.rule)).toContain('Transparency');
    expect(report.passed).toBe(false);
  });

  it('leaves an annotation inside the trim area in place', () => {
    const { report } = convert(buildPdfxPdf({ annotInsideTrim: true }));
    expect(report.unresolved.map((e) => e.rule)).toContain('Annotations');
  });

  it('reports RGB content at 1a as unresolved when convertColor is off', () => {
    const { report } = convert(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a');
    expect(report.unresolved.map((e) => e.rule)).toContain('ProhibitedColor');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/pdfxconvert.test.ts`
Expected: FAIL — `ConvertToPdfX is not a function`.

- [ ] **Step 3: Make `ensureInfo` reachable**

In `src/document.ts:868`, change the signature (keeping the body):

```ts
  /** @internal The /Info dictionary, created and linked from the trailer when
   *  absent. Used by the metadata setters and the PDF/X converter. */
  ensureInfo(): PdfDict {
```

- [ ] **Step 4: Write `src/pdfxconvert.ts`**

```ts
import type { Document } from './document.js';
import { PdfObject, PdfDict, PdfRef, isName, isDict, isArray, isRef, isStream, name } from './types.js';
import type { Page } from './page.js';
import type { ConvertAction, ConversionReport } from './conversion.js';
export type { ConvertAction, ConversionReport } from './conversion.js';
import type { ConvertCategory } from './pdfaconvert.js';
import { validatePdfX, xVersionString, type PdfXLevel } from './pdfxvalidate.js';

export interface PdfXConvertOptions {
  /** Output-intent ICC profile to embed. Omitted → a registered-name intent. */
  iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
  /** Registered characterization name used when no profile is embedded. */
  outputCondition?: string;
  /** External profile URL/filename, required for '4p' without an embedded profile. */
  outputProfileRef?: string;
  /** /Info /Trapped value written when absent or /Unknown. Default 'False'. */
  trapped?: 'True' | 'False';
  /** Opt-in naive DeviceRGB → DeviceCMYK content rewrite. Default false. */
  convertColor?: boolean;
  /** Destructive-removal categories to skip (then reported unresolved). */
  preserve?: ConvertCategory[];
}

export interface XCctx {
  doc: Document;
  catalog: PdfDict;
  level: PdfXLevel;
  opts: PdfXConvertOptions;
  preserve: Set<ConvertCategory>;
  condition: string;
  R(o: PdfObject | undefined): PdfObject;
}

type Pass = (ctx: XCctx) => ConvertAction[];

/** The default registered characterization name: US commercial offset. */
const DEFAULT_CONDITION = 'CGATS TR 001';

/** Remediate `doc` toward PDF/X `level`, then re-validate. The facade supplies
 *  the catalog (mirrors convertToPdfA). Mutates the live model in place. */
export function convertToPdfX(
  doc: Document, catalog: PdfDict, level: PdfXLevel, opts: PdfXConvertOptions = {},
): ConversionReport {
  const ctx: XCctx = {
    doc, catalog, level, opts,
    preserve: new Set(opts.preserve ?? []),
    condition: opts.outputCondition ?? DEFAULT_CONDITION,
    R: (o) => doc.resolve(o),
  };
  const applied: ConvertAction[] = [];
  for (const pass of PASSES) applied.push(...pass(ctx));
  const unresolved = validatePdfX(doc, catalog, level).Errors;
  return { applied, unresolved, passed: unresolved.length === 0 };
}

const nameOf = (ctx: XCctx, dict: PdfDict, key: string): string | undefined => {
  const v = ctx.R(dict.get(key));
  return isName(v) ? v.name : undefined;
};

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

// ---- passes ----------------------------------------------------------------

const identificationPass: Pass = (ctx) => {
  const version = xVersionString(ctx.level);
  ctx.doc.SetXmp({ pdfxVersion: version });
  const actions: ConvertAction[] = [
    { rule: 'PdfxIdentification', action: `Wrote pdfxid:GTS_PDFXVersion '${version}' to XMP.` },
  ];
  if (ctx.level === '1a' || ctx.level === '3') {
    ctx.doc.ensureInfo().set('GTS_PDFXVersion', str(version));
    actions.push({ rule: 'PdfxIdentification', action: `Wrote /Info /GTS_PDFXVersion '${version}'.` });
  }
  return actions;
};

const versionPass: Pass = (ctx) => {
  const ceiling = ctx.level === '1a' || ctx.level === '3' ? '1.4' : '1.6';
  const cur = ctx.doc.headerVersion();
  if (cur !== undefined && Number(cur) <= Number(ceiling) + 1e-9) return [];
  ctx.catalog.set('Version', name(ceiling));
  return [{ rule: 'Version', action: `Set catalog /Version to ${ceiling}.` }];
};

const fileIdPass: Pass = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  if (isArray(id) && id.length === 2) return [];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = (i * 37 + 11) & 0xff;
  const s = { kind: 'string' as const, bytes };
  ctx.doc.trailer.set('ID', [s, s]);
  return [{ rule: 'FileID', action: 'Generated a trailer /ID.' }];
};

const outputIntentPass: Pass = (ctx) => {
  const existing = ctx.R(ctx.catalog.get('OutputIntents'));
  const intents = isArray(existing) ? existing : [];
  const conformant = intents.some((e) => {
    const oi = ctx.R(e);
    if (!isDict(oi) || nameOf(ctx, oi, 'S') !== 'GTS_PDFX') return false;
    if (isStream(ctx.R(oi.get('DestOutputProfile')))) return true;
    return ctx.level === '4p' && isDict(ctx.R(oi.get('DestOutputProfileRef')));
  });
  if (conformant) return [];

  const oi: PdfDict = new Map<string, PdfObject>([
    ['Type', name('OutputIntent')],
    ['S', name('GTS_PDFX')],
    ['OutputCondition', str('Commercial and specialty printing')],
    ['RegistryName', str('http://www.color.org')],
  ]);
  let object: PdfRef | undefined;
  let how: string;
  if (ctx.opts.iccProfile) {
    const { bytes, n, identifier } = ctx.opts.iccProfile;
    const profile: PdfDict = new Map<string, PdfObject>([['N', n], ['Length', bytes.length]]);
    object = ctx.doc.allocObject({ kind: 'stream', dict: profile, raw: bytes });
    oi.set('OutputConditionIdentifier', str(identifier ?? 'Custom'));
    oi.set('DestOutputProfile', object);
    how = `embedded ${identifier ?? 'custom'} profile`;
  } else if (ctx.level === '4p' && ctx.opts.outputProfileRef !== undefined) {
    const fs: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Filespec')],
      ['FS', name('URL')],
      ['F', str(ctx.opts.outputProfileRef)],
    ]);
    oi.set('OutputConditionIdentifier', str(ctx.condition));
    oi.set('DestOutputProfileRef', fs);
    how = `external profile reference ${ctx.opts.outputProfileRef}`;
  } else {
    oi.set('OutputConditionIdentifier', str(ctx.condition));
    how = `registered condition '${ctx.condition}'`;
  }
  // Replace any non-conformant PDF/X intents; leave other subtypes (e.g. PDF/A) intact.
  const kept = intents.filter((e) => {
    const d = ctx.R(e);
    return !(isDict(d) && nameOf(ctx, d, 'S') === 'GTS_PDFX');
  });
  ctx.catalog.set('OutputIntents', [...kept, oi]);
  return [{ rule: 'OutputIntent', action: `Added a PDF/X OutputIntent (${how}).`, object }];
};

const trappedPass: Pass = (ctx) => {
  const info = ctx.doc.ensureInfo();
  const cur = ctx.R(info.get('Trapped'));
  const val = isName(cur) ? cur.name : undefined;
  if (val === 'True' || val === 'False') return [];
  const want = ctx.opts.trapped ?? 'False';
  info.set('Trapped', name(want));
  return [{ rule: 'Trapped', action: `Set /Info /Trapped to /${want}.` }];
};

const pageGeometryPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  for (const page of ctx.doc.Pages) {
    if (page.Dict.get('TrimBox') !== undefined && page.Dict.get('ArtBox') !== undefined) {
      page.Dict.delete('ArtBox');
      actions.push({ rule: 'PageGeometry', action: 'Removed /ArtBox (page also has /TrimBox).', page });
      continue;
    }
    if (page.Dict.get('TrimBox') !== undefined || page.Dict.get('ArtBox') !== undefined) continue;
    const src = ctx.R(page.Dict.get('CropBox')) ?? ctx.R(page.Dict.get('MediaBox'));
    if (!isArray(src)) continue;
    page.Dict.set('TrimBox', [...src]);
    actions.push({ rule: 'PageGeometry', action: 'Added /TrimBox from the /CropBox or /MediaBox.', page });
  }
  return actions;
};

/** Every annotation dict across all pages, with the array that holds it. */
function eachAnnotation(ctx: XCctx): { ref?: PdfRef; dict: PdfDict; page: Page }[] {
  const out: { ref?: PdfRef; dict: PdfDict; page: Page }[] = [];
  for (const page of ctx.doc.Pages) {
    const arr = ctx.R(page.Dict.get('Annots'));
    if (!isArray(arr)) continue;
    for (const a of arr) {
      const d = ctx.R(a);
      if (isDict(d)) out.push({ ref: isRef(a) ? a : undefined, dict: d, page });
    }
  }
  return out;
}

/** Drop `target` from its page's /Annots array. */
function removeAnnot(ctx: XCctx, page: Page, target: PdfDict): void {
  const arr = ctx.R(page.Dict.get('Annots'));
  if (!isArray(arr)) return;
  page.Dict.set('Annots', arr.filter((e) => ctx.R(e) !== target));
}

const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** Mirrors the validator's rule: /FileAttachment is prohibited only at the
 *  levels that also prohibit embedded files, so X-4 keeps its attachments. */
function annotProhibited(ctx: XCctx, subtype: string): boolean {
  if (PROHIBITED_ANNOTS.has(subtype)) return true;
  return subtype === 'FileAttachment' && (ctx.level === '1a' || ctx.level === '3');
}

const annotationPass: Pass = (ctx) => {
  if (ctx.preserve.has('multimedia')) return [];
  const actions: ConvertAction[] = [];
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    const sub = nameOf(ctx, dict, 'Subtype');
    if (sub !== undefined && annotProhibited(ctx, sub)) {
      removeAnnot(ctx, page, dict);
      actions.push({ rule: 'Annotations', action: `Removed prohibited /${sub} annotation.`, object, page });
    }
  }
  return actions;
};

const PROHIBITED_ACTIONS = new Set(['JavaScript', 'Launch', 'Movie', 'Sound', 'ImportData', 'ResetForm', 'URI']);

/** True when the action (or anything in its /Next chain) is prohibited. */
function isProhibitedAction(ctx: XCctx, actionObj: PdfObject | undefined, seen = new Set<PdfDict>()): boolean {
  const a = ctx.R(actionObj);
  if (!isDict(a) || seen.has(a)) return false;
  seen.add(a);
  const s = nameOf(ctx, a, 'S');
  if (s !== undefined && PROHIBITED_ACTIONS.has(s)) return true;
  const next = ctx.R(a.get('Next'));
  if (isArray(next)) return next.some((n) => isProhibitedAction(ctx, n, seen));
  return isProhibitedAction(ctx, a.get('Next'), seen);
}

const actionsPass: Pass = (ctx) => {
  if (ctx.preserve.has('javascript')) return [];
  const actions: ConvertAction[] = [];
  if (isProhibitedAction(ctx, ctx.catalog.get('OpenAction'))) {
    ctx.catalog.delete('OpenAction');
    actions.push({ rule: 'Actions', action: 'Removed the prohibited catalog /OpenAction.' });
  }
  const aa = ctx.R(ctx.catalog.get('AA'));
  if (isDict(aa)) {
    for (const k of [...aa.keys()]) {
      if (isProhibitedAction(ctx, aa.get(k))) aa.delete(k);
    }
    if (aa.size === 0) ctx.catalog.delete('AA');
    actions.push({ rule: 'Actions', action: 'Removed prohibited catalog /AA entries.' });
  }
  for (const { object, dict, page } of eachAnnotation(ctx).map((a) => ({ ...a, object: a.ref }))) {
    if (isProhibitedAction(ctx, dict.get('A'))) {
      dict.delete('A');
      actions.push({ rule: 'Actions', action: 'Removed a prohibited annotation /A action.', object, page });
    }
    const annotAa = ctx.R(dict.get('AA'));
    if (isDict(annotAa)) {
      for (const k of [...annotAa.keys()]) {
        if (isProhibitedAction(ctx, annotAa.get(k))) annotAa.delete(k);
      }
      if (annotAa.size === 0) dict.delete('AA');
    }
  }
  return actions;
};

const optionalContentPass: Pass = (ctx) => {
  if (ctx.level === '4' || ctx.level === '4p') return [];
  if (ctx.preserve.has('optionalContent')) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  ctx.catalog.delete('OCProperties');
  return [{ rule: 'OptionalContent', action: 'Removed catalog /OCProperties.' }];
};

const embeddedFilesPass: Pass = (ctx) => {
  if (ctx.level === '4' || ctx.level === '4p') return [];
  if (ctx.preserve.has('embeddedFiles')) return [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (!isDict(names) || names.get('EmbeddedFiles') === undefined) return [];
  names.delete('EmbeddedFiles');
  if (names.size === 0) ctx.catalog.delete('Names');
  return [{ rule: 'EmbeddedFiles', action: 'Removed the /Names /EmbeddedFiles tree.' }];
};

/** Every distinct ExtGState dict from page and Form XObject resources. */
function extGStates(ctx: XCctx): PdfDict[] {
  const out: PdfDict[] = [];
  const seen = new Set<PdfDict>();
  const seenRes = new Set<PdfDict>();
  const visit = (resObj: PdfObject | undefined): void => {
    const res = ctx.R(resObj);
    if (!isDict(res) || seenRes.has(res)) return;
    seenRes.add(res);
    const egs = ctx.R(res.get('ExtGState'));
    if (isDict(egs)) for (const v of egs.values()) {
      const d = ctx.R(v);
      if (isDict(d) && !seen.has(d)) { seen.add(d); out.push(d); }
    }
    const xobjs = ctx.R(res.get('XObject'));
    if (isDict(xobjs)) for (const v of xobjs.values()) {
      const x = ctx.R(v);
      if (isStream(x)) visit(x.dict.get('Resources'));
    }
  };
  for (const page of ctx.doc.Pages) visit(page.Resources);
  return out;
}

const ALLOWED_HALFTONE_TYPES = new Set([1, 5]);

const transferHalftonePass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  for (const dict of extGStates(ctx)) {
    for (const k of ['TR', 'TR2', 'HTP']) {
      if (dict.get(k) !== undefined) {
        dict.delete(k);
        actions.push({ rule: 'TransferHalftone', action: `Removed ExtGState /${k}.` });
      }
    }
    const ht = ctx.R(dict.get('HT'));
    const htDict = isStream(ht) ? ht.dict : isDict(ht) ? ht : undefined;
    if (htDict) {
      const t = ctx.R(htDict.get('HalftoneType'));
      if (typeof t === 'number' && !ALLOWED_HALFTONE_TYPES.has(t)) {
        dict.delete('HT');
        actions.push({ rule: 'TransferHalftone', action: `Removed a type-${t} halftone.` });
      }
    }
  }
  return actions;
};

const PASSES: Pass[] = [
  identificationPass, versionPass, fileIdPass, outputIntentPass, trappedPass,
  pageGeometryPass, annotationPass, actionsPass, optionalContentPass,
  embeddedFilesPass, transferHalftonePass,
];
```

- [ ] **Step 5: Wire the facade**

In `src/document.ts`:

```ts
import { convertToPdfX, type PdfXConvertOptions } from './pdfxconvert.js';
```

```ts
  /** Remediate the document toward PDF/X `level`, then re-validate. Mutates the
   *  live model in place; the result is emitted by the next Save(). Defects that
   *  cannot be fixed mechanically (live transparency, non-embeddable fonts, RGB
   *  raster images) are reported in `unresolved`, not silently altered. */
  ConvertToPdfX(level: PdfXLevel, opts?: PdfXConvertOptions): ConversionReport {
    this.markModified();
    return convertToPdfX(this, this.catalog(), level, opts);
  }
```

In `src/index.ts`:

```ts
export type { PdfXConvertOptions } from './pdfxconvert.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/pdfxconvert.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Prove the passes load-bearing**

Temporarily replace `PASSES` with `[]`, re-run, and confirm every `ConvertToPdfX` test except the three in "what it refuses to fix" goes **red**. Revert and re-run to green.

- [ ] **Step 8: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/pdfxconvert.ts src/document.ts src/index.ts test/pdfxconvert.test.ts
git commit -F - <<'EOF'
feat(pdfx): ConvertToPdfX structural passes

Identification, output intent (registered-name by default, embedded or
externally referenced on request), /Trapped, page boxes, prohibited
annotations and actions, layers, embedded files, transfer functions.
Live transparency, non-embeddable fonts and RGB rasters are reported
unresolved rather than silently altered.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 9: Opt-in `DeviceRGB → DeviceCMYK` content rewrite

**Files:**
- Create: `src/pdfxcolor.ts`
- Modify: `src/pdfxconvert.ts`, `test/pdfxconvert.test.ts`

**Interfaces:**
- Consumes: `EditableContent` from `editcontent.js` (`topOps`/`setTopOps`/`xobjectOps`/`setXobjectOps`/`editedXObjectPaths`/`commit`); `XCctx` (Task 8).
- Produces: `export function rewriteRgbToCmyk(doc: Document, page: Page): number` — returns the number of operators rewritten.

- [ ] **Step 1: Write the failing tests**

Append to `test/pdfxconvert.test.ts`:

```ts
describe('ConvertToPdfX — opt-in color conversion', () => {
  it('leaves RGB content alone by default', () => {
    const { report } = convert(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a');
    expect(report.applied.map((a) => a.rule)).not.toContain('ProhibitedColor');
    expect(report.unresolved.map((e) => e.rule)).toContain('ProhibitedColor');
  });

  it('rewrites rg to k when convertColor is set', () => {
    const { report, reopened } = convert(buildPdfxPdf({ contentColor: 'rg' }, '1a'), '1a',
      { convertColor: true, iccProfile: { bytes: new Uint8Array([1, 2, 3, 4]), n: 4, identifier: 'CMYK' } });
    expect(report.applied.map((a) => a.rule)).toContain('ProhibitedColor');
    expect(reopened().ValidatePdfX('1a').Errors.map((e) => e.rule)).not.toContain('ProhibitedColor');
  });

  it('maps pure red to 0 1 1 0 k', () => {
    const doc = Document.Open(buildPdfxPdf({ contentColor: 'rg' }, '1a'));
    doc.ConvertToPdfX('1a', { convertColor: true });
    const text = new TextDecoder().decode(Document.Open(doc.Save()).Pages[0].GetContent());
    expect(text).toContain('0 1 1 0 k');
    expect(text).not.toContain('rg');
  });
});
```

The builder's `contentColor: 'rg'` knob must emit exactly `1 0 0 rg` so the expected CMYK is deterministic. If `Page.GetContent()` does not exist under that name, use the accessor the existing content tests use (check `test/editcontent.test.ts`) — do not add a new public method for the test's convenience.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run test/pdfxconvert.test.ts -t "color conversion"`
Expected: FAIL.

- [ ] **Step 3: Write `src/pdfxcolor.ts`**

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import { EditableContent } from './editcontent.js';
import { isName, name, type PdfObject } from './types.js';
import type { ContentOp } from './content.js';

/** Naive RGB → CMYK: maximum black removal, no color management. The result is
 *  not colorimetrically correct — it exists so a document can reach PDF/X-1a's
 *  structural requirements, not to produce accurate ink values. */
export function rgbToCmyk(r: number, g: number, b: number): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 1) return [0, 0, 0, 1];
  const d = 1 - k;
  return [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k];
}

/** Round to 4 decimals and strip the trailing zeros PDF numbers do not need. */
const num = (v: number): number => Number(v.toFixed(4));

/** Rewrite one operator list, returning the new list and how many ops changed. */
function rewriteOps(ops: readonly ContentOp[]): { ops: ContentOp[]; changed: number } {
  let changed = 0;
  const out = ops.map((op) => {
    if ((op.operator === 'rg' || op.operator === 'RG') && op.operands.length === 3) {
      const [r, g, b] = op.operands.map((o) => (typeof o === 'number' ? o : 0));
      const cmyk = rgbToCmyk(r, g, b).map(num) as PdfObject[];
      changed++;
      return { ...op, operator: op.operator === 'rg' ? 'k' : 'K', operands: cmyk };
    }
    if ((op.operator === 'cs' || op.operator === 'CS') && op.operands.length === 1) {
      const a = op.operands[0];
      if (isName(a) && (a.name === 'DeviceRGB' || a.name === 'RGB')) {
        changed++;
        return { ...op, operands: [name('DeviceCMYK')] };
      }
    }
    // sc/scn in a DeviceRGB space: three numeric operands.
    if ((op.operator === 'sc' || op.operator === 'scn' || op.operator === 'SC' || op.operator === 'SCN')
        && op.operands.length === 3 && op.operands.every((o) => typeof o === 'number')) {
      const [r, g, b] = op.operands as number[];
      const cmyk = rgbToCmyk(r, g, b).map(num) as PdfObject[];
      changed++;
      return { ...op, operands: cmyk };
    }
    return op;
  });
  return { ops: out, changed };
}

/** Rewrite a page's DeviceRGB color operators to DeviceCMYK, including the
 *  Form XObjects it draws. Returns the number of operators changed. */
export function rewriteRgbToCmyk(doc: Document, page: Page): number {
  const edit = new EditableContent(doc, page);
  let changed = 0;
  const top = edit.topOps(0);
  const first = rewriteOps(top);
  if (first.changed > 0) { edit.setTopOps(0, first.ops); changed += first.changed; }
  for (const path of edit.editedXObjectPaths()) {
    const r = rewriteOps(edit.xobjectOps(path));
    if (r.changed > 0) { edit.setXobjectOps(path, r.ops); changed += r.changed; }
  }
  edit.commit();
  return changed;
}
```

Before writing this, read `src/editcontent.ts` and confirm the exact shapes of `ContentOp` and the `EditableContent` methods — the stream indexing (`topOps(0)`) assumes a single content stream and must be widened to loop over every stream index if the class exposes a count.

- [ ] **Step 4: Add the pass**

In `src/pdfxconvert.ts`:

```ts
import { rewriteRgbToCmyk } from './pdfxcolor.js';
```

```ts
/** Opt-in, lossy: rewrite DeviceRGB color operators to DeviceCMYK. Approximate
 *  and unsuitable for color-critical work — without the destination profile the
 *  ink values are not colorimetrically correct. Images are not touched. */
const colorPass: Pass = (ctx) => {
  if (!ctx.opts.convertColor) return [];
  const actions: ConvertAction[] = [];
  for (const page of ctx.doc.Pages) {
    const changed = rewriteRgbToCmyk(ctx.doc, page);
    if (changed > 0) {
      actions.push({ rule: 'ProhibitedColor', page,
        action: `Rewrote ${changed} DeviceRGB color operator(s) to DeviceCMYK (approximate).` });
    }
  }
  return actions;
};
```

Append `colorPass` to the end of `PASSES`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/pdfxconvert.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/pdfxcolor.ts src/pdfxconvert.ts test/pdfxconvert.test.ts
git commit -F - <<'EOF'
feat(pdfx): opt-in DeviceRGB to DeviceCMYK content rewrite

Off by default. When enabled, rewrites rg/RG/sc/scn and DeviceRGB
colorspace selections through a naive maximum-black-removal formula so a
document can reach PDF/X-1a structurally. Documented as approximate:
without the destination profile the ink values are not correct. Raster
images are untouched and still report unresolved.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 10: Real-world conformant fixture

The one thing the builders cannot prove: that we do not false-positive on a PDF/X file we did not produce.

**Files:**
- Create: `test/fixtures/pdfx/PROVENANCE.md`, `test/fixtures/pdfx/ghostscript-x3.pdf`
- Modify: `test/pdfxvalidate.test.ts`

**Interfaces:**
- Consumes: `validatePdfX` via `doc.ValidatePdfX` (Tasks 3–7).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Produce the fixture with Ghostscript**

```bash
gs --version
```

If Ghostscript is unavailable, stop and report it — do not hand-build a "real-world" fixture, which would defeat the entire purpose. Otherwise, generate a PDF/X-3 file from Ghostscript's own PDFX_def.ps template:

```bash
cd test/fixtures/pdfx
gs -dPDFX -dBATCH -dNOPAUSE -sColorConversionStrategy=CMYK \
   -sDEVICE=pdfwrite -sOutputFile=ghostscript-x3.pdf \
   PDFX_def.ps input.ps
```

Record the exact command that worked, including the Ghostscript version and the input file's origin.

- [ ] **Step 2: Write `PROVENANCE.md`**

Follow the format of `test/fixtures/fonts/PROVENANCE.md`. It must record: producer and version, the exact command, SHA-256 of input and output, and — the part that matters most — what the fixture does and does **not** cover. Get the hashes with:

```bash
sha256sum input.ps ghostscript-x3.pdf
```

State explicitly that the fixture covers only the level it was produced at, that Ghostscript's PDF/X output is itself not authoritative, and that a green result means "we do not reject what a mainstream producer emits", not "we implement ISO 15930 correctly".

- [ ] **Step 3: Write the test**

```ts
import { readFileSync } from 'node:fs';

describe('ValidatePdfX — real-world fixture', () => {
  it('accepts Ghostscript PDF/X-3 output without error', () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/pdfx/ghostscript-x3.pdf', import.meta.url)));
    const report = Document.Open(bytes).ValidatePdfX('3');
    // A failure here is far more likely to be our over-enforcement than
    // Ghostscript's non-conformance. Investigate the rule before the fixture.
    expect(report.Errors).toEqual([]);
  });
});
```

- [ ] **Step 4: Run it**

Run: `npx vitest run test/pdfxvalidate.test.ts -t "real-world"`
Expected: PASS.

**If it fails, do not weaken the assertion.** Each reported rule is a live question about whether we have over-enforced. For each one, either establish the ISO 15930 clause that justifies it, or downgrade that rule to `severity: 'warning'` per the global constraint and note the downgrade in the commit message. Record what you found either way.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: PASS.

```bash
git add test/fixtures/pdfx test/pdfxvalidate.test.ts
git commit -F - <<'EOF'
test(pdfx): validate real Ghostscript PDF/X-3 output

Builders cannot catch a shared-convention bug: our validator and our
builder can agree with each other and both disagree with ISO 15930. This
fixture is bytes we did not produce, so over-enforcement fails loudly.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

### Task 11: Documentation and issue close

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Update `README.md`**

Add PDF/X to Features beside PDF/A, an API-overview entry, and a Limitations note. The Limitations entry must state the decidable-subset caveat plainly:

> **PDF/X** — `ValidatePdfX` / `ConvertToPdfX` cover ISO 15930 levels X-1a, X-3, X-4 and X-4p. Both operate on a machine-decidable subset of the standard: rules that can be settled by inspecting the file. The converter fixes structural defects (identification, output intent, `/Trapped`, page boxes, prohibited annotations, actions and filters) and reports what it will not silently change — live transparency under X-1a/X-3, non-embeddable fonts, and RGB raster images. `ConvertToPdfX` returning `passed: false` with a populated `unresolved` list is an expected outcome, not a failure of the call. RGB → CMYK content conversion is opt-in (`convertColor: true`) and approximate: without the destination profile the ink values are not colorimetrically correct, so it is unsuitable for color-critical work.

Show the API shape:

```ts
const report = doc.ValidatePdfX('4');
if (!report.Passed) console.log(report.Errors.map((e) => `${e.rule}: ${e.message}`));

const conv = doc.ConvertToPdfX('1a', {
  iccProfile: { bytes: cmykIcc, n: 4, identifier: 'FOGRA39' },
});
```

- [ ] **Step 2: Update `CLAUDE.md`**

Extend the architecture bullet that currently reads "**structvalidate.ts**, **pdfavalidate.ts**, **validation.ts** — validators…" to cover the new modules:

> - **structvalidate.ts**, **pdfavalidate.ts**, **pdfxvalidate.ts**, **validation.ts** — validators (`ValidatePdfUa`, `ValidatePdfA`, `ValidatePdfX`) returning a shared `ValidationReport`, over the neutral scan machinery in **validatectx.ts** (all-objects walk, content color scan, ExtGState and annotation collection), which both the PDF/A and PDF/X rule sets consume. **conversion.ts**, **pdfaconvert.ts**, **pdfuaconvert.ts**, **pdfxconvert.ts**, **pdfxcolor.ts**, **srgb.ts** — remediation (`ConvertToPdfA`, `ConvertToPdfUa`, `ConvertToPdfX`) with the bundled sRGB profile. **Invariant:** PDF/X conversion never silently alters printed appearance — live transparency, non-embeddable fonts and RGB rasters are reported unresolved, and the RGB→CMYK rewrite is opt-in because a naive conversion without the destination profile produces wrong ink on press.

Add a row to the real-world fixture table:

> | `fixtures/pdfx/` | `PROVENANCE.md` | Ghostscript `-dPDFX` output — that we don't reject a mainstream producer's PDF/X |

- [ ] **Step 3: Run both gates**

Run: `npm run typecheck && npm test`
Expected: PASS. Both must be green before the issue closes.

- [ ] **Step 4: Commit, close the issue, and push**

```bash
git add README.md CLAUDE.md
git commit -F - <<'EOF'
docs: PDF/X validation and conversion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
bd close aspose-pdf-foss-for-ts-i9n
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

File a follow-up `bd` issue for anything deferred — in particular any rule downgraded to `warning` in Task 10, recording which clause could not be substantiated.

---

## Notes for the implementer

**The registered-name allowance is load-bearing and unverified.** Task 3's `outputIntentRule` accepts an output intent with no embedded profile when `/OutputConditionIdentifier` names a registered characterization, and Task 8's default conversion produces exactly that. This is drawn from working knowledge of ISO 15930, not the text. If Task 10's Ghostscript fixture or any other evidence contradicts it, the fallback is to require an embedded profile and let `ConvertToPdfX` report `OutputIntent` unresolved when the caller supplies no profile. That is a spec change, not a silent fix — raise it.

**`REGISTERED_CONDITIONS` is a subset, not the registry.** An unlisted-but-real condition name produces a false positive. If that shows up in practice, prefer widening the set over deleting the rule.

**Rules that fire together are fine.** A `DeviceRGB` page at X-1a legitimately trips both `ProhibitedColor` and `ColorWithoutIntent`. Tests assert rule membership rather than exact issue lists precisely so that overlap does not make them brittle.
