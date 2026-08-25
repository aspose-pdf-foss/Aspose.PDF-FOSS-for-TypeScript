# PDF/A Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.ValidatePdfA(level)` — a curated, machine-decidable PDF/A (ISO 19005, parts 1–3, levels b/u/a) conformance validator returning a `ValidationReport`.

**Architecture:** A new pure, read-only rule engine `src/pdfavalidate.ts` runs an ordered list of rule functions over a per-run memoized context; each rule self-gates by part/level. Shared report types move to a new `src/validation.ts` (re-exported by the existing `structvalidate.ts` for back-compat). Level `a` folds in the existing `validatePdfUa` results. A small content-stream operator scanner (built on `content.ts`) backs the device-color, inline-image-filter, and rendering-intent rules.

**Tech Stack:** TypeScript (strict, ESM/NodeNext — import specifiers end in `.js`), vitest. Zero runtime dependencies (only `node:` built-ins).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries a `.js` extension.
- **TDD** — write the failing test first; fixtures are built programmatically by text-emitting builders in `test/helpers/` (mirror `test/helpers/build-ua-pdf.ts`).
- **Read-only** — the validator never mutates the document.
- **`PdfDict` is a `Map<string, PdfObject>`** keyed by name without the leading `/`. Tagged objects: `isDict`/`isName`/`isStream`/`isString`/`isArray`/`isRef`; a name is `{ kind:'name', name }`, a string `{ kind:'string', bytes }`, a stream `{ kind:'stream', dict, raw }`, a ref `{ kind:'ref', num, gen }`.
- **Always resolve indirect references** with `doc.resolve(x)` (or the bound `ctx.R`) before inspecting.
- **Quality gates before closing any task:** `npm run typecheck` and `npm test` both green.

---

## File Structure

- **Create** `src/validation.ts` — shared `Severity`, `ValidationIssue` (+ new `object?` locator), `ValidationReport`.
- **Modify** `src/structvalidate.ts` — drop the local type/class defs; re-export them from `validation.ts`.
- **Create** `src/pdfavalidate.ts` — `PdfALevel`, the rule engine, the content scanner, all rules.
- **Modify** `src/document.ts` — add `ValidatePdfA(level)`, internal `objectEntries()` and `headerVersion()`.
- **Modify** `src/index.ts` — export `PdfALevel` (report types already exported).
- **Create** `test/helpers/build-pdfa-pdf.ts` — conformant fixture + per-rule violation toggles.
- **Create** `test/pdfavalidate.test.ts` — the test suite.
- **Modify** `README.md` — Features + Limitations.

---

## Task 1: Extract shared validation types into `validation.ts`

**Files:**
- Create: `src/validation.ts`
- Modify: `src/structvalidate.ts:7-30`
- Test: existing `test/structvalidate.test.ts` must stay green (no new test).

**Interfaces:**
- Produces: `Severity`, `ValidationIssue` (now with optional `object?: PdfRef`), `ValidationReport` — all exported from `src/validation.ts` and re-exported from `src/structvalidate.ts`.

- [ ] **Step 1: Create `src/validation.ts`**

```ts
import type { StructElement } from './struct.js';
import type { Page } from './page.js';
import type { PdfRef } from './types.js';

export type Severity = 'error' | 'warning';

/** A single validation finding. `element`/`page`/`object` locate the offender
 *  when applicable; at most the most specific one is usually set. */
export interface ValidationIssue {
  /** Stable rule id, e.g. 'FontEmbedded'. */
  rule: string;
  severity: Severity;
  /** Human-readable description. */
  message: string;
  /** ISO 19005 / ISO 14289 / Matterhorn reference. */
  clause?: string;
  /** Offending structure element, when applicable. */
  element?: StructElement;
  /** Offending page, when applicable. */
  page?: Page;
  /** Offending indirect object, when applicable. */
  object?: PdfRef;
}

/** The result of a validation pass (PDF/UA or PDF/A). */
export class ValidationReport {
  constructor(readonly Issues: ValidationIssue[]) {}
  get Errors(): ValidationIssue[] { return this.Issues.filter((i) => i.severity === 'error'); }
  get Warnings(): ValidationIssue[] { return this.Issues.filter((i) => i.severity === 'warning'); }
  /** True when there are no error-severity issues (warnings are allowed). */
  get Passed(): boolean { return this.Errors.length === 0; }
}
```

- [ ] **Step 2: Re-point `structvalidate.ts` at the shared module**

In `src/structvalidate.ts`, delete the local `Severity` type, `ValidationIssue` interface, and `ValidationReport` class (lines ~7–30). Replace them with a re-export plus a value import (the file constructs `new ValidationReport(...)` and uses the `ValidationIssue[]` type internally):

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { visitContent } from './text.js';
import { PdfDict, isDict } from './types.js';
import { ValidationReport, type ValidationIssue, type Severity } from './validation.js';

// Re-export so existing importers of these from structvalidate keep working.
export { ValidationReport };
export type { ValidationIssue, Severity };
```

Leave the rest of the file (the `validatePdfUa` function and helpers) unchanged.

- [ ] **Step 3: Run the UA tests to verify nothing broke**

Run: `npx vitest run test/structvalidate.test.ts`
Expected: PASS (all existing UA tests green).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/validation.ts src/structvalidate.ts
git commit -m "refactor: extract shared validation types into validation.ts"
```

---

## Task 2: Engine harness, `ValidatePdfA`, clean fixture, and the `Encryption` rule

This task stands up the end-to-end skeleton: level parsing, the `Ctx`, the rule registry, the facade method, the internal Document accessors, the conformant fixture builder, and one real rule (`Encryption`) proving a clean document passes and an encrypted one fails.

**Files:**
- Modify: `src/document.ts` (add `ValidatePdfA`, `objectEntries`, `headerVersion`)
- Create: `src/pdfavalidate.ts`
- Modify: `src/index.ts`
- Create: `test/helpers/build-pdfa-pdf.ts`
- Create: `test/pdfavalidate.test.ts`

**Interfaces:**
- Produces:
  - `type PdfALevel = '1b'|'1a'|'2b'|'2u'|'2a'|'3b'|'3u'|'3a'`
  - `function validatePdfA(doc: Document, catalog: PdfDict, level: PdfALevel): ValidationReport`
  - `interface Ctx { doc: Document; catalog: PdfDict; part: 1|2|3; level: 'b'|'u'|'a'; R(o: PdfObject|undefined): PdfObject; cache: Map<string, unknown>; }`
  - `type Rule = (ctx: Ctx) => ValidationIssue[]`, registry `const RULES: Rule[]`
  - helper `memo<T>(ctx, key, fn): T`
  - `Document.ValidatePdfA(level: PdfALevel): ValidationReport`
  - `Document.objectEntries(): Generator<[PdfRef, PdfObject]>` (internal)
  - `Document.headerVersion(): string | undefined` (internal)
  - `buildPdfaPdf(opts?: PdfaOptions): Uint8Array` (test helper)

- [ ] **Step 1: Add internal accessors to `document.ts`**

After the `ValidatePdfUa()` method (around line 453), add:

```ts
  /** Validate the document against a curated, machine-decidable subset of
   *  PDF/A (ISO 19005, parts 1-3, levels b/u/a). Read-only; never mutates. */
  ValidatePdfA(level: PdfALevel): ValidationReport {
    return validatePdfA(this, this.catalog(), level);
  }

  /** @internal Every indirect object with a gen-0 ref. For validators that must
   *  scan the whole object graph (e.g. prohibited filters anywhere). */
  *objectEntries(): Generator<[PdfRef, PdfObject]> {
    for (const [num, obj] of this.objects) yield [ref(num), obj];
  }

  /** @internal The `%PDF-x.y` header version from the opened bytes, or undefined
   *  for an in-memory–authored document (no header until Save). */
  headerVersion(): string | undefined {
    if (!this.originalBytes) return undefined;
    const head = new TextDecoder('latin1').decode(this.originalBytes.subarray(0, 16));
    const m = /%PDF-(\d+\.\d+)/.exec(head);
    return m ? m[1] : undefined;
  }
```

Add the imports at the top of `document.ts` (extend the existing import lines):

```ts
import { validatePdfA, type PdfALevel } from './pdfavalidate.js';
```

`ref` is already imported from `./types.js` in this file; confirm it is in the existing import list (line 5) and add it if missing.

- [ ] **Step 2: Create `src/pdfavalidate.ts` with the engine and the `Encryption` rule**

