# PDF/A Conversion / Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `doc.ConvertToPdfA(level, opts)` — remediate a document toward PDF/A levels `b`/`u`, then re-validate so the report mirrors `ValidatePdfA`.

**Architecture:** A new pure engine `src/pdfaconvert.ts` runs ordered remediation passes that mutate the live model, then runs `validatePdfA(level)` and reports its remaining errors as `unresolved`. Enabling changes: `pdfaid` support in `xmp.ts`, a committed public-domain sRGB ICC profile (`src/srgb.ts`), and deriving the serialized PDF header version from catalog `/Version`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext — import specifiers end in `.js`), vitest. Zero runtime dependencies (only `node:` built-ins).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. The sRGB profile ships as committed data (base64), not a dependency.
- **ESM + NodeNext** — every relative import specifier carries a `.js` extension.
- **TDD** — failing test first; fixtures via `test/helpers/build-pdfa-pdf.ts` (extend it as needed).
- **Live-mutation model** — conversion mutates the in-memory object map in place; the result is emitted by the next `Save()`.
- **`PdfDict` is `Map<string, PdfObject>`** keyed by name without `/`. Guards: `isDict`/`isName`/`isStream`/`isString`/`isArray`/`isRef`; a name is `{ kind:'name', name }`, a string `{ kind:'string', bytes }`, a stream `{ kind:'stream', dict, raw }`, a ref `{ kind:'ref', num, gen }`. Resolve indirects with `doc.resolve(x)` / `ctx.R`.
- **Honesty invariant** — `report.unresolved` MUST equal `ValidatePdfA(level).Errors` after the passes run. Conversion never claims a fix the validator would not confirm.
- **Quality gates before closing any task:** `npm run typecheck` and `npm test` both green.

## Scope refinements (decisions made during planning)

- **Header version** is derived from catalog `/Version` (else the opened file header, else `1.7`) in both `Document.headerVersion()` and the serializer. The Version pass sets catalog `/Version`; this makes in-memory re-validation and the saved bytes consistent (Task 3).
- **RenderingIntent** remediation rewrites image-XObject `/Intent` only. A non-standard `ri` **operator inside a content stream** is left report-only (content-stream rewriting is out of scope for v1); documented in Limitations.

---

## File Structure

- **Modify** `src/xmp.ts` — `pdfaPart`/`pdfaConformance` fields, build + read.
- **Create** `src/srgb.ts` — committed public-domain sRGB ICC profile (base64) + `SRGB_N`.
- **Modify** `src/document.ts` — `ConvertToPdfA`, `headerVersion()` prefers catalog `/Version`, `Save` passes the version.
- **Modify** `src/serializer.ts` — emit the header version from catalog `/Version`.
- **Create** `src/pdfaconvert.ts` — the conversion engine, passes, and types.
- **Modify** `src/index.ts` — export the conversion types.
- **Modify** `test/helpers/build-pdfa-pdf.ts` — add a couple of fixture toggles.
- **Create** `test/pdfaconvert.test.ts` — the test suite.
- **Modify** `README.md` — Features + Limitations.

---

## Task 1: `pdfaid` support in `xmp.ts`

**Files:**
- Modify: `src/xmp.ts`
- Test: `test/xmp.test.ts` (add cases; create if absent — check first with a glob)

**Interfaces:**
- Produces: `XmpMetadata.pdfaPart?: number`, `XmpMetadata.pdfaConformance?: string`; `buildXmp` emits a `pdfaid` Description when either is set; `readXmp` parses them back.

- [ ] **Step 1: Write the failing test**

Add to `test/xmp.test.ts` (if the file does not exist, create it with the vitest imports `import { describe, it, expect } from 'vitest';` and `import { buildXmp, readXmp } from '../src/xmp.js';`):

```ts
describe('xmp pdfaid', () => {
  it('round-trips pdfaid:part and pdfaid:conformance', () => {
    const packet = buildXmp({ title: 'T', pdfaPart: 2, pdfaConformance: 'B' });
    expect(packet).toContain('pdfaid:part');
    const back = readXmp(new TextEncoder().encode(packet));
    expect(back.pdfaPart).toBe(2);
    expect(back.pdfaConformance).toBe('B');
    expect(back.title).toBe('T');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/xmp.test.ts`
Expected: FAIL (`pdfaPart` undefined / property unknown).

- [ ] **Step 3: Add the fields to `XmpMetadata`**

In `src/xmp.ts`, in the `XmpMetadata` interface (after `rights?: string;`), add:

```ts
  pdfaPart?: number;              // pdfaid:part (PDF/A identification)
  pdfaConformance?: string;       // pdfaid:conformance (A/B/U)
```

- [ ] **Step 4: Emit the pdfaid Description in `buildXmp`**

In `buildXmp`, replace the final `return` template so a second `rdf:Description` is emitted when identification is present. Change the function body's tail to:

```ts
  const pdfaDesc = (meta.pdfaPart !== undefined || meta.pdfaConformance !== undefined)
    ? `\n  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"`
      + (meta.pdfaPart !== undefined ? ` pdfaid:part="${meta.pdfaPart}"` : '')
      + (meta.pdfaConformance !== undefined ? ` pdfaid:conformance="${escapeXml(meta.pdfaConformance)}"` : '')
      + `/>`
    : '';

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
${lines.join('\n')}
  </rdf:Description>${pdfaDesc}
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
```

- [ ] **Step 5: Parse pdfaid in `readXmp`**

In `readXmp`, before the final `return meta;`, add:

```ts
  const partAttr = /pdfaid:part\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfaid:part>\s*([^<]+?)\s*<\/pdfaid:part>/.exec(raw);
  if (partAttr) meta.pdfaPart = Number(partAttr[1].trim());
  const confAttr = /pdfaid:conformance\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfaid:conformance>\s*([^<]+?)\s*<\/pdfaid:conformance>/.exec(raw);
  if (confAttr) meta.pdfaConformance = confAttr[1].trim();
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/xmp.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/xmp.ts test/xmp.test.ts
git commit -m "feat(xmp): pdfaid:part/conformance build + read support"
```

---

## Task 2: Bundled sRGB ICC profile (`src/srgb.ts`)

**Files:**
- Create: `src/srgb.ts`
- Test: `test/srgb.test.ts`

**Interfaces:**
- Produces: `export const SRGB_N = 3;` and `export function srgbIcc(): Uint8Array;` (decoded profile bytes).

- [ ] **Step 1: Vendor a public-domain sRGB profile and generate the base64 constant**

Obtain the public-domain `sRGB2014.icc` profile (ICC, ~3 KB; published by the International Color Consortium at https://www.color.org/srgbprofiles.xalter, public domain) and base64-encode it into the module. Run:

```bash
# from the repo root, with sRGB2014.icc saved to /tmp
B64=$(base64 -w0 /tmp/sRGB2014.icc)
printf "export const SRGB_N = 3;\nconst B64 =\n  '%s';\nexport function srgbIcc(): Uint8Array {\n  return Uint8Array.from(Buffer.from(B64, 'base64'));\n}\n" "$B64" > src/srgb.ts
```

If the network is unavailable, ship a minimal placeholder profile body instead (tests only require a stream with `/N 3`; real-world fidelity wants the genuine profile — leave a code comment noting the source to swap in). The minimal fallback:

```ts
export const SRGB_N = 3;
// Minimal stand-in ICC body. Replace with the public-domain sRGB2014.icc
// (https://www.color.org/srgbprofiles.xalter) for real-world color fidelity.
const B64 = 'AAAEAAAAAAA=';
export function srgbIcc(): Uint8Array {
  return Uint8Array.from(Buffer.from(B64, 'base64'));
}
```

- [ ] **Step 2: Write the test**

Create `test/srgb.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { srgbIcc, SRGB_N } from '../src/srgb.js';