```ts
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isDict, isName, isString, isArray, isStream, isRef,
} from './types.js';
import { ValidationReport, type ValidationIssue } from './validation.js';

/** Conformance target: part (1/2/3) + level (b/u/a). */
export type PdfALevel = '1b' | '1a' | '2b' | '2u' | '2a' | '3b' | '3u' | '3a';

interface Conformance { part: 1 | 2 | 3; level: 'b' | 'u' | 'a'; }

/** Split a level string into its part number and conformance letter. */
export function parseLevel(level: PdfALevel): Conformance {
  return { part: Number(level[0]) as 1 | 2 | 3, level: level[1] as 'b' | 'u' | 'a' };
}

/** Per-run context shared (read-only) across rules. */
export interface Ctx {
  doc: Document;
  catalog: PdfDict;
  part: 1 | 2 | 3;
  level: 'b' | 'u' | 'a';
  /** Bound `doc.resolve`. */
  R(o: PdfObject | undefined): PdfObject;
  /** Memo store for shared scans (fonts, content scan, …). */
  cache: Map<string, unknown>;
}

/** Memoize an expensive per-run computation under `key`. */
export function memo<T>(ctx: Ctx, key: string, fn: () => T): T {
  if (!ctx.cache.has(key)) ctx.cache.set(key, fn());
  return ctx.cache.get(key) as T;
}

type Rule = (ctx: Ctx) => ValidationIssue[];

/** Entry point. The facade supplies the catalog so catalog-only rules need no
 *  new public accessor (mirrors validatePdfUa). */
export function validatePdfA(doc: Document, catalog: PdfDict, level: PdfALevel): ValidationReport {
  const { part, level: lvl } = parseLevel(level);
  const ctx: Ctx = {
    doc, catalog, part, level: lvl,
    R: (o) => doc.resolve(o),
    cache: new Map(),
  };
  const issues: ValidationIssue[] = [];
  for (const rule of RULES) issues.push(...rule(ctx));
  return new ValidationReport(issues);
}

// ---- rules -----------------------------------------------------------------

/** PDF/A forbids encryption entirely. */
const encryptionRule: Rule = (ctx) => {
  if (ctx.doc.trailer.get('Encrypt') === undefined) return [];
  return [{
    rule: 'Encryption', severity: 'error', clause: 'ISO 19005-1 §6.1.3',
    message: 'Document is encrypted; PDF/A forbids encryption.',
  }];
};

const RULES: Rule[] = [
  encryptionRule,
];
```

- [ ] **Step 3: Export `PdfALevel` from `index.ts`**

Add to `src/index.ts` (alongside the existing validation exports):

```ts
export type { PdfALevel } from './pdfavalidate.js';
```

Confirm `ValidationReport`, `ValidationIssue`, `Severity` are already exported (they are, from `structvalidate.ts`); they now originate in `validation.ts` but the re-export chain keeps the public names stable.

- [ ] **Step 4: Create the conformant fixture builder `test/helpers/build-pdfa-pdf.ts`**

This emits a minimal PDF/A-conformant document (lightweight placeholder streams — the validator checks structure, not ICC/glyph validity) with toggles for every later rule. Mirrors the raw-text style of `build-ua-pdf.ts`.

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

export interface PdfaOptions {
  // file / structure
  omitId?: boolean;           // omit trailer /ID
  headerVersion?: string;     // %PDF-x.y header (default '1.7')
  catalogVersion?: string;    // catalog /Version name (default omitted)
  externalStream?: boolean;   // give the content stream an /F external ref
  lzwStream?: boolean;        // filter the content stream with /LZWDecode
  psXObject?: boolean;        // add a /Subtype /PS XObject to resources
  refXObject?: boolean;       // add a Form XObject with /Ref
  optionalContent?: boolean;  // add catalog /OCProperties
  // metadata
  omitMetadata?: boolean;     // omit /Root /Metadata
  pdfaPart?: string;          // pdfaid:part value (default matches `part`)
  pdfaConformance?: string;   // pdfaid:conformance value (default 'B')
  infoTitle?: string | null;  // /Info /Title (default 'Clean'); null omits /Info
  xmpTitle?: string;          // dc:title (default 'Clean'); set ≠ infoTitle to break consistency
  // color / output intent
  omitOutputIntent?: boolean; // drop the /OutputIntents entry
  badIccN?: boolean;          // give /DestOutputProfile an /N of 2
  deviceColorContent?: boolean; // content uses `rg` device color (default true)
  // fonts
  fontEmbedded?: boolean;     // default true: include /FontFile2 in the descriptor
  symbolicWithEncoding?: boolean; // symbolic TrueType that wrongly has /Encoding
  omitCidSet?: boolean;       // (with type0 font) drop /CIDSet
  type0?: boolean;            // use a Type0/CIDFontType2 font instead of simple
  omitToUnicode?: boolean;    // drop /ToUnicode and use a non-standard encoding
  // transparency
  transparencyGroup?: boolean; // page /Group /S /Transparency
  lowAlpha?: boolean;          // ExtGState /ca 0.5
  nonStandardBlend?: boolean;  // ExtGState /BM /FunkyBlend
  // annotations / forms / actions
  annotNoAp?: boolean;         // add a /Text annot with no /AP
  movieAnnot?: boolean;        // add a /Movie annot
  hiddenAnnot?: boolean;       // add an annot with the Hidden flag
  jsAction?: boolean;          // catalog /OpenAction /S /JavaScript
  additionalAction?: boolean;  // catalog /AA
  needAppearances?: boolean;   // AcroForm /NeedAppearances true
  xfa?: boolean;               // AcroForm /XFA
  // images / content scan
  jpxImage?: boolean;          // image XObject with /JPXDecode
  interpolateImage?: boolean;  // image XObject with /Interpolate true
  badRenderingIntent?: boolean;// content `/Bogus ri`
  inlineLzwImage?: boolean;    // inline image with /LZW filter abbreviation
}