describe('srgb profile', () => {
  it('decodes to non-empty bytes with N=3', () => {
    expect(SRGB_N).toBe(3);
    expect(srgbIcc().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run to verify pass**

Run: `npx vitest run test/srgb.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 4: Commit**

```bash
git add src/srgb.ts test/srgb.test.ts
git commit -m "feat(pdfa): bundle public-domain sRGB ICC profile for output intents"
```

---

## Task 3: Header version from catalog `/Version`

**Files:**
- Modify: `src/serializer.ts`
- Modify: `src/document.ts`
- Test: `test/pdfaconvert.test.ts` (create with this first test)

**Interfaces:**
- Consumes: `serializeClassic`/`serializeCompressed` (internal).
- Produces: serialized header reflects catalog `/Version`; `Document.headerVersion()` prefers catalog `/Version`.

- [ ] **Step 1: Write the failing test**

Create `test/pdfaconvert.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

const open = (b: Uint8Array) => Document.Open(b);

describe('header version from catalog /Version', () => {
  it('emits the catalog /Version in the saved header and reports it', () => {
    const doc = open(buildPdfaPdf({ headerVersion: '1.7', catalogVersion: '1.4' }, 1));
    expect(doc.headerVersion()).toBe('1.4');
    const saved = doc.Save();
    expect(new TextDecoder('latin1').decode(saved.subarray(0, 8))).toBe('%PDF-1.4');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL (`headerVersion()` returns `'1.7'` from the file header; saved header is `%PDF-1.7`).

- [ ] **Step 3: Make `headerVersion()` prefer catalog `/Version`**

In `src/document.ts`, replace the `headerVersion()` body with:

```ts
  headerVersion(): string | undefined {
    const cv = this.resolve(this.catalog().get('Version'));
    if (isName(cv)) return cv.name;
    if (!this.originalBytes) return undefined;
    const head = new TextDecoder('latin1').decode(this.originalBytes.subarray(0, 16));
    const m = /%PDF-(\d+\.\d+)/.exec(head);
    return m ? m[1] : undefined;
  }
```

(`isName` is already imported in `document.ts`.)

- [ ] **Step 4: Thread the version into the serializer**

In `src/serializer.ts`, add a helper near the top (after the imports):

```ts
/** The header version to emit: catalog /Version when present, else 1.7. */
function headerVersion(objects: Map<number, PdfObject>, trailer: PdfDict): string {
  const root = trailer.get('Root');
  const cat = root && (root as PdfRef).kind === 'ref' ? objects.get((root as PdfRef).num) : undefined;
  if (cat instanceof Map) {
    const v = cat.get('Version');
    if (v && (v as PdfName).kind === 'name') return (v as PdfName).name;
  }
  return '1.7';
}
```

Ensure `PdfRef` and `PdfName` are imported in `serializer.ts` (add to the existing `./types.js` import if missing).

Then change `serializeDocument` to compute and pass it:

```ts
export function serializeDocument(
  objects: Map<number, PdfObject>, trailer: PdfDict, options: SerializeOptions = {},
): Uint8Array {
  const plan = planDocument(objects, trailer);
  const ver = headerVersion(objects, trailer);
  if (!options.encrypt) {
    return options.compressed ? serializeCompressed(plan, trailer, ver) : serializeClassic(plan, trailer, ver);
  }
  const { id0, id1 } = resolveIds(trailer);
  const encryptor = buildEncryptor(options.encrypt, id0);
  return options.compressed
    ? serializeCompressedEncrypted(plan, trailer, encryptor, id0, id1, ver)
    : serializeClassicEncrypted(plan, encryptor, id0, id1, ver);
}
```

Update the four serializer function signatures to accept a trailing `ver: string = '1.7'` parameter and replace their `push(enc('%PDF-1.7\n%âãÏÓ\n'));` line with `push(enc(\`%PDF-${ver}\n%âãÏÓ\n\`));`. The functions are `serializeClassic`, `serializeCompressed`, `serializeClassicEncrypted`, `serializeCompressedEncrypted`. Leave `serializeClassicSigned` (the signing placeholder path) at `1.7` — signing is not part of conversion.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/pdfaconvert.test.ts` → PASS
Run: `npm test` → full suite green (confirms no serializer regression).

- [ ] **Step 6: Commit**

```bash
git add src/serializer.ts src/document.ts test/pdfaconvert.test.ts
git commit -m "feat: derive serialized PDF header version from catalog /Version"
```

---

## Task 4: Conversion harness + identification / version / fileId passes

**Files:**
- Create: `src/pdfaconvert.ts`
- Modify: `src/document.ts` (add `ConvertToPdfA`)
- Modify: `src/index.ts`
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Produces:
  - `type ConvertCategory = 'javascript'|'multimedia'|'embeddedFiles'|'xfa'|'optionalContent'|'postScript'`
  - `interface ConvertOptions { iccProfile?: { bytes: Uint8Array; n: 1|3|4; identifier?: string }; preserve?: ConvertCategory[] }`
  - `interface ConvertAction { rule: string; action: string; object?: PdfRef; page?: Page }`
  - `interface ConversionReport { applied: ConvertAction[]; unresolved: ValidationIssue[]; passed: boolean }`
  - `function convertToPdfA(doc, catalog, level, opts): ConversionReport`
  - `interface Cctx { doc; catalog; part; level; preserve: Set<ConvertCategory>; icc: { bytes; n; identifier }; R }`
  - `type Pass = (ctx: Cctx) => ConvertAction[]`, registry `PASSES: Pass[]`
  - `Document.ConvertToPdfA(level, opts?): ConversionReport`

- [ ] **Step 1: Create `src/pdfaconvert.ts` with the engine and the first three passes**

```ts
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef, isName, isDict, isArray, isRef, name,
} from './types.js';
import type { Page } from './page.js';
import { type ValidationIssue } from './validation.js';
import { validatePdfA, parseLevel, type PdfALevel } from './pdfavalidate.js';
import { srgbIcc, SRGB_N } from './srgb.js';

export type ConvertCategory =
  | 'javascript' | 'multimedia' | 'embeddedFiles' | 'xfa' | 'optionalContent' | 'postScript';

export interface ConvertOptions {
  iccProfile?: { bytes: Uint8Array; n: 1 | 3 | 4; identifier?: string };
  preserve?: ConvertCategory[];
}

export interface ConvertAction {
  rule: string;
  action: string;
  object?: PdfRef;
  page?: Page;
}

export interface ConversionReport {
  applied: ConvertAction[];
  unresolved: ValidationIssue[];
  passed: boolean;
}

export interface Cctx {
  doc: Document;
  catalog: PdfDict;
  part: 1 | 2 | 3;
  level: 'b' | 'u' | 'a';
  preserve: Set<ConvertCategory>;
  icc: { bytes: Uint8Array; n: 1 | 3 | 4; identifier: string };
  R(o: PdfObject | undefined): PdfObject;
}

type Pass = (ctx: Cctx) => ConvertAction[];

export function convertToPdfA(
  doc: Document, catalog: PdfDict, level: PdfALevel, opts: ConvertOptions = {},
): ConversionReport {
  const { part, level: lvl } = parseLevel(level);
  const ic = opts.iccProfile ?? { bytes: srgbIcc(), n: SRGB_N as 3, identifier: 'sRGB' };
  const ctx: Cctx = {
    doc, catalog, part, level: lvl,
    preserve: new Set(opts.preserve ?? []),
    icc: { bytes: ic.bytes, n: ic.n, identifier: ic.identifier ?? 'Custom' },
    R: (o) => doc.resolve(o),
  };
  const applied: ConvertAction[] = [];
  for (const pass of PASSES) applied.push(...pass(ctx));
  const unresolved = validatePdfA(doc, catalog, level).Errors;
  return { applied, unresolved, passed: unresolved.length === 0 };
}

/** The name value of dict.get(key), resolved, or undefined. */
function nameOf(ctx: Cctx, dict: PdfDict, key: string): string | undefined {
  const v = ctx.R(dict.get(key));
  return isName(v) ? v.name : undefined;
}

// ---- passes ----------------------------------------------------------------

/** Write identification XMP (pdfaid + /Info mirror) via the facade. */
const identificationPass: Pass = (ctx) => {
  const conf = ctx.level.toUpperCase(); // 'B' | 'U' | 'A'
  const info = ctx.doc.GetMetadata();
  ctx.doc.SetXmp({
    pdfaPart: ctx.part,
    pdfaConformance: conf,
    ...(info.title !== undefined ? { title: info.title } : {}),
    ...(info.author !== undefined ? { authors: [info.author] } : {}),
    ...(info.subject !== undefined ? { description: info.subject } : {}),
    ...(info.keywords !== undefined ? { keywords: info.keywords } : {}),
  });
  return [{ rule: 'PdfaIdentification', action: `Wrote pdfaid:part ${ctx.part}/conformance ${conf} and mirrored /Info into XMP.` }];
};

/** Set catalog /Version to the part ceiling when the current version exceeds it. */
const versionPass: Pass = (ctx) => {
  const ceiling = ctx.part === 1 ? '1.4' : '1.7';
  const cur = ctx.doc.headerVersion();
  if (cur !== undefined && Number(cur) <= Number(ceiling) + 1e-9) return [];
  ctx.catalog.set('Version', name(ceiling));
  return [{ rule: 'Version', action: `Set catalog /Version to ${ceiling}.` }];
};

/** Ensure the trailer carries an /ID. */
const fileIdPass: Pass = (ctx) => {
  const id = ctx.doc.trailer.get('ID');
  if (isArray(id) && id.length === 2) return [];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = (i * 37 + 11) & 0xff;
  const s = { kind: 'string' as const, bytes };
  ctx.doc.trailer.set('ID', [s, s]);
  return [{ rule: 'FileID', action: 'Generated a trailer /ID.' }];
};

const PASSES: Pass[] = [
  identificationPass, versionPass, fileIdPass,
];
```

- [ ] **Step 2: Add `ConvertToPdfA` to `document.ts`**

After the `ValidatePdfA` method, add:

```ts
  /** Remediate the document toward PDF/A `level` (b/u), then re-validate.
   *  Mutates the live model in place; the result is emitted by the next Save(). */
  ConvertToPdfA(level: PdfALevel, opts?: ConvertOptions): ConversionReport {
    this.markModified();
    return convertToPdfA(this, this.catalog(), level, opts);
  }
```

Extend the existing pdfavalidate import line and add the convert import:

```ts
import { validatePdfA, type PdfALevel } from './pdfavalidate.js';
import { convertToPdfA, type ConvertOptions, type ConversionReport } from './pdfaconvert.js';
```

(`markModified()` and `get Form()` are confirmed present on `Document` at `document.ts:413` and `:426`.)

- [ ] **Step 3: Export the types from `index.ts`**

Add to `src/index.ts`:

```ts
export type { ConvertOptions, ConvertAction, ConversionReport, ConvertCategory } from './pdfaconvert.js';
```

- [ ] **Step 4: Write the failing tests**

Add to `test/pdfaconvert.test.ts`:

```ts
describe('ConvertToPdfA — identification/version/fileId', () => {
  it('writes pdfaid and clears Metadata/PdfaIdentification', () => {
    const doc = open(buildPdfaPdf({ omitMetadata: true, infoTitle: 'Doc' }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).toContain('PdfaIdentification');
    const after = doc.ValidatePdfA('2b').Errors.map((e) => e.rule);
    expect(after).not.toContain('Metadata');
    expect(after).not.toContain('PdfaIdentification');
  });
  it('generates a missing /ID', () => {
    const doc = open(buildPdfaPdf({ omitId: true }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).toContain('FileID');
    expect(doc.ValidatePdfA('2b').Errors.map((e) => e.rule)).not.toContain('FileID');
  });
  it('round-trips pdfaid through Save/Open', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Doc' }, 2));
    doc.ConvertToPdfA('2b');
    const reopened = open(doc.Save());
    expect(reopened.GetXmp().pdfaPart).toBe(2);
    expect(reopened.GetXmp().pdfaConformance).toBe('B');
  });
});
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/pdfaconvert.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pdfaconvert.ts src/document.ts src/index.ts test/pdfaconvert.test.ts
git commit -m "feat(pdfa): ConvertToPdfA harness + identification/version/fileId passes"
```

---

## Task 5: Output-intent pass

**Files:**
- Modify: `src/pdfaconvert.ts`
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Cctx`, `ctx.icc`, `Document.allocObject`.

- [ ] **Step 1: Write the failing test**

```ts
describe('ConvertToPdfA — output intent', () => {
  it('adds an sRGB output intent and clears OutputIntent/DeviceColorWithoutIntent', () => {
    const doc = open(buildPdfaPdf({ omitOutputIntent: true, deviceColorContent: true }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).toContain('OutputIntent');
    const after = doc.ValidatePdfA('2b').Errors.map((e) => e.rule);
    expect(after).not.toContain('OutputIntent');
    expect(after).not.toContain('DeviceColorWithoutIntent');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the pass**

Add to `src/pdfaconvert.ts`:

```ts
/** Add a PDF/A OutputIntent with an ICC DestOutputProfile when none exists. */
const outputIntentPass: Pass = (ctx) => {
  const existing = ctx.R(ctx.catalog.get('OutputIntents'));
  if (isArray(existing)) {
    const hasPdfa = existing.some((e) => {
      const oi = ctx.R(e);
      return isDict(oi) && nameOf(ctx, oi, 'S') === 'GTS_PDFA1' && oi.get('DestOutputProfile') !== undefined;
    });
    if (hasPdfa) return [];
  }
  const profile: PdfDict = new Map<string, PdfObject>([
    ['N', ctx.icc.n],
    ['Length', ctx.icc.bytes.length],
  ]);
  const profileStream = { kind: 'stream' as const, dict: profile, raw: ctx.icc.bytes };
  const profileRef = ctx.doc.allocObject(profileStream);
  const oi: PdfDict = new Map<string, PdfObject>([
    ['Type', name('OutputIntent')],
    ['S', name('GTS_PDFA1')],
    ['OutputConditionIdentifier', { kind: 'string', bytes: new TextEncoder().encode(ctx.icc.identifier) }],
    ['DestOutputProfile', profileRef],
  ]);
  const arr = isArray(existing) ? [...existing, oi] : [oi];
  ctx.catalog.set('OutputIntents', arr);
  return [{ rule: 'OutputIntent', action: `Added ${ctx.icc.identifier} OutputIntent.`, object: profileRef }];
};
```

Register it after `fileIdPass` in `PASSES`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfaconvert.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(pdfa): output-intent conversion pass"
```

---

## Task 6: Annotation + form passes

**Files:**
- Modify: `src/pdfaconvert.ts`
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `ctx.doc.Pages`, `Page.Dict`, `Document.Form` (with `GenerateAppearances()`).
- Produces: helper `eachAnnotation(ctx): { ref?: PdfRef; dict: PdfDict; page: Page }[]` (defined here; reused by Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConvertToPdfA — annotations/forms', () => {
  const after = (b: Uint8Array, lvl: any = '2b') => {
    const d = open(b); d.ConvertToPdfA(lvl); return d.ValidatePdfA(lvl).Errors.map((e) => e.rule);
  };
  it('fixes annotation flags', () => {
    expect(after(buildPdfaPdf({ hiddenAnnot: true }))).not.toContain('AnnotationFlags');
  });
  it('clears NeedAppearances', () => {
    expect(after(buildPdfaPdf({ needAppearances: true }))).not.toContain('NeedAppearances');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the helper and passes**

Add to `src/pdfaconvert.ts`:

```ts
/** Every annotation dict across all pages. */
function eachAnnotation(ctx: Cctx): { ref?: PdfRef; dict: PdfDict; page: Page }[] {
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

/** Set Print, clear Hidden/NoView/Invisible; set /CA->1 at part 1. */
const annotationFlagsPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  for (const { ref, dict, page } of eachAnnotation(ctx)) {
    if (nameOf(ctx, dict, 'Subtype') === 'Popup') continue;
    const f = ctx.R(dict.get('F'));
    let flags = typeof f === 'number' ? f : 0;
    const fixed = (flags | 4) & ~(1 | 2 | 32); // set Print(4), clear Invisible(1)/Hidden(2)/NoView(32)
    if (fixed !== flags) {
      dict.set('F', fixed);
      actions.push({ rule: 'AnnotationFlags', action: 'Normalized annotation /F flags.', object: ref, page });
    }
    if (ctx.part === 1) {
      const ca = ctx.R(dict.get('CA'));
      if (typeof ca === 'number' && ca !== 1) {
        dict.set('CA', 1);
        actions.push({ rule: 'AnnotationOpacity', action: 'Set annotation /CA to 1.', object: ref, page });
      }
    }
  }
  return actions;
};

/** Generate field appearances and drop /NeedAppearances. */
const formsPass: Pass = (ctx) => {
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (!isDict(acro)) return [];
  ctx.doc.Form.GenerateAppearances(); // generates per-field /AP and deletes /NeedAppearances
  return [{ rule: 'NeedAppearances', action: 'Generated field appearances and cleared /NeedAppearances.' }];
};
```

Register `annotationFlagsPass, formsPass` after `outputIntentPass`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfaconvert.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(pdfa): annotation-flags and form-appearance conversion passes"
```

---

## Task 7: Cosmetic passes (blend mode, interpolate, image intent, symbolic encoding)

**Files:**
- Modify: `src/pdfaconvert.ts`
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Document.objectEntries()` (already added by the validator), `isStream`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConvertToPdfA — cosmetic', () => {
  const after = (b: Uint8Array, lvl: any = '2b') => {
    const d = open(b); d.ConvertToPdfA(lvl); return d.ValidatePdfA(lvl);
  };
  it('resets a non-standard blend mode', () => {
    expect(after(buildPdfaPdf({ nonStandardBlend: true })).Warnings.map((i) => i.rule)).not.toContain('BlendMode');
  });
  it('clears /Interpolate', () => {
    expect(after(buildPdfaPdf({ interpolateImage: true })).Warnings.map((i) => i.rule)).not.toContain('ImageInterpolate');
  });
  it('drops /Encoding from a symbolic TrueType', () => {
    expect(after(buildPdfaPdf({ symbolicWithEncoding: true })).Errors.map((i) => i.rule)).not.toContain('FontEncoding');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the passes**

Add to `src/pdfaconvert.ts` (add `isStream` to the existing `./types.js` import):

```ts
const STANDARD_BLEND = new Set([
  'Normal', 'Compatible', 'Multiply', 'Screen', 'Overlay', 'Darken', 'Lighten',
  'ColorDodge', 'ColorBurn', 'HardLight', 'SoftLight', 'Difference', 'Exclusion',
  'Hue', 'Saturation', 'Color', 'Luminosity',
]);
const STANDARD_INTENTS = new Set(['AbsoluteColorimetric', 'RelativeColorimetric', 'Saturation', 'Perceptual']);

/** Normalize ExtGState /BM, image /Interpolate, image /Intent, and symbolic TT /Encoding. */
const cosmeticPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  for (const [object, obj] of ctx.doc.objectEntries()) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!dict) continue;
    const type = nameOf(ctx, dict, 'Type');
    const subtype = nameOf(ctx, dict, 'Subtype');

    // ExtGState blend mode.
    if (type === 'ExtGState') {
      const bm = ctx.R(dict.get('BM'));
      const bmName = isName(bm) ? bm.name : isArray(bm) && isName(ctx.R(bm[0])) ? (ctx.R(bm[0]) as { name: string }).name : undefined;
      if (bmName && !STANDARD_BLEND.has(bmName)) {
        dict.set('BM', name('Normal'));
        actions.push({ rule: 'BlendMode', action: `Reset blend mode '${bmName}' to /Normal.`, object });
      }
    }

    // Image XObject /Interpolate and /Intent.
    if (subtype === 'Image') {
      if (ctx.R(dict.get('Interpolate')) === true) {
        dict.set('Interpolate', false);
        actions.push({ rule: 'ImageInterpolate', action: 'Set image /Interpolate to false.', object });
      }
      const intent = nameOf(ctx, dict, 'Intent');
      if (intent && !STANDARD_INTENTS.has(intent)) {
        dict.set('Intent', name('RelativeColorimetric'));
        actions.push({ rule: 'RenderingIntent', action: `Reset image /Intent '${intent}'.`, object });
      }
    }

    // Symbolic TrueType /Encoding.
    if (type === 'Font' && subtype === 'TrueType' && dict.get('Encoding') !== undefined) {
      const fd = ctx.R(dict.get('FontDescriptor'));
      const flags = isDict(fd) ? ctx.R(fd.get('Flags')) : undefined;
      const symbolic = typeof flags === 'number' && (flags & 4) !== 0 && (flags & 32) === 0;
      if (symbolic) {
        dict.delete('Encoding');
        actions.push({ rule: 'FontEncoding', action: 'Removed /Encoding from a symbolic TrueType font.', object });
      }
    }
  }
  return actions;
};
```

Register `cosmeticPass` after `formsPass`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfaconvert.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(pdfa): cosmetic conversion passes (blend/interpolate/intent/encoding)"
```

---

## Task 8: Removal passes + `opts.preserve`

**Files:**
- Modify: `src/pdfaconvert.ts`
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `eachAnnotation` (Task 6), `ctx.preserve`, `Document.objectEntries`, catalog `/Names`/`/AcroForm`/`/OCProperties`/`/OpenAction`/`/AA`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConvertToPdfA — removals', () => {
  const conv = (b: Uint8Array, lvl: any, opts?: any) => {
    const d = open(b); const r = d.ConvertToPdfA(lvl, opts);
    return { applied: r.applied.map((a) => a.rule), errors: d.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };
  it('removes JavaScript actions', () => {
    const r = conv(buildPdfaPdf({ jsAction: true }, 2), '2b');
    expect(r.applied).toContain('Actions');
    expect(r.errors).not.toContain('Actions');
  });
  it('removes a multimedia annotation', () => {
    expect(conv(buildPdfaPdf({ movieAnnot: true }, 2), '2b').errors).not.toContain('AnnotationSubtype');
  });
  it('removes XFA', () => {
    expect(conv(buildPdfaPdf({ xfa: true }, 2), '2b').errors).not.toContain('XFA');
  });
  it('removes optional content at part 1', () => {
    expect(conv(buildPdfaPdf({ optionalContent: true }, 1), '1b').errors).not.toContain('OptionalContent');
  });
  it('preserve keeps the construct and reports it unresolved', () => {
    const r = conv(buildPdfaPdf({ xfa: true }, 2), '2b', { preserve: ['xfa'] });
    expect(r.applied).not.toContain('XFA');
    expect(r.errors).toContain('XFA');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the removal passes**

Add to `src/pdfaconvert.ts`:

```ts
const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);
const PROHIBITED_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript', 'SetState', 'Hide', 'SetOCGState',
]);

/** True when the named action dict is prohibited. */
function isProhibitedAction(ctx: Cctx, actionObj: PdfObject | undefined): boolean {
  const a = ctx.R(actionObj);
  return isDict(a) && PROHIBITED_ACTIONS.has(nameOf(ctx, a, 'S') ?? '');
}

/** Remove JavaScript and other prohibited actions (and /AA at part 1). */
const actionsPass: Pass = (ctx) => {
  if (ctx.preserve.has('javascript')) return [];
  const actions: ConvertAction[] = [];
  if (isProhibitedAction(ctx, ctx.catalog.get('OpenAction'))) {
    ctx.catalog.delete('OpenAction');
    actions.push({ rule: 'Actions', action: 'Removed prohibited /OpenAction.' });
  }
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('JavaScript') !== undefined) {
    names.delete('JavaScript');
    actions.push({ rule: 'Actions', action: 'Removed /Names /JavaScript tree.' });
  }
  const stripAA = (dict: PdfDict): void => {
    const aa = ctx.R(dict.get('AA'));
    if (!isDict(aa)) return;
    if (ctx.part === 1) { dict.delete('AA'); actions.push({ rule: 'AdditionalActions', action: 'Removed /AA.' }); return; }
    for (const k of [...aa.keys()]) {
      if (isProhibitedAction(ctx, aa.get(k))) { aa.delete(k); actions.push({ rule: 'AdditionalActions', action: `Removed prohibited /AA /${k}.` }); }
    }
    if (aa.size === 0) dict.delete('AA');
  };
  stripAA(ctx.catalog);
  for (const page of ctx.doc.Pages) stripAA(page.Dict);
  for (const { ref, dict } of eachAnnotation(ctx)) {
    if (isProhibitedAction(ctx, dict.get('A'))) {
      dict.delete('A');
      actions.push({ rule: 'Actions', action: 'Removed prohibited annotation /A.', object: ref });
    }
    stripAA(dict);
  }
  return actions;
};

/** Remove an annotation ref from every page's /Annots array. */
function removeAnnot(ctx: Cctx, target: PdfDict): void {
  for (const page of ctx.doc.Pages) {
    const arr = ctx.R(page.Dict.get('Annots'));
    if (!isArray(arr)) continue;
    const idx = arr.findIndex((a) => ctx.R(a) === target);
    if (idx >= 0) { arr.splice(idx, 1); if (arr.length === 0) page.Dict.delete('Annots'); }
  }
}

/** Remove multimedia annotations. */
const multimediaPass: Pass = (ctx) => {
  if (ctx.preserve.has('multimedia')) return [];
  const actions: ConvertAction[] = [];
  for (const { ref, dict, page } of eachAnnotation(ctx)) {
    const st = nameOf(ctx, dict, 'Subtype');
    if (st && PROHIBITED_ANNOTS.has(st)) {
      removeAnnot(ctx, dict);
      actions.push({ rule: 'AnnotationSubtype', action: `Removed /${st} annotation.`, object: ref, page });
    }
  }
  return actions;
};

/** Remove dynamic XFA. */
const xfaPass: Pass = (ctx) => {
  if (ctx.preserve.has('xfa')) return [];
  const acro = ctx.R(ctx.catalog.get('AcroForm'));
  if (isDict(acro) && acro.get('XFA') !== undefined) {
    acro.delete('XFA');
    return [{ rule: 'XFA', action: 'Removed /AcroForm /XFA.' }];
  }
  return [];
};

/** Remove optional content at part 1. */
const optionalContentPass: Pass = (ctx) => {
  if (ctx.part !== 1 || ctx.preserve.has('optionalContent')) return [];
  if (ctx.catalog.get('OCProperties') === undefined) return [];
  ctx.catalog.delete('OCProperties');
  return [{ rule: 'OptionalContent', action: 'Removed catalog /OCProperties.' }];
};

/** Embedded files: remove at part 1; set /AFRelationship at parts 2/3. */
const embeddedFilesPass: Pass = (ctx) => {
  if (ctx.preserve.has('embeddedFiles')) return [];
  const actions: ConvertAction[] = [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (ctx.part === 1) {
    if (isDict(names) && names.get('EmbeddedFiles') !== undefined) {
      names.delete('EmbeddedFiles');
      actions.push({ rule: 'EmbeddedFiles', action: 'Removed /Names /EmbeddedFiles (part 1).' });
    }
    for (const { ref, dict } of eachAnnotation(ctx)) {
      if (nameOf(ctx, dict, 'Subtype') === 'FileAttachment') {
        removeAnnot(ctx, dict);
        actions.push({ rule: 'EmbeddedFiles', action: 'Removed /FileAttachment annotation (part 1).', object: ref });
      }
    }
    return actions;
  }
  // parts 2/3: ensure each file spec carries /AFRelationship.
  for (const [object, obj] of ctx.doc.objectEntries()) {
    if (!isDict(obj)) continue;
    if (nameOf(ctx, obj, 'Type') === 'Filespec' && obj.get('EF') !== undefined && obj.get('AFRelationship') === undefined) {
      obj.set('AFRelationship', name('Unspecified'));
      actions.push({ rule: 'EmbeddedFiles', action: 'Set /AFRelationship on a file spec.', object });
    }
  }
  return actions;
};

/** Remove PostScript XObjects from resources. */
const postScriptPass: Pass = (ctx) => {
  if (ctx.preserve.has('postScript')) return [];
  const actions: ConvertAction[] = [];
  for (const [, obj] of ctx.doc.objectEntries()) {
    const res = isStream(obj) ? ctx.R(obj.dict.get('Resources')) : isDict(obj) ? ctx.R(obj.get('Resources')) : undefined;
    const xobjs = isDict(res) ? ctx.R(res.get('XObject')) : undefined;
    if (!isDict(xobjs)) continue;
    for (const k of [...xobjs.keys()]) {
      const xo = ctx.R(xobjs.get(k));
      if (isStream(xo) && nameOf(ctx, xo.dict, 'Subtype') === 'PS') {
        xobjs.delete(k);
        actions.push({ rule: 'PostScriptXObject', action: `Removed PostScript XObject /${k}.` });
      }
    }
  }
  return actions;
};
```

Register, after `cosmeticPass`:

```ts
  actionsPass, multimediaPass, xfaPass, optionalContentPass, embeddedFilesPass, postScriptPass,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfaconvert.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(pdfa): removal passes (actions/multimedia/xfa/oc/embedded/ps) + preserve"
```

---

## Task 9: `/ToUnicode` synthesis pass (level u)

**Files:**
- Modify: `src/pdfaconvert.ts`
- Modify: `test/helpers/build-pdfa-pdf.ts` (add a `/Differences` fixture toggle)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `baseEncodingByName`, `glyphToUnicode` from `./encoding.js`; the validator's font enumeration is internal, so this pass enumerates simple fonts itself via `objectEntries`/page resources.

- [ ] **Step 1: Add a `/Differences`-encoding fixture toggle**

In `test/helpers/build-pdfa-pdf.ts`, add to `PdfaOptions`:

```ts
  diffEncodingNoToUnicode?: boolean; // simple font: /Encoding dict with /Differences, no BaseEncoding, no /ToUnicode
```

In the simple-font branch (the `else` of `if (opts.type0)`), before assembling `fontParts`, special-case it:

```ts
    if (opts.diffEncodingNoToUnicode) {
      objects[5] = '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Sub /FirstChar 65 /LastChar 65 /Widths [500] '
        + '/FontDescriptor 21 0 R /Encoding << /Type /Encoding /Differences [65 /Aacute] >> >>';
      objects[21] = '<< /Type /FontDescriptor /FontName /AAAAAA+Sub /Flags 32 /FontFile2 6 0 R >>';
    } else {
      // ... existing simple-font assembly ...
    }
```

(Keep the existing simple-font body inside the new `else`. The validator's `ToUnicode` rule flags this font at level `u` because the `/Encoding` dict has no standard `BaseEncoding`.)

- [ ] **Step 2: Write the failing test**

```ts
describe('ConvertToPdfA — ToUnicode (level u)', () => {
  it('synthesizes /ToUnicode for a /Differences font and clears ToUnicode at 2u', () => {
    const doc = open(buildPdfaPdf({ diffEncodingNoToUnicode: true }, 2));
    const report = doc.ConvertToPdfA('2u');
    expect(report.applied.map((a) => a.rule)).toContain('ToUnicode');
    expect(doc.ValidatePdfA('2u').Errors.map((e) => e.rule)).not.toContain('ToUnicode');
  });
  it('does nothing for ToUnicode at level b', () => {
    const doc = open(buildPdfaPdf({ diffEncodingNoToUnicode: true }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).not.toContain('ToUnicode');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the pass**

Add the import to `src/pdfaconvert.ts`:

```ts
import { baseEncodingByName, glyphToUnicode } from './encoding.js';
```

Add the pass and its helpers:

```ts
/** Build a code->Unicode table for a simple font dict (base encoding + /Differences). */
function codeToUnicode(ctx: Cctx, fontDict: PdfDict): (string | undefined)[] {
  const enc = ctx.R(fontDict.get('Encoding'));
  let table: (string | undefined)[];
  if (isName(enc)) table = baseEncodingByName(enc.name).slice();
  else if (isDict(enc)) {
    const base = ctx.R(enc.get('BaseEncoding'));
    table = baseEncodingByName(isName(base) ? base.name : undefined).slice();
    const diffs = ctx.R(enc.get('Differences'));
    if (isArray(diffs)) {
      let code = 0;
      for (const it of diffs) {
        if (typeof it === 'number') code = it;
        else if (isName(it)) { table[code & 0xff] = glyphToUnicode(it.name) ?? table[code & 0xff]; code++; }
      }
    }
  } else {
    table = baseEncodingByName(undefined).slice();
  }
  return table;
}

/** Build a /ToUnicode CMap stream body for the given code->Unicode table. */
function toUnicodeCMap(table: (string | undefined)[]): string {
  const hex = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join('');
  const entries: string[] = [];
  for (let code = 0; code < 256; code++) {
    const u = table[code];
    if (u && u.length) entries.push(`<${code.toString(16).padStart(2, '0')}> <${hex(u)}>`);
  }
  const body = entries.map((e) => e).join('\n');
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n${entries.length} beginbfchar\n${body}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

/** Synthesize /ToUnicode for simple fonts that lack it (level u/a only). */
const toUnicodePass: Pass = (ctx) => {
  if (ctx.level === 'b') return [];
  const actions: ConvertAction[] = [];
  const seen = new Set<PdfDict>();
  const handle = (fontDict: PdfDict, fontRef?: PdfRef): void => {
    if (seen.has(fontDict)) return;
    seen.add(fontDict);
    const sub = nameOf(ctx, fontDict, 'Subtype');
    if (sub === 'Type0' || sub === 'Type3') return;       // Type0 needs a CMap; Type3 has none
    if (fontDict.get('ToUnicode') !== undefined) return;
    const table = codeToUnicode(ctx, fontDict);
    if (!table.some((u) => u && u.length)) return;          // nothing resolvable -> leave unresolved
    const body = new TextEncoder().encode(toUnicodeCMap(table));
    const streamDict: PdfDict = new Map<string, PdfObject>([['Length', body.length]]);
    const ref = ctx.doc.allocObject({ kind: 'stream', dict: streamDict, raw: body });
    fontDict.set('ToUnicode', ref);
    actions.push({ rule: 'ToUnicode', action: 'Synthesized /ToUnicode CMap.', object: fontRef });
  };
  // Enumerate simple fonts from page + Form XObject resources.
  const seenRes = new Set<PdfDict>();
  const visit = (resObj: PdfObject | undefined): void => {
    const res = ctx.R(resObj);
    if (!isDict(res) || seenRes.has(res)) return;
    seenRes.add(res);
    const fonts = ctx.R(res.get('Font'));
    if (isDict(fonts)) for (const v of fonts.values()) { const d = ctx.R(v); if (isDict(d)) handle(d, isRef(v) ? v : undefined); }
    const xobjs = ctx.R(res.get('XObject'));
    if (isDict(xobjs)) for (const v of xobjs.values()) { const x = ctx.R(v); if (x && (x as { kind?: string }).kind === 'stream') visit((x as { dict: PdfDict }).dict.get('Resources')); }
  };
  for (const page of ctx.doc.Pages) visit(page.Resources);
  return actions;
};
```

Register `toUnicodePass` after `postScriptPass`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/pdfaconvert.test.ts` → PASS
Run: `npm run typecheck` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/pdfaconvert.ts test/helpers/build-pdfa-pdf.ts test/pdfaconvert.test.ts
git commit -m "feat(pdfa): /ToUnicode synthesis pass for level u"
```

---

## Task 10: Report-only + full round-trip + docs + verification

**Files:**
- Modify: `test/pdfaconvert.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the report-only and round-trip tests**

```ts
describe('ConvertToPdfA — report-only + round-trip', () => {
  it('reports a non-embedded font as unresolved', () => {
    const doc = open(buildPdfaPdf({ fontEmbedded: false }, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).toContain('FontEmbedded');
    expect(report.passed).toBe(false);
  });
  it('converts a messy-but-achievable doc to a passing 2b on save/open', () => {
    const messy = buildPdfaPdf({
      omitOutputIntent: true, deviceColorContent: true, jsAction: true,
      needAppearances: true, movieAnnot: true, omitId: true, omitMetadata: true,
    }, 2);
    const doc = open(messy);
    const report = doc.ConvertToPdfA('2b');
    expect(report.passed).toBe(true);
    const reopened = open(doc.Save());
    expect(reopened.ValidatePdfA('2b').Passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: PASS. If the round-trip fails, inspect `report.unresolved` for the offending rule and fix the responsible pass (do not weaken the assertion).

- [ ] **Step 3: README Features bullet**

In `README.md`, after the PDF/A validation Features bullet, add:

```markdown
- **PDF/A conversion** — `doc.ConvertToPdfA(level, opts?)` remediates a document toward PDF/A levels `b`/`u` (parts 1–3) and returns a `ConversionReport` (`applied` / `unresolved` / `passed`). It writes identification XMP (`pdfaid`) mirrored with `/Info`, adds an sRGB `/OutputIntent` (override via `opts.iccProfile`), normalizes annotation flags/opacity and generates field appearances (clearing `/NeedAppearances`), resets non-standard blend modes / `/Interpolate` / image rendering intents, drops `/Encoding` from symbolic TrueType, and (level `u`) synthesizes `/ToUnicode` for simple fonts. Prohibited constructs that can only be removed — JavaScript/actions, multimedia annotations, `/XFA`, optional content (part 1), embedded files (part 1; parts 2/3 get `/AFRelationship`), PostScript XObjects — are removed by default and listed in `applied`; pass `opts.preserve` to keep specific categories (they then surface in `unresolved`). After the passes, conversion re-runs `ValidatePdfA(level)`, so `unresolved`/`passed` exactly mirror the validator.
```

- [ ] **Step 4: README Limitations bullet**

After the PDF/A validation Limitations bullet, add:

```markdown
- **PDF/A conversion is best-effort and never fabricates assets** — `doc.ConvertToPdfA` fixes what is deterministically fixable and reports the rest as `unresolved`: it cannot embed a font whose program is absent (`FontEmbedded`), flatten part-1 transparency (`Transparency` — target part 2/3 instead), transcode LZW/JPX/JBIG2 streams, resolve external streams or reference XObjects, or rewrite a non-standard rendering-intent `ri` operator inside a content stream. Level `a` (auto-tagging) is out of scope. Because conversion re-validates, `passed` is true only when the validator agrees.
```

- [ ] **Step 5: Full verification**

Run: `npm run typecheck` → no errors.
Run: `npm test` → all tests green.
Run: `npm run build` → succeeds.

- [ ] **Step 6: Commit, close issue, push**

```bash
git add README.md test/pdfaconvert.test.ts
git commit -m "test(pdfa): report-only + round-trip; docs: PDF/A conversion"
bd close <issue-id>   # the PDF/A conversion issue
git pull --rebase
git push
git status            # MUST show up to date with origin
```

---

## Self-Review

**Spec coverage:** API shape (Task 4); identification/version/fileId (Task 4); output intent (Task 5); annotation flags/opacity + forms + appearances (Task 6); cosmetic blend/interpolate/intent/encoding (Task 7); removals + preserve (Task 8); ToUnicode level-u synthesis (Task 9); report-only set + round-trip + docs (Task 10); enabling changes — xmp pdfaid (Task 1), bundled sRGB (Task 2), header version (Task 3). The honesty invariant is structural: `convertToPdfA` returns `validatePdfA(level).Errors` as `unresolved` (Task 4).

**Deviations from spec (documented):** RenderingIntent remediation covers image `/Intent` only; content-stream `ri` is report-only (noted in Scope refinements and Limitations). Annotation-appearance generation is folded into the forms pass (`Form.GenerateAppearances`) for fields; non-field annotation appearance generation is best-effort and any annotation the appearance layer cannot build remains an `AnnotationAppearance` unresolved issue — consistent with the spec's "report any it can't build."

**Placeholder scan:** No TBD/TODO. The sRGB profile (Task 2) is an asset-acquisition step with exact commands and a concrete fallback, not a code placeholder. `markModified()` (`document.ts:413`) and `Form.GenerateAppearances()` (`form.ts:273`) are confirmed against the codebase.

**Type consistency:** `Cctx`, `Pass`, `ConvertAction`, `ConvertCategory`, `ConvertOptions`, `ConversionReport`, `nameOf`, `eachAnnotation`, `codeToUnicode`, `toUnicodeCMap`, `isProhibitedAction`, `removeAnnot` are each defined once and reused with consistent signatures. `PASSES` grows cumulatively; the final registry contains: identification, version, fileId, outputIntent, annotationFlags, forms, cosmetic, actions, multimedia, xfa, optionalContent, embeddedFiles, postScript, toUnicode. `ConversionReport.unresolved` is `ValidationIssue[]` throughout; `applied` is `ConvertAction[]`.