export function buildPdfaPdf(opts: PdfaOptions = {}, part: 1 | 2 | 3 = 2): Uint8Array {
  const header = opts.headerVersion ?? '1.7';
  const infoTitle = opts.infoTitle === undefined ? 'Clean' : opts.infoTitle;
  const xmpTitle = opts.xmpTitle ?? 'Clean';
  const pdfaPart = opts.pdfaPart ?? String(part);
  const pdfaConf = opts.pdfaConformance ?? 'B';

  // --- content stream ---
  const colorOp = (opts.deviceColorContent ?? true) ? '1 0 0 rg\n' : '';
  const riOp = opts.badRenderingIntent ? '/Bogus ri\n' : '';
  const inlineImg = opts.inlineLzwImage
    ? 'q 1 0 0 1 0 0 cm BI /W 1 /H 1 /CS /G /F /LZW ID \x00 EI Q\n' : '';
  const content = `${colorOp}${riOp}${inlineImg}BT /F1 12 Tf 50 50 Td (Hi) Tj ET\n`;

  // --- objects (raw PDF text, indices are object numbers) ---
  const objects: string[] = [];

  const catParts = ['/Type /Catalog', '/Pages 2 0 R', '/Metadata 7 0 R'];
  if (!opts.omitOutputIntent) catParts.push('/OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) /DestOutputProfile 8 0 R >>]');
  if (opts.catalogVersion) catParts.push(`/Version /${opts.catalogVersion}`);
  if (opts.optionalContent) catParts.push('/OCProperties << /OCGs [] /D << >> >>');
  if (opts.jsAction) catParts.push('/OpenAction << /S /JavaScript /JS (app.alert\\(1\\);) >>');
  if (opts.additionalAction) catParts.push('/AA << /WC << /S /JavaScript /JS (x) >> >>');
  const acro: string[] = [];
  if (opts.needAppearances) acro.push('/NeedAppearances true');
  if (opts.xfa) acro.push('/XFA 9 0 R');
  if (acro.length) catParts.push(`/AcroForm << /Fields [] ${acro.join(' ')} >>`);
  if (opts.omitMetadata) {
    const i = catParts.indexOf('/Metadata 7 0 R');
    catParts.splice(i, 1);
  }
  objects[1] = `<< ${catParts.join(' ')} >>`;

  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>';

  // page
  const pageParts = ['/Type /Page', '/Parent 2 0 R', '/Contents 4 0 R'];
  const res = ['/Font << /F1 5 0 R >>'];
  const xobjs: string[] = [];
  if (opts.psXObject) xobjs.push('/PSX 10 0 R');
  if (opts.refXObject) xobjs.push('/RefX 11 0 R');
  if (opts.jpxImage) xobjs.push('/Img 12 0 R');
  if (opts.interpolateImage) xobjs.push('/ImgI 13 0 R');
  if (xobjs.length) res.push(`/XObject << ${xobjs.join(' ')} >>`);
  const egs: string[] = [];
  if (opts.lowAlpha) egs.push('/GSa << /Type /ExtGState /ca 0.5 >>');
  if (opts.nonStandardBlend) egs.push('/GSb << /Type /ExtGState /BM /FunkyBlend >>');
  if (egs.length) res.push(`/ExtGState << ${egs.join(' ')} >>`);
  pageParts.push(`/Resources << ${res.join(' ')} >>`);
  if (opts.transparencyGroup) pageParts.push('/Group << /S /Transparency >>');
  const annots: string[] = [];
  if (opts.annotNoAp) annots.push('14 0 R');
  if (opts.movieAnnot) annots.push('15 0 R');
  if (opts.hiddenAnnot) annots.push('16 0 R');
  if (annots.length) pageParts.push(`/Annots [${annots.join(' ')}]`);
  objects[3] = `<< ${pageParts.join(' ')} >>`;

  // content stream
  const streamFilter = opts.lzwStream ? ' /Filter /LZWDecode' : '';
  const streamExt = opts.externalStream ? ' /F (external.dat)' : '';
  objects[4] = `<< /Length ${byteLen(content)}${streamFilter}${streamExt} >>\nstream\n${content}endstream`;

  // font
  if (opts.type0) {
    const descParts = ['/Type /FontDescriptor', '/FontName /AAAAAA+Sub', '/Flags 4'];
    if (opts.fontEmbedded ?? true) descParts.push('/FontFile2 6 0 R');
    if (!opts.omitCidSet) descParts.push('/CIDSet 17 0 R');
    objects[5] = '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Sub /Encoding /Identity-H /DescendantFonts [18 0 R]'
      + (opts.omitToUnicode ? '' : ' /ToUnicode 19 0 R') + ' >>';
    objects[18] = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Sub /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 20 0 R >>`;
    objects[20] = `<< ${descParts.join(' ')} >>`;
    if (!opts.omitCidSet) objects[17] = '<< /Length 1 >>\nstream\n\x00\nendstream';
    if (!opts.omitToUnicode) objects[19] = '<< /Length 0 >>\nstream\n\nendstream';
  } else {
    const descParts = ['/Type /FontDescriptor', '/FontName /AAAAAA+Sub', '/Flags 32'];
    if (opts.fontEmbedded ?? true) descParts.push('/FontFile2 6 0 R');
    const fontParts = ['/Type /Font', '/Subtype /TrueType', '/BaseFont /AAAAAA+Sub',
      '/FirstChar 32', '/LastChar 32', '/Widths [500]', '/FontDescriptor 21 0 R'];
    if (opts.symbolicWithEncoding) { descParts[2] = '/Flags 4'; fontParts.push('/Encoding /WinAnsiEncoding'); }
    else if (!opts.omitToUnicode) fontParts.push('/Encoding /WinAnsiEncoding');
    else fontParts.push('/Encoding /MacExpertEncoding'); // non-standard for ToUnicode purposes
    objects[5] = `<< ${fontParts.join(' ')} >>`;
    objects[21] = `<< ${descParts.join(' ')} >>`;
  }
  if (opts.fontEmbedded ?? true) objects[6] = '<< /Length 4 /Length1 4 >>\nstream\ntrue\nendstream';

  // metadata (XMP with pdfaid)
  const xmp = xmpPacket(pdfaPart, pdfaConf, xmpTitle);
  objects[7] = `<< /Type /Metadata /Subtype /XML /Length ${byteLen(xmp)} >>\nstream\n${xmp}endstream`;

  // ICC output profile
  const iccN = opts.badIccN ? 2 : 3;
  objects[8] = `<< /N ${iccN} /Length 4 >>\nstream\nICC \nendstream`;

  if (opts.xfa) objects[9] = '<< /Length 4 >>\nstream\nxfa\nendstream';
  if (opts.psXObject) objects[10] = '<< /Type /XObject /Subtype /PS /Length 0 >>\nstream\n\nendstream';
  if (opts.refXObject) objects[11] = '<< /Type /XObject /Subtype /Form /Ref << /F << >> /Page 0 >> /BBox [0 0 1 1] /Length 0 >>\nstream\n\nendstream';
  if (opts.jpxImage) objects[12] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.interpolateImage) objects[13] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate true /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.annotNoAp) objects[14] = '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 4 >>';
  if (opts.movieAnnot) objects[15] = '<< /Type /Annot /Subtype /Movie /Rect [0 0 10 10] /F 4 >>';
  if (opts.hiddenAnnot) objects[16] = '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 6 /AP << /N 22 0 R >> >>';
  if (opts.hiddenAnnot) objects[22] = '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream';

  // info
  const infoNum = 23;
  if (infoTitle !== null) objects[infoNum] = `<< /Title (${infoTitle}) >>`;

  // --- assemble ---
  const maxObj = objects.reduce((m, _, i) => (objects[i] !== undefined ? i : m), 0);
  let body = `%PDF-${header}\n%\xE2\xE3\xCF\xD3\n`;
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (objects[n] === undefined) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += objects[n] === undefined
      ? '0000000000 00000 f \n'
      : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailerParts = [`/Size ${maxObj + 1}`, '/Root 1 0 R'];
  if (infoTitle !== null) trailerParts.push(`/Info ${infoNum} 0 R`);
  if (!opts.omitId) trailerParts.push('/ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]');
  const trailer = `trailer\n<< ${trailerParts.join(' ')} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function xmpPacket(part: string, conformance: string, title: string): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" `
    + `pdfaid:part="${part}" pdfaid:conformance="${conformance}"/>`
    + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">`
    + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>`
    + `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
}
```

- [ ] **Step 5: Write the failing test (clean pass + encryption fail)**

Create `test/pdfavalidate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

const open = (bytes: Uint8Array) => Document.Open(bytes);

describe('ValidatePdfA — harness', () => {
  it('clean document passes at 2b with zero errors and no warnings', () => {
    const doc = open(buildPdfaPdf({}, 2));
    const report = doc.ValidatePdfA('2b');
    expect(report.Errors).toEqual([]);
    expect(report.Warnings).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('flags an encrypted document', () => {
    // Round-trip the clean fixture through real encryption (a forged /Encrypt
    // would make Document.Open reject the file), then re-open and validate.
    const encrypted = Document.Open(buildPdfaPdf({}, 2)).Save({ encrypt: { userPassword: '' } });
    const report = Document.Open(encrypted).ValidatePdfA('2b');
    expect(report.Errors.map((e) => e.rule)).toContain('Encryption');
    expect(report.Passed).toBe(false);
  });
});
```

The open API is `Document.Open(bytes)`, imported from `../src/index.js` (matching `test/structvalidate.test.ts`). The `encrypt` test uses the library's own `Save({ encrypt })` to produce a genuinely encrypted file rather than a forged trailer entry.

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL — `ValidatePdfA` not yet wired / module resolution until Steps 1–3 compile. Once compiling, the clean-pass test should already pass and the encryption test should pass; if the clean test reports unexpected errors, that indicates a fixture bug to fix now (before adding more rules).

- [ ] **Step 7: Make it green**

Resolve any fixture bugs (e.g. an object-number collision or a malformed dict) until both tests pass.

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 8: Commit**

```bash
git add src/pdfavalidate.ts src/validation.ts src/document.ts src/index.ts test/helpers/build-pdfa-pdf.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): ValidatePdfA harness + Encryption rule + fixture builder"
```

---

## Task 3: File / structure rules

Adds `FileID`, `Version`, `ExternalStream`, `LZW`, `PostScriptXObject`, `ReferenceXObject`, `OptionalContent`, plus the object-graph and filter helpers reused later.

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Produces (in `pdfavalidate.ts`): `filterNames(dict, R): string[]`, `allObjects(ctx): [PdfRef, PdfObject][]`.
- Consumes: `Ctx`, `memo`, `Document.objectEntries()`, `Document.headerVersion()`.

- [ ] **Step 1: Write the failing tests**

Add to `test/pdfavalidate.test.ts`:

```ts
describe('ValidatePdfA — file/structure', () => {
  const rules = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags a missing /ID', () => {
    expect(rules(buildPdfaPdf({ omitId: true }))).toContain('FileID');
  });
  it('flags an over-ceiling version at part 1', () => {
    expect(rules(buildPdfaPdf({ headerVersion: '1.7' }, 1), '1b')).toContain('Version');
  });
  it('passes 1.4 header at part 1', () => {
    expect(rules(buildPdfaPdf({ headerVersion: '1.4' }, 1), '1b')).not.toContain('Version');
  });
  it('flags an external stream reference', () => {
    expect(rules(buildPdfaPdf({ externalStream: true }))).toContain('ExternalStream');
  });
  it('flags an LZW filter', () => {
    expect(rules(buildPdfaPdf({ lzwStream: true }))).toContain('LZW');
  });
  it('flags a PostScript XObject', () => {
    expect(rules(buildPdfaPdf({ psXObject: true }))).toContain('PostScriptXObject');
  });
  it('flags a reference XObject', () => {
    expect(rules(buildPdfaPdf({ refXObject: true }))).toContain('ReferenceXObject');
  });
  it('flags optional content at part 1 but not part 2', () => {
    expect(rules(buildPdfaPdf({ optionalContent: true }, 1), '1b')).toContain('OptionalContent');
    expect(rules(buildPdfaPdf({ optionalContent: true }, 2), '2b')).not.toContain('OptionalContent');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL (rules not implemented).

- [ ] **Step 3: Add helpers and rules to `pdfavalidate.ts`**

Add helpers near the top (after `memo`):

```ts
/** All `/Filter` names on a stream (or other) dict, normalized to bare names. */
export function filterNames(dict: PdfDict, R: Ctx['R']): string[] {
  const f = R(dict.get('Filter'));
  if (isName(f)) return [f.name];
  if (isArray(f)) return f.map(R).filter(isName).map((n) => (n as { name: string }).name);
  return [];
}

/** Every indirect object with its ref, memoized for the run. */
export function allObjects(ctx: Ctx): [PdfRef, PdfObject][] {
  return memo(ctx, 'allObjects', () => [...ctx.doc.objectEntries()]);
}

/** The name value of `dict.get(key)`, resolved, or undefined. */
function nameOf(ctx: Ctx, dict: PdfDict, key: string): string | undefined {
  const v = ctx.R(dict.get(key));
  return isName(v) ? v.name : undefined;
}
```

Add the rules:

```ts
const fileIdRule: Rule = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  if (isArray(id) && id.length === 2) return [];
  return [{ rule: 'FileID', severity: 'error', clause: 'ISO 19005-1 §6.1.3',
    message: 'Trailer has no /ID array; PDF/A requires a file identifier.' }];
};

const versionRule: Rule = (ctx) => {
  const ceiling = ctx.part === 1 ? 1.4 : 1.7;
  const over = (v: string | undefined): boolean => v !== undefined && Number(v) > ceiling + 1e-9;
  const header = ctx.doc.headerVersion();
  const cat = nameOf(ctx, ctx.catalog, 'Version');
  if (over(header) || over(cat)) {
    return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-1 §6.1.2',
      message: `PDF version exceeds the part ${ctx.part} ceiling (${ceiling}).` }];
  }
  return [];
};

const externalStreamRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && obj.dict.get('F') !== undefined
      ? [{ rule: 'ExternalStream', severity: 'error', clause: 'ISO 19005-1 §6.1.7', object,
          message: 'Stream references external file data (/F); PDF/A requires embedded data.' }]
      : []);

const lzwRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && filterNames(obj.dict, ctx.R).includes('LZWDecode')
      ? [{ rule: 'LZW', severity: 'error', clause: 'ISO 19005-1 §6.1.10', object,
          message: 'Stream uses the prohibited /LZWDecode filter.' }]
      : []);

const psXObjectRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const sub = nameOf(ctx, obj.dict, 'Subtype');
    if (sub === 'PS' || obj.dict.get('PS') !== undefined) {
      return [{ rule: 'PostScriptXObject', severity: 'error', clause: 'ISO 19005-1 §6.2.7', object,
        message: 'PostScript XObjects are prohibited in PDF/A.' }];
    }
    return [];
  });

const refXObjectRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Form' && obj.dict.get('Ref') !== undefined
      ? [{ rule: 'ReferenceXObject', severity: 'error', clause: 'ISO 19005-1 §6.2.8', object,
          message: 'Reference XObjects (/Ref) are prohibited in PDF/A.' }]
      : []);

const optionalContentRule: Rule = (ctx) => {
  if (ctx.part !== 1) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  return [{ rule: 'OptionalContent', severity: 'error', clause: 'ISO 19005-1 §6.1.13',
    message: 'Optional content (/OCProperties) is prohibited in PDF/A-1.' }];
};
```

Append them to the registry:

```ts
const RULES: Rule[] = [
  encryptionRule, fileIdRule, versionRule, externalStreamRule, lzwRule,
  psXObjectRule, refXObjectRule, optionalContentRule,
];
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): file/structure rules (id, version, external, lzw, xobjects, oc)"
```

---

## Task 4: Metadata rules

Adds `Metadata`, `PdfaIdentification`, `XmpInfoConsistency`.

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Consumes: `Document.GetMetadata()`, `Document.GetXmp()`, catalog `/Metadata` stream, `inflateStream` from `./flate.js`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfA — metadata', () => {
  const rules = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Issues;
  const ids = (bytes: Uint8Array, level: any = '2b') => rules(bytes, level).map((i) => i.rule);

  it('flags a missing metadata stream', () => {
    expect(ids(buildPdfaPdf({ omitMetadata: true }))).toContain('Metadata');
  });
  it('flags a pdfaid part mismatch', () => {
    expect(ids(buildPdfaPdf({ pdfaPart: '1' }, 2))).toContain('PdfaIdentification');
  });
  it('flags a pdfaid conformance mismatch (claim u, xmp says B)', () => {
    expect(ids(buildPdfaPdf({ pdfaConformance: 'B' }, 2), '2u')).toContain('PdfaIdentification');
  });
  it('flags Info/XMP title disagreement as error at part 1', () => {
    const issues = rules(buildPdfaPdf({ infoTitle: 'A', xmpTitle: 'B' }, 1), '1b');
    const c = issues.find((i) => i.rule === 'XmpInfoConsistency');
    expect(c?.severity).toBe('error');
  });
  it('reports Info/XMP disagreement as warning at part 2', () => {
    const issues = rules(buildPdfaPdf({ infoTitle: 'A', xmpTitle: 'B' }, 2), '2b');
    const c = issues.find((i) => i.rule === 'XmpInfoConsistency');
    expect(c?.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the import to `pdfavalidate.ts`:

```ts
import { inflateStream } from './flate.js';
```

Add a helper that returns the decoded XMP text once:

```ts
/** Decoded XMP packet text from /Root /Metadata, or undefined when absent. */
function xmpText(ctx: Ctx): string | undefined {
  return memo(ctx, 'xmpText', () => {
    const md = ctx.R(ctx.catalog.get('Metadata'));
    if (!isStream(md)) return undefined;
    return new TextDecoder('latin1').decode(inflateStream(md));
  });
}

/** Read a pdfaid property in attribute or element form. */
function pdfaIdValue(xmp: string, prop: 'part' | 'conformance'): string | undefined {
  const attr = new RegExp(`pdfaid:${prop}\\s*=\\s*["']([^"']+)["']`).exec(xmp);
  if (attr) return attr[1].trim();
  const el = new RegExp(`<pdfaid:${prop}>\\s*([^<]+?)\\s*</pdfaid:${prop}>`).exec(xmp);
  return el ? el[1].trim() : undefined;
}
```

Add the rules:

```ts
const metadataRule: Rule = (ctx) => {
  const xmp = xmpText(ctx);
  if (xmp && /<x:xmpmeta|<rdf:RDF/.test(xmp)) return [];
  return [{ rule: 'Metadata', severity: 'error', clause: 'ISO 19005-1 §6.7.2',
    message: 'Document has no well-formed XMP metadata stream (/Root /Metadata).' }];
};

const pdfaIdRule: Rule = (ctx) => {
  const xmp = xmpText(ctx);
  if (!xmp) return []; // metadataRule already reports the absence
  const part = pdfaIdValue(xmp, 'part');
  const conf = pdfaIdValue(xmp, 'conformance');
  const issues: ValidationIssue[] = [];
  if (part !== String(ctx.part)) {
    issues.push({ rule: 'PdfaIdentification', severity: 'error', clause: 'ISO 19005-1 §6.7.11',
      message: `XMP pdfaid:part is '${part ?? '(absent)'}', expected '${ctx.part}'.` });
  }
  if ((conf ?? '').toLowerCase() !== ctx.level) {
    issues.push({ rule: 'PdfaIdentification', severity: 'error', clause: 'ISO 19005-1 §6.7.11',
      message: `XMP pdfaid:conformance is '${conf ?? '(absent)'}', expected '${ctx.level.toUpperCase()}'.` });
  }
  return issues;
};

const xmpInfoConsistencyRule: Rule = (ctx) => {
  const info = ctx.doc.GetMetadata();
  const xmp = ctx.doc.GetXmp();
  const sev = ctx.part === 1 ? 'error' : 'warning';
  // (field label, Info value, XMP value) — strings only; dates excluded (format-normalization risk).
  const pairs: [string, string | undefined, string | undefined][] = [
    ['title', info.title, xmp.title],
    ['author', info.author, xmp.authors?.join(', ')],
    ['subject', info.subject, xmp.description],
    ['keywords', info.keywords, xmp.keywords],
  ];
  const issues: ValidationIssue[] = [];
  for (const [label, a, b] of pairs) {
    if (a !== undefined && b !== undefined && a !== b) {
      issues.push({ rule: 'XmpInfoConsistency', severity: sev as Severity,
        clause: 'ISO 19005-1 §6.7.3',
        message: `/Info ${label} ('${a}') does not match the XMP value ('${b}').` });
    }
  }
  return issues;
};
```

Add the `Severity` value import to the existing `validation.js` import line:

```ts
import { ValidationReport, type ValidationIssue, type Severity } from './validation.js';
```

Register:

```ts
const RULES: Rule[] = [
  encryptionRule, fileIdRule, versionRule, externalStreamRule, lzwRule,
  psXObjectRule, refXObjectRule, optionalContentRule,
  metadataRule, pdfaIdRule, xmpInfoConsistencyRule,
];
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): metadata rules (Metadata, PdfaIdentification, XmpInfoConsistency)"
```

---

## Task 5: Font rules

Adds `FontEmbedded`, `FontEncoding`, `FontCIDSet`, `ToUnicode`, plus the font-enumeration helper.

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Produces: `enumerateFonts(ctx): { ref?: PdfRef; dict: PdfDict }[]` (deduped across pages + Form XObjects).
- Consumes: `Page.Resources`, `Ctx`, `memo`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfA — fonts', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags a non-embedded font', () => {
    expect(ids(buildPdfaPdf({ fontEmbedded: false }))).toContain('FontEmbedded');
  });
  it('flags a symbolic TrueType that carries /Encoding', () => {
    expect(ids(buildPdfaPdf({ symbolicWithEncoding: true }))).toContain('FontEncoding');
  });
  it('flags a CID subset without /CIDSet at part 1', () => {
    expect(ids(buildPdfaPdf({ type0: true, omitCidSet: true }, 1), '1b')).toContain('FontCIDSet');
  });
  it('flags a font without a Unicode mapping at level u', () => {
    expect(ids(buildPdfaPdf({ omitToUnicode: true }, 2), '2u')).toContain('ToUnicode');
  });
  it('does NOT flag the missing Unicode mapping at level b', () => {
    expect(ids(buildPdfaPdf({ omitToUnicode: true }, 2), '2b')).not.toContain('ToUnicode');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add helpers:

```ts
/** Every distinct font dict referenced by any page (recursing Form XObject
 *  resources), deduped by indirect ref. */
function enumerateFonts(ctx: Ctx): { ref?: PdfRef; dict: PdfDict }[] {
  return memo(ctx, 'fonts', () => {
    const out: { ref?: PdfRef; dict: PdfDict }[] = [];
    const seen = new Set<PdfDict>();
    const seenRes = new Set<PdfDict>();
    const visitRes = (resObj: PdfObject | undefined): void => {
      const res = ctx.R(resObj);
      if (!isDict(res) || seenRes.has(res)) return;
      seenRes.add(res);
      const fonts = ctx.R(res.get('Font'));
      if (isDict(fonts)) {
        for (const v of fonts.values()) {
          const d = ctx.R(v);
          if (isDict(d) && !seen.has(d)) { seen.add(d); out.push({ ref: isRef(v) ? v : undefined, dict: d }); }
        }
      }
      const xobjs = ctx.R(res.get('XObject'));
      if (isDict(xobjs)) {
        for (const v of xobjs.values()) {
          const x = ctx.R(v);
          if (isStream(x)) visitRes(x.dict.get('Resources'));
        }
      }
    };
    for (const page of ctx.doc.Pages) visitRes(page.Resources);
    return out;
  });
}

/** The descendant CIDFont dict of a Type0 font, or undefined. */
function descendantFont(ctx: Ctx, font: PdfDict): PdfDict | undefined {
  const arr = ctx.R(font.get('DescendantFonts'));
  if (!isArray(arr) || arr.length === 0) return undefined;
  const d = ctx.R(arr[0]);
  return isDict(d) ? d : undefined;
}

/** True when a font descriptor embeds a font program. */
function hasFontProgram(ctx: Ctx, descriptor: PdfObject | undefined): boolean {
  const fd = ctx.R(descriptor);
  if (!isDict(fd)) return false;
  return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => isStream(ctx.R(fd.get(k))));
}

const STANDARD_SIMPLE_ENCODINGS = new Set(['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding']);
```

Add the rules:

```ts
const fontEmbeddedRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Type0') {
      const desc = descendantFont(ctx, dict);
      const ok = desc && hasFontProgram(ctx, desc.get('FontDescriptor'));
      return ok ? [] : [{ rule: 'FontEmbedded', severity: 'error', clause: 'ISO 19005-1 §6.3.4', object,
        message: `Type0 font '${nameOf(ctx, dict, 'BaseFont') ?? '?'}' has no embedded descendant font program.` }];
    }
    if (subtype === 'Type3') return []; // Type3 glyphs are content streams; no font program required.
    return hasFontProgram(ctx, dict.get('FontDescriptor'))
      ? []
      : [{ rule: 'FontEmbedded', severity: 'error', clause: 'ISO 19005-1 §6.3.4', object,
          message: `Font '${nameOf(ctx, dict, 'BaseFont') ?? '?'}' is not embedded.` }];
  });

const fontEncodingRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    if (nameOf(ctx, dict, 'Subtype') !== 'TrueType') return [];
    const fd = ctx.R(dict.get('FontDescriptor'));
    const flags = isDict(fd) ? ctx.R(fd.get('Flags')) : undefined;
    const symbolic = typeof flags === 'number' && (flags & 4) !== 0 && (flags & 32) === 0;
    const encObj = dict.get('Encoding');
    const hasEncoding = encObj !== undefined;
    if (symbolic && hasEncoding) {
      return [{ rule: 'FontEncoding', severity: 'error', clause: 'ISO 19005-1 §6.3.5', object,
        message: 'Symbolic TrueType font must not specify /Encoding.' }];
    }
    if (!symbolic && hasEncoding) {
      const enc = ctx.R(encObj);
      const base = isName(enc) ? enc.name
        : isDict(enc) ? nameOf(ctx, enc, 'BaseEncoding') ?? 'WinAnsiEncoding'
        : undefined;
      if (base && !STANDARD_SIMPLE_ENCODINGS.has(base)) {
        return [{ rule: 'FontEncoding', severity: 'error', clause: 'ISO 19005-1 §6.3.5', object,
          message: `Non-symbolic TrueType font uses non-standard encoding '${base}'.` }];
      }
    }
    return [];
  });

const fontCidSetRule: Rule = (ctx) =>
  enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    if (nameOf(ctx, dict, 'Subtype') !== 'Type0') return [];
    const desc = descendantFont(ctx, dict);
    if (!desc) return [];
    const fd = ctx.R(desc.get('FontDescriptor'));
    if (!isDict(fd)) return [];
    // Only subset fonts (BaseFont tag like ABCDEF+Name) must carry /CIDSet.
    const base = nameOf(ctx, desc, 'BaseFont') ?? '';
    const isSubset = /^[A-Z]{6}\+/.test(base);
    if (!isSubset || isStream(ctx.R(fd.get('CIDSet')))) return [];
    return [{ rule: 'FontCIDSet', severity: ctx.part === 1 ? 'error' : 'warning',
      clause: 'ISO 19005-1 §6.3.6', object,
      message: 'Embedded CID subset font has no /CIDSet.' }];
  });

const toUnicodeRule: Rule = (ctx) => {
  if (ctx.level === 'b') return [];
  return enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
    if (isStream(ctx.R(dict.get('ToUnicode')))) return [];
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Type0') {
      // Identity CMaps with an Identity ordering are Unicode-recoverable only via ToUnicode.
      return [{ rule: 'ToUnicode', severity: 'error', clause: 'ISO 19005-2 §6.2.11.7.2', object,
        message: 'Type0 font has no /ToUnicode CMap (required for level u/a).' }];
    }
    const enc = ctx.R(dict.get('Encoding'));
    const base = isName(enc) ? enc.name : isDict(enc) ? nameOf(ctx, enc, 'BaseEncoding') : undefined;
    if (base && STANDARD_SIMPLE_ENCODINGS.has(base)) return []; // standard encoding ⇒ Unicode-mappable
    return [{ rule: 'ToUnicode', severity: 'error', clause: 'ISO 19005-2 §6.2.11.7.2', object,
      message: 'Simple font has neither /ToUnicode nor a standard predefined encoding (required for level u/a).' }];
  });
};
```

Register all four after the metadata rules.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): font rules (embedded, encoding, cidset, toUnicode)"
```

---

## Task 6: Output-intent / color rules + content scanner

Adds `OutputIntent`, `ICCBasedN`, `DeviceColorWithoutIntent`, and the page content scanner (also reused in Task 9).

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Produces: `interface PageScan { page: Page; usesDeviceColor: boolean; inlineImageFilters: string[]; renderingIntents: string[]; }` and `pageScans(ctx): PageScan[]`; `pdfaOutputIntentProfile(ctx): PdfRef | 'missing' | 'multiple'`.
- Consumes: `parseContentStream` from `./content.js`, `Page`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfA — color/output intent', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags device color with no output intent', () => {
    const r = ids(buildPdfaPdf({ omitOutputIntent: true, deviceColorContent: true }));
    expect(r).toContain('OutputIntent');
    expect(r).toContain('DeviceColorWithoutIntent');
  });
  it('passes device color when an output intent is present', () => {
    const r = ids(buildPdfaPdf({ deviceColorContent: true }));
    expect(r).not.toContain('OutputIntent');
    expect(r).not.toContain('DeviceColorWithoutIntent');
  });
  it('flags an ICCBased profile with a bad /N', () => {
    expect(ids(buildPdfaPdf({ badIccN: true }))).toContain('ICCBasedN');
  });
});
```

Note: the clean fixture's output intent `/DestOutputProfile` (obj 8) has `/N 3`; the `ICCBasedN` rule checks any `/ICCBased` color-space arrays AND the output-intent profile `/N`. With `badIccN`, obj 8's `/N` becomes 2 and must be flagged.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the scanner and rules**

Add the import:

```ts
import { parseContentStream } from './content.js';
import type { Page } from './page.js';
```

Add the scanner:

```ts
export interface PageScan {
  page: Page;
  usesDeviceColor: boolean;
  inlineImageFilters: string[];
  renderingIntents: string[];
}

const DEVICE_COLOR_OPS = new Set(['g', 'G', 'rg', 'RG', 'k', 'K']);
const DEVICE_CS = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'G', 'RGB', 'CMYK']);
const INLINE_FILTER_ABBREV: Record<string, string> = {
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode',
  RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
};

/** Walk a page's content (recursing Form XObjects) once, recording PDF/A-relevant usage. */
export function pageScans(ctx: Ctx): PageScan[] {
  return memo(ctx, 'scans', () => ctx.doc.Pages.map((page) => {
    const scan: PageScan = { page, usesDeviceColor: false, inlineImageFilters: [], renderingIntents: [] };
    const seen = new Set<PdfDict>();
    const walk = (resObj: PdfObject | undefined, contentBytes: Uint8Array, depth: number): void => {
      if (depth > 8) return;
      const res = ctx.R(resObj);
      const resDict = isDict(res) ? res : undefined;
      let ops;
      try { ops = parseContentStream(contentBytes); } catch { return; }
      for (const op of ops) {
        if (DEVICE_COLOR_OPS.has(op.operator)) scan.usesDeviceColor = true;
        if ((op.operator === 'cs' || op.operator === 'CS')) {
          const a = op.operands[0];
          if (isName(a) && DEVICE_CS.has(a.name)) scan.usesDeviceColor = true;
        }
        if (op.operator === 'ri') {
          const a = op.operands[0];
          if (isName(a)) scan.renderingIntents.push(a.name);
        }
        if (op.operator === 'BI' && op.inlineImage) {
          for (const f of filterNames(op.inlineImage.dict, ctx.R)) {
            scan.inlineImageFilters.push(INLINE_FILTER_ABBREV[f] ?? f);
          }
          const cs = ctx.R(op.inlineImage.dict.get('CS')) ?? ctx.R(op.inlineImage.dict.get('ColorSpace'));
          if (isName(cs) && DEVICE_CS.has(cs.name)) scan.usesDeviceColor = true;
        }
        if (op.operator === 'Do' && resDict) {
          const a = op.operands[0];
          if (isName(a)) {
            const xobjs = ctx.R(resDict.get('XObject'));
            const xo = isDict(xobjs) ? ctx.R(xobjs.get(a.name)) : undefined;
            if (isStream(xo) && nameOf(ctx, xo.dict, 'Subtype') === 'Form' && !seen.has(xo.dict)) {
              seen.add(xo.dict);
              try { walk(xo.dict.get('Resources'), inflateStream(xo), depth + 1); } catch { /* skip */ }
            }
          }
        }
      }
    };
    const contentObj = ctx.R(page.Dict.get('Contents'));
    const bytes = concatContents(ctx, contentObj);
    walk(page.Resources, bytes, 0);
    return scan;
  }));
}

/** Concatenate a page's content stream(s) into one decoded buffer. */
function concatContents(ctx: Ctx, contents: PdfObject): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (o: PdfObject): void => { if (isStream(o)) { try { parts.push(inflateStream(o)); } catch { /* skip */ } } };
  if (isStream(contents)) push(contents);
  else if (isArray(contents)) for (const e of contents) { const s = ctx.R(e); if (isStream(s)) { push(s); parts.push(new TextEncoder().encode('\n')); } }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** The PDF/A output-intent profile state: a ref, 'missing', or 'multiple' distinct. */
export function pdfaOutputIntentProfile(ctx: Ctx): PdfRef | 'missing' | 'multiple' {
  return memo(ctx, 'oi', () => {
    const ois = ctx.R(ctx.catalog.get('OutputIntents'));
    if (!isArray(ois)) return 'missing';
    const profiles = new Set<number>();
    let firstRef: PdfRef | undefined;
    for (const e of ois) {
      const oi = ctx.R(e);
      if (!isDict(oi)) continue;
      if (nameOf(ctx, oi, 'S') !== 'GTS_PDFA1') continue;
      const dop = oi.get('DestOutputProfile');
      if (isRef(dop)) { profiles.add(dop.num); firstRef = firstRef ?? dop; }
      else if (isStream(ctx.R(dop))) { profiles.add(-1); }
    }
    if (profiles.size === 0) return 'missing';
    if (profiles.size > 1) return 'multiple';
    return firstRef ?? 'missing';
  });
}
```

Add the rules:

```ts
const outputIntentRule: Rule = (ctx) => {
  const usesDevice = pageScans(ctx).some((s) => s.usesDeviceColor);
  if (!usesDevice) return []; // no device-dependent color ⇒ output intent optional
  const state = pdfaOutputIntentProfile(ctx);
  if (state === 'missing') {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 19005-1 §6.2.2',
      message: 'Device-dependent color is used but there is no PDF/A OutputIntent with a /DestOutputProfile.' }];
  }
  if (state === 'multiple') {
    return [{ rule: 'OutputIntent', severity: 'error', clause: 'ISO 19005-2 §6.2.2',
      message: 'Multiple PDF/A OutputIntents reference different output profiles.' }];
  }
  return [];
};

const iccBasedNRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  // Output-intent profiles.
  const ois = ctx.R(ctx.catalog.get('OutputIntents'));
  if (isArray(ois)) {
    for (const e of ois) {
      const oi = ctx.R(e);
      if (!isDict(oi)) continue;
      const dopRef = oi.get('DestOutputProfile');
      const dop = ctx.R(dopRef);
      if (isStream(dop)) {
        const n = ctx.R(dop.dict.get('N'));
        if (typeof n === 'number' && ![1, 3, 4].includes(n)) {
          issues.push({ rule: 'ICCBasedN', severity: 'error', clause: 'ISO 19005-1 §6.2.2',
            object: isRef(dopRef) ? dopRef : undefined,
            message: `OutputIntent /DestOutputProfile has /N ${n}; must be 1, 3, or 4.` });
        }
      }
    }
  }
  // /ICCBased color-space streams anywhere.
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj)) continue;
    const n = obj.dict.get('N');
    // Heuristic: an ICC profile stream used as a color space carries /N.
    if (typeof ctx.R(n) === 'number' && obj.dict.get('Type') === undefined) {
      const nv = ctx.R(n) as number;
      if (![1, 3, 4].includes(nv)) {
        issues.push({ rule: 'ICCBasedN', severity: 'error', clause: 'ISO 19005-1 §6.2.3.3', object,
          message: `ICC-based color-space stream has /N ${nv}; must be 1, 3, or 4.` });
      }
    }
  }
  return issues;
};

const deviceColorRule: Rule = (ctx) => {
  const state = pdfaOutputIntentProfile(ctx);
  if (state !== 'missing') return []; // an intent covers device color
  return pageScans(ctx).flatMap((s) =>
    s.usesDeviceColor
      ? [{ rule: 'DeviceColorWithoutIntent', severity: 'error', clause: 'ISO 19005-1 §6.2.3.3', page: s.page,
          message: 'Page uses device-dependent color without a matching PDF/A OutputIntent.' }]
      : []);
};
```

Register the three after the font rules.

Note: `iccBasedNRule`'s heuristic for standalone ICC streams (a stream with `/N` and no `/Type`) is intentionally conservative; the output-intent profile is the primary, reliable case the test exercises. Keep both branches.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): output-intent/color rules + page content scanner"
```

---

## Task 7: Transparency rules

Adds `Transparency` (part 1) and `BlendMode` (parts 2/3), plus ExtGState/group gathering.

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Produces: `extGStates(ctx): { ref?: PdfRef; dict: PdfDict }[]` (from all `/Resources /ExtGState`, pages + Form XObjects).
- Consumes: `Ctx`, page/XObject `/Group`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfA — transparency', () => {
  const ids = (bytes: Uint8Array, level: any) =>
    open(bytes).ValidatePdfA(level).Issues.map((i) => i.rule);

  it('flags a transparency group at part 1', () => {
    expect(ids(buildPdfaPdf({ transparencyGroup: true }, 1), '1b')).toContain('Transparency');
  });
  it('flags ExtGState /ca < 1 at part 1', () => {
    expect(ids(buildPdfaPdf({ lowAlpha: true }, 1), '1b')).toContain('Transparency');
  });
  it('does NOT flag transparency at part 2', () => {
    expect(ids(buildPdfaPdf({ transparencyGroup: true, lowAlpha: true }, 2), '2b')).not.toContain('Transparency');
  });
  it('warns on a non-standard blend mode at part 2', () => {
    const issues = open(buildPdfaPdf({ nonStandardBlend: true }, 2)).ValidatePdfA('2b').Warnings;
    expect(issues.map((i) => i.rule)).toContain('BlendMode');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** Every distinct ExtGState dict from page + Form XObject resources. */
function extGStates(ctx: Ctx): { ref?: PdfRef; dict: PdfDict }[] {
  return memo(ctx, 'egs', () => {
    const out: { ref?: PdfRef; dict: PdfDict }[] = [];
    const seen = new Set<PdfDict>();
    const seenRes = new Set<PdfDict>();
    const visit = (resObj: PdfObject | undefined): void => {
      const res = ctx.R(resObj);
      if (!isDict(res) || seenRes.has(res)) return;
      seenRes.add(res);
      const egs = ctx.R(res.get('ExtGState'));
      if (isDict(egs)) for (const v of egs.values()) {
        const d = ctx.R(v);
        if (isDict(d) && !seen.has(d)) { seen.add(d); out.push({ ref: isRef(v) ? v : undefined, dict: d }); }
      }
      const xobjs = ctx.R(res.get('XObject'));
      if (isDict(xobjs)) for (const v of xobjs.values()) {
        const x = ctx.R(v);
        if (isStream(x)) visit(x.dict.get('Resources'));
      }
    };
    for (const page of ctx.doc.Pages) visit(page.Resources);
    return out;
  });
}

const STANDARD_BLEND = new Set([
  'Normal', 'Compatible', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion',
  'Hue', 'Saturation', 'Color', 'Luminosity',
]);

const transparencyRule: Rule = (ctx) => {
  if (ctx.part !== 1) return [];
  const issues: ValidationIssue[] = [];
  // Transparency groups on pages and Form XObjects.
  for (const [object, obj] of allObjects(ctx)) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!dict) continue;
    const grp = ctx.R(dict.get('Group'));
    if (isDict(grp) && nameOf(ctx, grp, 'S') === 'Transparency') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
        message: 'Transparency group is prohibited in PDF/A-1.' });
    }
  }
  // ExtGState soft masks, blend modes, constant alpha.
  for (const { ref: object, dict } of extGStates(ctx)) {
    const sm = ctx.R(dict.get('SMask'));
    if (sm !== undefined && !(isName(sm) && sm.name === 'None')) {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
        message: 'ExtGState /SMask other than /None is prohibited in PDF/A-1.' });
    }
    const bm = ctx.R(dict.get('BM'));
    const bmName = isName(bm) ? bm.name : isArray(bm) && isName(ctx.R(bm[0])) ? (ctx.R(bm[0]) as { name: string }).name : undefined;
    if (bmName && bmName !== 'Normal' && bmName !== 'Compatible') {
      issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
        message: `ExtGState blend mode '${bmName}' is prohibited in PDF/A-1.` });
    }
    for (const k of ['CA', 'ca']) {
      const v = ctx.R(dict.get(k));
      if (typeof v === 'number' && v < 1) {
        issues.push({ rule: 'Transparency', severity: 'error', clause: 'ISO 19005-1 §6.4', object,
          message: `ExtGState /${k} ${v} (< 1) implies transparency, prohibited in PDF/A-1.` });
      }
    }
  }
  return issues;
};

const blendModeRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  return extGStates(ctx).flatMap(({ ref: object, dict }) => {
    const bm = ctx.R(dict.get('BM'));
    const bmName = isName(bm) ? bm.name : isArray(bm) && isName(ctx.R(bm[0])) ? (ctx.R(bm[0]) as { name: string }).name : undefined;
    if (bmName && !STANDARD_BLEND.has(bmName)) {
      return [{ rule: 'BlendMode', severity: 'warning', clause: 'ISO 19005-2 §6.2.4.3', object,
        message: `Non-standard blend mode '${bmName}'.` }];
    }
    return [];
  });
};
```

Register both after the color rules.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): transparency rules (Transparency part1, BlendMode part2/3)"
```

---

## Task 8: Annotation / form / action rules

Adds `AnnotationAppearance`, `AnnotationSubtype`, `AnnotationFlags`, `AnnotationOpacity`, `Actions`, `AdditionalActions`, `NeedAppearances`, `XFA`.

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Produces: `eachAnnotation(ctx): { ref?: PdfRef; dict: PdfDict; page: Page }[]`; `collectActionTypes(ctx, obj): string[]`.
- Consumes: `Ctx`, catalog `/OpenAction`/`/AA`/`/Names`/`/AcroForm`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfA — annotations/forms/actions', () => {
  const ids = (bytes: Uint8Array, level: any = '2b') =>
    open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags an annotation with no appearance stream', () => {
    expect(ids(buildPdfaPdf({ annotNoAp: true }))).toContain('AnnotationAppearance');
  });
  it('flags a prohibited annotation subtype', () => {
    expect(ids(buildPdfaPdf({ movieAnnot: true }))).toContain('AnnotationSubtype');
  });
  it('flags a Hidden annotation flag', () => {
    expect(ids(buildPdfaPdf({ hiddenAnnot: true }))).toContain('AnnotationFlags');
  });
  it('flags a JavaScript action', () => {
    expect(ids(buildPdfaPdf({ jsAction: true }))).toContain('Actions');
  });
  it('flags additional actions', () => {
    expect(ids(buildPdfaPdf({ additionalAction: true }))).toContain('AdditionalActions');
  });
  it('flags AcroForm /NeedAppearances', () => {
    expect(ids(buildPdfaPdf({ needAppearances: true }))).toContain('NeedAppearances');
  });
  it('flags dynamic XFA', () => {
    expect(ids(buildPdfaPdf({ xfa: true }))).toContain('XFA');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
/** Every annotation dict across all pages. */
function eachAnnotation(ctx: Ctx): { ref?: PdfRef; dict: PdfDict; page: Page }[] {
  return memo(ctx, 'annots', () => {
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
  });
}

const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);
const PROHIBITED_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript', 'SetState', 'Hide', 'SetOCGState',
]);

/** Collect every action /S type reachable from an action dict (following /Next). */
function collectActionTypes(ctx: Ctx, actionObj: PdfObject | undefined, seen = new Set<PdfDict>()): string[] {
  const a = ctx.R(actionObj);
  if (!isDict(a) || seen.has(a)) return [];
  seen.add(a);
  const types: string[] = [];
  const s = nameOf(ctx, a, 'S');
  if (s) types.push(s);
  const next = ctx.R(a.get('Next'));
  if (isArray(next)) for (const n of next) types.push(...collectActionTypes(ctx, n, seen));
  else if (isDict(next)) types.push(...collectActionTypes(ctx, next, seen));
  return types;
}

const annotationAppearanceRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup' || subtype === 'Link') return [];
    const ap = ctx.R(dict.get('AP'));
    const n = isDict(ap) ? ap.get('N') : undefined;
    if (n === undefined) {
      return [{ rule: 'AnnotationAppearance', severity: 'error', clause: 'ISO 19005-1 §6.5.3', object, page,
        message: `${subtype ?? 'Annotation'} has no normal appearance stream (/AP /N).` }];
    }
    return [];
  });

const annotationSubtypeRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    return subtype && PROHIBITED_ANNOTS.has(subtype)
      ? [{ rule: 'AnnotationSubtype', severity: 'error', clause: 'ISO 19005-1 §6.5.2', object, page,
          message: `Annotation subtype /${subtype} is prohibited in PDF/A.` }]
      : [];
  });

const annotationFlagsRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup') return [];
    const f = ctx.R(dict.get('F'));
    const flags = typeof f === 'number' ? f : 0;
    const issues: ValidationIssue[] = [];
    if ((flags & 2) !== 0) issues.push(mkFlag('Hidden')); // bit 2
    if ((flags & 32) !== 0) issues.push(mkFlag('NoView')); // bit 6
    if ((flags & 1) !== 0) issues.push(mkFlag('Invisible')); // bit 1
    if ((flags & 4) === 0) issues.push(mkFlag('not Print')); // bit 3 must be set
    function mkFlag(which: string): ValidationIssue {
      return { rule: 'AnnotationFlags', severity: 'error', clause: 'ISO 19005-1 §6.5.3', object, page,
        message: `Annotation flag invalid for PDF/A (${which}).` };
    }
    return issues;
  });

const annotationOpacityRule: Rule = (ctx) => {
  if (ctx.part !== 1) return [];
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const ca = ctx.R(dict.get('CA'));
    return typeof ca === 'number' && ca !== 1
      ? [{ rule: 'AnnotationOpacity', severity: 'error', clause: 'ISO 19005-1 §6.5.3', object, page,
          message: `Annotation /CA ${ca} (≠ 1) is prohibited in PDF/A-1.` }]
      : [];
  });
};

const actionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const check = (obj: PdfObject | undefined, where: string): void => {
    for (const t of collectActionTypes(ctx, obj)) {
      if (PROHIBITED_ACTIONS.has(t)) {
        issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 19005-1 §6.6.1',
          message: `Prohibited action /${t} (${where}).` });
      }
    }
  };
  check(ctx.catalog.get('OpenAction'), 'catalog /OpenAction');
  // /Names /JavaScript tree ⇒ JavaScript actions present.
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('JavaScript') !== undefined) {
    issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 19005-1 §6.6.1',
      message: 'Document contains a /Names /JavaScript tree (JavaScript actions).' });
  }
  for (const { dict } of eachAnnotation(ctx)) check(dict.get('A'), 'annotation /A');
  return issues;
};

const additionalActionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const slots: [PdfObject | undefined, string][] = [
    [ctx.catalog.get('AA'), 'catalog /AA'],
    ...ctx.doc.Pages.map((p) => [p.Dict.get('AA'), 'page /AA'] as [PdfObject | undefined, string]),
    ...eachAnnotation(ctx).map(({ dict }) => [dict.get('AA'), 'annotation /AA'] as [PdfObject | undefined, string]),
  ];
  for (const [aa, where] of slots) {
    const d = ctx.R(aa);
    if (!isDict(d)) continue;
    if (ctx.part === 1) {
      issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-1 §6.6.2',
        message: `Additional-actions dictionary (${where}) is prohibited in PDF/A-1.` });
    } else {
      for (const v of d.values()) {
        for (const t of collectActionTypes(ctx, v)) {
          if (PROHIBITED_ACTIONS.has(t)) {
            issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-2 §6.6.2',
              message: `Prohibited action /${t} in additional-actions (${where}).` });
          }
        }
      }
    }
  }
  return issues;
};

const needAppearancesRule: Rule = (ctx) => {
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (isDict(acro) && ctx.R(acro.get('NeedAppearances')) === true) {
    return [{ rule: 'NeedAppearances', severity: 'error', clause: 'ISO 19005-1 §6.9',
      message: 'AcroForm /NeedAppearances is true; PDF/A requires generated appearances.' }];
  }
  return [];
};

const xfaRule: Rule = (ctx) => {
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (isDict(acro) && acro.get('XFA') !== undefined) {
    return [{ rule: 'XFA', severity: 'error', clause: 'ISO 19005-2 §6.9',
      message: 'Dynamic XFA forms (/AcroForm /XFA) are prohibited in PDF/A.' }];
  }
  return [];
};
```

Register all eight after the transparency rules.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): annotation/form/action rules"
```

---

## Task 9: Image + content-scan filter/intent rules

Adds `ImageFilter`, `ImageInterpolate`, `RenderingIntent`.

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Consumes: `allObjects`, `pageScans` (inline-image filters + rendering intents), `filterNames`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfA — images/content-scan', () => {
  const ids = (bytes: Uint8Array, level: any) =>
    open(bytes).ValidatePdfA(level).Issues.map((i) => i.rule);

  it('flags a JPXDecode image at part 1', () => {
    expect(ids(buildPdfaPdf({ jpxImage: true }, 1), '1b')).toContain('ImageFilter');
  });
  it('does NOT flag JPXDecode at part 2', () => {
    expect(ids(buildPdfaPdf({ jpxImage: true }, 2), '2b')).not.toContain('ImageFilter');
  });
  it('flags an LZW image filter at any part', () => {
    expect(ids(buildPdfaPdf({ inlineLzwImage: true }, 2), '2b')).toContain('ImageFilter');
  });
  it('warns on /Interpolate true', () => {
    const w = open(buildPdfaPdf({ interpolateImage: true }, 2)).ValidatePdfA('2b').Warnings;
    expect(w.map((i) => i.rule)).toContain('ImageInterpolate');
  });
  it('flags a non-standard rendering intent', () => {
    expect(ids(buildPdfaPdf({ badRenderingIntent: true }, 2), '2b')).toContain('RenderingIntent');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
const STANDARD_INTENTS = new Set(['AbsoluteColorimetric', 'RelativeColorimetric', 'Saturation', 'Perceptual']);

const imageFilterRule: Rule = (ctx) => {
  const prohibited = new Set(['LZWDecode', ...(ctx.part === 1 ? ['JPXDecode', 'JBIG2Decode'] : [])]);
  const issues: ValidationIssue[] = [];
  // Image XObjects.
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj) || nameOf(ctx, obj.dict, 'Subtype') !== 'Image') continue;
    for (const f of filterNames(obj.dict, ctx.R)) {
      if (prohibited.has(f)) {
        issues.push({ rule: 'ImageFilter', severity: 'error', clause: 'ISO 19005-1 §6.2.5', object,
          message: `Image uses the prohibited filter /${f}.` });
      }
    }
  }
  // Inline images (from the content scan).
  for (const s of pageScans(ctx)) {
    for (const f of s.inlineImageFilters) {
      if (prohibited.has(f)) {
        issues.push({ rule: 'ImageFilter', severity: 'error', clause: 'ISO 19005-1 §6.2.5', page: s.page,
          message: `Inline image uses the prohibited filter /${f}.` });
      }
    }
  }
  return issues;
};

const imageInterpolateRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Image' && ctx.R(obj.dict.get('Interpolate')) === true
      ? [{ rule: 'ImageInterpolate', severity: 'warning', clause: 'ISO 19005-1 §6.2.6', object,
          message: 'Image /Interpolate true is prohibited in PDF/A.' }]
      : []);

const renderingIntentRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  // From content `ri` operators.
  for (const s of pageScans(ctx)) {
    for (const ri of s.renderingIntents) {
      if (!STANDARD_INTENTS.has(ri)) {
        issues.push({ rule: 'RenderingIntent', severity: 'error', clause: 'ISO 19005-1 §6.2.9', page: s.page,
          message: `Non-standard rendering intent '${ri}'.` });
      }
    }
  }
  // From image-XObject /Intent.
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj) || nameOf(ctx, obj.dict, 'Subtype') !== 'Image') continue;
    const intent = nameOf(ctx, obj.dict, 'Intent');
    if (intent && !STANDARD_INTENTS.has(intent)) {
      issues.push({ rule: 'RenderingIntent', severity: 'error', clause: 'ISO 19005-1 §6.2.9', object,
        message: `Image uses non-standard rendering intent '${intent}'.` });
    }
  }
  return issues;
};
```

Register all three after the annotation rules.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): image + content-scan rules (filter, interpolate, intent)"
```

---

## Task 10: Level `a` — fold in PDF/UA tagging checks + gating tests

Adds the `a`-level delegation to `validatePdfUa` and consolidates level-gating coverage.

**Files:**
- Modify: `src/pdfavalidate.ts`
- Modify: `test/pdfavalidate.test.ts`

**Interfaces:**
- Consumes: `validatePdfUa` from `./structvalidate.js`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ValidatePdfA — level a folds in PDF/UA', () => {
  it('surfaces a UA:Tagged error for an untagged doc at 2a', () => {
    // The clean PDF/A fixture is not tagged (no /StructTreeRoot).
    const report = open(buildPdfaPdf({}, 2)).ValidatePdfA('2a');
    expect(report.Errors.map((e) => e.rule)).toContain('UA:Tagged');
    expect(report.Passed).toBe(false);
  });
  it('does NOT run UA checks at level b', () => {
    const report = open(buildPdfaPdf({}, 2)).ValidatePdfA('2b');
    expect(report.Issues.some((i) => i.rule.startsWith('UA:'))).toBe(false);
  });
});

describe('ValidatePdfA — Passed/partition semantics', () => {
  it('a warning-only document still Passes', () => {
    // /Interpolate true is a warning; nothing else fails.
    const report = open(buildPdfaPdf({ interpolateImage: true }, 2)).ValidatePdfA('2b');
    expect(report.Errors).toEqual([]);
    expect(report.Warnings.length).toBeGreaterThan(0);
    expect(report.Passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavalidate.test.ts`
Expected: FAIL (UA folding not implemented).

- [ ] **Step 3: Implement the folding in `validatePdfA`**

Add the import:

```ts
import { validatePdfUa } from './structvalidate.js';
```

In `validatePdfA`, after the `for (const rule of RULES)` loop and before constructing the report:

```ts
  if (lvl === 'a') {
    for (const ua of validatePdfUa(doc, catalog).Issues) {
      issues.push({ ...ua, rule: `UA:${ua.rule}`, clause: `ISO 19005-${part} §6.8 / ${ua.clause ?? ''}`.trim() });
    }
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfavalidate.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfavalidate.ts test/pdfavalidate.test.ts
git commit -m "feat(pdfa): fold PDF/UA tagging checks into level-a validation"
```

---

## Task 11: Documentation + full-suite verification + close

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the Features bullet**

In `README.md`, in the Features list (near the PDF/UA validation bullet, line ~37), add:

```markdown
- **PDF/A validation** — `doc.ValidatePdfA(level)` checks a curated, machine-decidable subset of PDF/A (ISO 19005) for parts 1–3 at every conformance level (`'1b'`/`'1a'`/`'2b'`/`'2u'`/`'2a'`/`'3b'`/`'3u'`/`'3a'`): no encryption, file `/ID` present, version ceiling, no external streams or prohibited filters (LZW everywhere; JPX/JBIG2 in part 1), no PostScript/reference XObjects, conformant identification XMP (`pdfaid:part`/`conformance`) and `/Info`↔XMP consistency, a PDF/A `/OutputIntent` with an ICC `/DestOutputProfile` when device color is used, all fonts embedded with valid encodings (and `/ToUnicode` at level `u`/`a`), part-1 transparency limits, annotation appearance/flag/subtype constraints, no JavaScript/prohibited actions, `/NeedAppearances`/XFA form constraints, and (content-scan) inline-image filters and rendering intents. Level `a` additionally folds in the PDF/UA tagging checks. Returns the same `ValidationReport` (`Issues`/`Errors`/`Warnings`/`Passed`) as `ValidatePdfUa`, each `ValidationIssue` carrying a stable `rule` id, `severity`, ISO `clause`, and the offending `object`/`page`/`element`.
```

- [ ] **Step 2: Add the Limitations bullet**

In the Limitations section (near the PDF/UA limitation, line ~661), add:

```markdown
- **PDF/A validation is a curated, decidable subset** — `doc.ValidatePdfA(level)` checks objectively decidable ISO 19005 (parts 1–3) rules from the object model, catalog, metadata, resources, and content streams. It does **not** parse ICC profiles for validity, verify glyph presence inside embedded font programs, perform any rendering-based or visual-fidelity check, recursively validate *embedded* PDFs as PDF/A, or validate XMP extension schemas; PDF/A-4 is not covered. Some checks are heuristic (device-color detection from content operators; standalone ICC-stream `/N`). A passing report is therefore **necessary but not sufficient** for certified PDF/A conformance.
```

- [ ] **Step 3: Run the full suite + typecheck + build**

Run: `npm run typecheck` → no errors.
Run: `npm test` → all tests green (existing suite + new `test/pdfavalidate.test.ts`).
Run: `npm run build` → succeeds (ESM + .d.ts emit clean).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document PDF/A validation (Features + Limitations)"
```

- [ ] **Step 5: Close the issue and push**

```bash
bd close <issue-id>   # the PDF/A validation issue created during brainstorming
git pull --rebase
git push
git status            # MUST show up to date with origin
```

---

## Self-Review

**Spec coverage:** Every rule in the spec's rule catalog maps to a task — file/structure (Task 3), metadata (Task 4), color/output-intent incl. content-scan device color (Task 6), fonts (Task 5), transparency (Task 7), annotations/forms/actions (Task 8), images/content-scan (Task 9), level-`a` UA folding (Task 10). Public API (`PdfALevel`, `ValidatePdfA`, `object?` locator), the `validation.ts` refactor, testing strategy, and docs are all covered (Tasks 1, 2, 11). The content-scan tier the user explicitly requested is implemented in Tasks 6 and 9.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one conditional ("if the parser rejects a dangling `/Encrypt`") names the exact remediation and where to apply it.

**Type consistency:** `Ctx`, `Rule`, `memo`, `filterNames`, `allObjects`, `nameOf`, `enumerateFonts`, `descendantFont`, `hasFontProgram`, `pageScans`, `PageScan`, `pdfaOutputIntentProfile`, `extGStates`, `eachAnnotation`, `collectActionTypes` are each defined once and reused with consistent signatures; `ValidationIssue.object` is `PdfRef | undefined` everywhere; `severity` values are the literal `'error'`/`'warning'` (cast via `Severity` only where computed). Rule registration is cumulative and the final `RULES` array contains all rules.

**Open API:** confirmed `Document.Open(bytes)` imported from `../src/index.js`, matching `test/structvalidate.test.ts`. No open items remain.
