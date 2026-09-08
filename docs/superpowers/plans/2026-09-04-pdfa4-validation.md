# PDF/A-4 Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `'4'`, `'4e'` and `'4f'` to `doc.ValidatePdfA`, implementing the ISO 19005-4:2020 rule set — including the four places where PDF/A-4 makes a rule we currently enforce go *silent*.

**Architecture:** Part 4 becomes a peer conformance inside the single `RULES` table in `src/pdfavalidate.ts`. Each existing rule states its own part-4 stance with the `if (ctx.part !== N) return []` guard idiom already used by `optionalContentRule`, `transparencyRule` and `annotationOpacityRule`. Seventeen new rules join the same array, each gated on `ctx.part === 4`. No new module, no second rule table, no change to the shared scan context beyond what is stated.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-04-pdfa4-validation-design.md`

## Global Constraints

- **Import specifiers carry the `.js` extension** — `import { x } from './types.js'`, never `'./types'`.
- **No new npm runtime dependencies.** `node:zlib`, `node:crypto`, `node:fs` only.
- **The anchor is veraPDF's published profile**, `veraPDF/veraPDF-validation-profiles`, `integration` branch, `PDF_A/PDFA-4.xml` / `PDFA-4E.xml` / `PDFA-4F.xml`, fetched 2026-09-04. Every new rule's `clause` field cites an ISO 19005-4 clause taken from it.
- **Parts 1–3 must not move.** `test/pdfavalidate.test.ts` and `test/pdfaconvert.test.ts` must stay green **unedited** through every task. A red test there is information, not a chore — stop and report.
- **`ValidationIssue.rule` strings are stable ids.** Do not rename an existing one.
- **Severity vocabulary:** `'error'` for a *shall* clause, `'warning'` for advisory or unverifiable.
- **Every new rule must be mutation-checked** at the end of its task: break the rule's condition, confirm its test reddens, restore. A rule that reddens nothing gets recorded as uncovered in a comment, not quietly kept.
- **Run before any commit:** `npm run typecheck` and `npm test`.

---

### Task 1: Widen the conformance types and refuse part 4 in the converter

**Files:**
- Modify: `src/pdfavalidate.ts:21-31` (the `PdfALevel`, `Conformance`, `parseLevel`, `Ctx` block)
- Modify: `src/pdfaconvert.ts:36-53` (`convertToPdfA`)
- Test: `test/pdfa4-validate.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `PdfALevel` widened to include `'4' | '4e' | '4f'`; `parseLevel(level: PdfALevel): { part: 1|2|3|4; level: 'b'|'u'|'a'|''|'e'|'f' }`; `Ctx.part: 1|2|3|4` and `Ctx.level: 'b'|'u'|'a'|''|'e'|'f'`. Every later task reads `ctx.part` and `ctx.level` with these types.

- [ ] **Step 1: Write the failing test**

Create `test/pdfa4-validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document, UnsupportedFeatureError } from '../src/index.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

describe('ValidatePdfA — part 4 dispatch', () => {
  it('accepts the three part-4 levels and returns a report', () => {
    const doc = Document.Open(buildPdfaPdf({}, 2));
    for (const level of ['4', '4e', '4f'] as const) {
      const report = doc.ValidatePdfA(level);
      expect(Array.isArray(report.Issues)).toBe(true);
    }
  });

  it('never chains the PDF/UA rules at part 4 (there is no 4a level)', () => {
    const doc = Document.Open(buildPdfaPdf({}, 2));
    const rules = doc.ValidatePdfA('4').Issues.map((i) => i.rule);
    expect(rules.some((r) => r.startsWith('UA:'))).toBe(false);
  });

  it('refuses to convert to part 4 rather than running part-2 remediation', () => {
    const doc = Document.Open(buildPdfaPdf({}, 2));
    expect(() => doc.ConvertToPdfA('4')).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts`
Expected: FAIL — TypeScript rejects `'4'` as not assignable to `PdfALevel`, and `ConvertToPdfA` does not throw.

- [ ] **Step 3: Widen the types in `src/pdfavalidate.ts`**

Replace the block at `src/pdfavalidate.ts:21-31`:

```ts
/** Conformance target: part (1/2/3/4) + level. Parts 1–3 take b/u/a; PDF/A-4
 *  takes '' (the base conformance), 'e' (engineering) or 'f' (embedded files).
 *
 *  Note there is no '4a'. ISO 19005-4 has no clause 6.8 and no accessibility
 *  level — tagging is declared through PDF/UA instead — so the level is
 *  *unrepresentable* rather than merely unsupported, and validatePdfA's
 *  `lvl === 'a'` PDF/UA chain provably cannot fire for part 4. */
export type PdfALevel = '1b' | '1a' | '2b' | '2u' | '2a' | '3b' | '3u' | '3a'
  | '4' | '4e' | '4f';

interface Conformance { part: 1 | 2 | 3 | 4; level: 'b' | 'u' | 'a' | '' | 'e' | 'f'; }

/** Split a level string into its part number and conformance letter. PDF/A-4's
 *  base level is the bare '4', which has no second character. */
export function parseLevel(level: PdfALevel): Conformance {
  return {
    part: Number(level[0]) as 1 | 2 | 3 | 4,
    level: (level[1] ?? '') as Conformance['level'],
  };
}

/** PDF/A run context: the shared scan context plus the conformance target. */
export interface Ctx extends BaseCtx {
  part: 1 | 2 | 3 | 4;
  level: 'b' | 'u' | 'a' | '' | 'e' | 'f';
}
```

- [ ] **Step 4: Refuse part 4 in `src/pdfaconvert.ts`**

Add to the import block at the top of `src/pdfaconvert.ts`:

```ts
import { UnsupportedFeatureError } from './errors.js';
```

Then in `convertToPdfA`, immediately after `const { part, level: lvl } = parseLevel(level);`, insert:

```ts
  // 72nc.2 owns PDF/A-4 remediation. Falling through would run part-2-shaped
  // passes, which write pdfaid:conformance — a key PDF/A-4 forbids — producing
  // a file that fails the validator this build ships.
  if (part === 4) {
    throw new UnsupportedFeatureError('PDF/A-4 conversion is not supported; use ValidatePdfA to report conformance.');
  }
```

`Cctx.part` stays `1 | 2 | 3` and `Cctx.level` stays `'b' | 'u' | 'a'`. The guard narrows `part` and `lvl` before the context is built, so no cast is needed — if tsc still complains, narrow with `part as 1 | 2 | 3` at the `Cctx` construction site and leave a comment pointing at the guard.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS, all three files.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pdfavalidate.ts src/pdfaconvert.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): widen PdfALevel to the three PDF/A-4 conformances

parseLevel needs one change - level[1] ?? '' - because '4' has no second
character. Every existing ctx.level === 'a' / === 'b' test then stays
correct by construction rather than by review.

There is no '4a': ISO 19005-4 has no clause 6.8 and no accessibility
level, so validatePdfA's PDF/UA chain provably cannot fire at part 4.

convertToPdfA refuses part 4 rather than falling through - part-2-shaped
remediation writes pdfaid:conformance, which PDF/A-4 forbids.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Part-4 fixture mode, PDF 2.0 version rule, and identification — a clean document passes

**Files:**
- Modify: `test/helpers/build-pdfa-pdf.ts` (options, signature, `xmpPacket`, `/Info` default, catalog)
- Modify: `src/pdfavalidate.ts` (`versionRule`, `pdfaIdValue`/`pdfaIdRule`)
- Test: `test/pdfa4-validate.test.ts`

**Interfaces:**
- Consumes: `Ctx.part`, `Ctx.level` from Task 1.
- Produces: `buildPdfaPdf(opts, 4)` emitting a PDF/A-4-clean document; new `PdfaOptions` fields `pdfaRev?: string | null`, `omitConformance?: boolean`, `pieceInfo?: boolean`, `infoModDateOnly?: boolean`. Later tasks build every part-4 fixture from this.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfa4-validate.test.ts`:

```ts
describe('ValidatePdfA — part 4 baseline', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('a clean PDF/A-4 document passes with no errors', () => {
    const report = Document.Open(buildPdfaPdf({}, 4)).ValidatePdfA('4');
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('flags a PDF 1.7 header at part 4 — PDF/A-4 requires 2.n, not a ceiling', () => {
    expect(errs(buildPdfaPdf({ headerVersion: '1.7' }, 4))).toContain('Version');
  });
  it('flags a catalog /Version below 2.0 at part 4', () => {
    expect(errs(buildPdfaPdf({ catalogVersion: '1.7' }, 4))).toContain('Version');
  });
  it('accepts a 2.0 header at part 4', () => {
    expect(errs(buildPdfaPdf({ headerVersion: '2.0' }, 4))).not.toContain('Version');
  });

  it('flags a present pdfaid:conformance at the base level', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'B' }, 4))).toContain('PdfaIdentification');
  });
  it('requires pdfaid:conformance E at 4e', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'E' }, 4), '4e')).not.toContain('PdfaIdentification');
    expect(errs(buildPdfaPdf({}, 4), '4e')).toContain('PdfaIdentification');
  });
  it('requires pdfaid:conformance F at 4f', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'F' }, 4), '4f')).not.toContain('PdfaIdentification');
  });
  it('flags a missing pdfaid:rev at part 4', () => {
    expect(errs(buildPdfaPdf({ pdfaRev: null }, 4))).toContain('PdfaIdentification');
  });
  it('flags a wrong pdfaid:rev at part 4', () => {
    expect(errs(buildPdfaPdf({ pdfaRev: '2005' }, 4))).toContain('PdfaIdentification');
  });
  it('does not require pdfaid:rev at parts 1-3', () => {
    expect(errs(buildPdfaPdf({}, 2), '2b')).not.toContain('PdfaIdentification');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts`
Expected: FAIL — `buildPdfaPdf(..., 4)` rejects `4` as a part, and no rev/conformance handling exists.

- [ ] **Step 3: Extend the fixture builder**

In `test/helpers/build-pdfa-pdf.ts`, add these fields to `PdfaOptions` under the `// metadata` comment:

```ts
  pdfaRev?: string | null;    // pdfaid:rev value; null omits it (part 4 defaults to '2020')
  omitConformance?: boolean;  // force pdfaid:conformance absent regardless of part
  pieceInfo?: boolean;        // catalog /PieceInfo (part 4: what makes /Info legal)
  infoModDateOnly?: boolean;  // /Info holds only /ModDate instead of /Title
```

Change the signature and the four derived defaults:

```ts
export function buildPdfaPdf(opts: PdfaOptions = {}, part: 1 | 2 | 3 | 4 = 2): Uint8Array {
  const header = opts.headerVersion ?? (part === 4 ? '2.0' : '1.7');
  // PDF/A-4 near-bans /Info, so the clean part-4 fixture has none.
  const defaultInfo = part === 4 ? null : 'Clean';
  const infoTitle = opts.infoTitle === undefined ? defaultInfo : opts.infoTitle;
  const xmpTitle = opts.xmpTitle ?? 'Clean';
  const pdfaPart = opts.pdfaPart ?? String(part);
  // Part 4's base conformance is ABSENT; 4e/4f pass 'E'/'F' explicitly.
  const pdfaConf = opts.omitConformance ? null
    : opts.pdfaConformance ?? (part === 4 ? null : 'B');
  const pdfaRev = opts.pdfaRev === undefined ? (part === 4 ? '2020' : null) : opts.pdfaRev;
```

Add `/PieceInfo` to the catalog — insert immediately after the `if (opts.optionalContent)` line:

```ts
  if (opts.pieceInfo) catParts.push('/PieceInfo << /Test << /LastModified (D:20260904000000Z) /Private 0 >> >>');
```

Change the metadata call to pass the rev:

```ts
  const xmp = xmpPacket(pdfaPart, pdfaConf, pdfaRev, xmpTitle);
```

Change the `/Info` object so it can hold only `/ModDate`:

```ts
  const infoNum = 23;
  if (infoTitle !== null) {
    objects[infoNum] = opts.infoModDateOnly
      ? '<< /ModDate (D:20260904000000Z) >>'
      : `<< /Title (${infoTitle}) >>`;
  }
```

Note `infoModDateOnly` only takes effect when `/Info` exists at all, so a part-4 caller wanting it must also pass `infoTitle: 'x'` to switch the dictionary on. Finally, replace `xmpPacket`:

```ts
function xmpPacket(
  part: string, conformance: string | null, rev: string | null, title: string,
): string {
  const idAttrs = [`pdfaid:part="${part}"`];
  if (conformance !== null) idAttrs.push(`pdfaid:conformance="${conformance}"`);
  if (rev !== null) idAttrs.push(`pdfaid:rev="${rev}"`);
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n`
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" `
    + `${idAttrs.join(' ')}/>`
    + `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">`
    + `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>`
    + `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
}
```

- [ ] **Step 4: Make `versionRule` a PDF 2.0 exact-major rule at part 4**

Replace `versionRule` in `src/pdfavalidate.ts`:

```ts
const versionRule: Rule = (ctx) => {
  const header = ctx.doc.headerVersion();
  const cat = nameOf(ctx, ctx.catalog, 'Version');
  if (ctx.part === 4) {
    // ISO 19005-4 6.1.2-1 / 6.1.12-1: not a ceiling but an exact major —
    // both the header and a stated catalog /Version must read 2.n, so a
    // perfectly good PDF 1.7 file is simply not PDF/A-4.
    const bad = (v: string | undefined): boolean => v !== undefined && !/^2\.\d+$/.test(v);
    if (bad(header) || bad(cat)) {
      return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-4 §6.1.2',
        message: `PDF/A-4 requires PDF 2.n; found header '${header ?? '(absent)'}'${cat ? `, catalog /Version '${cat}'` : ''}.` }];
    }
    if (header === undefined) {
      return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-4 §6.1.2',
        message: 'PDF/A-4 requires a PDF 2.n header; none was found.' }];
    }
    return [];
  }
  const ceiling = ctx.part === 1 ? 1.4 : 1.7;
  const over = (v: string | undefined): boolean => v !== undefined && Number(v) > ceiling + 1e-9;
  if (over(header) || over(cat)) {
    return [{ rule: 'Version', severity: 'error', clause: 'ISO 19005-1 §6.1.2',
      message: `PDF version exceeds the part ${ctx.part} ceiling (${ceiling}).` }];
  }
  return [];
};
```

- [ ] **Step 5: Teach `pdfaIdRule` the part-4 identification**

Widen `pdfaIdValue`'s property union and replace `pdfaIdRule` in `src/pdfavalidate.ts`:

```ts
function pdfaIdValue(xmp: string, prop: 'part' | 'conformance' | 'rev'): string | undefined {
```

```ts
/** The pdfaid:conformance a target requires: undefined means it must be ABSENT
 *  (PDF/A-4's base conformance), otherwise the expected upper-case letter. */
function expectedConformance(ctx: Ctx): string | undefined {
  if (ctx.part !== 4) return ctx.level.toUpperCase();
  return ctx.level === '' ? undefined : ctx.level.toUpperCase();
}

const pdfaIdRule: Rule = (ctx) => {
  const xmp = xmpText(ctx);
  if (!xmp) return []; // metadataRule already reports the absence
  const part = pdfaIdValue(xmp, 'part');
  const conf = pdfaIdValue(xmp, 'conformance');
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.7.3' : 'ISO 19005-1 §6.7.11';
  const issues: ValidationIssue[] = [];
  const mk = (message: string): void => {
    issues.push({ rule: 'PdfaIdentification', severity: 'error', clause, message });
  };
  if (part !== String(ctx.part)) {
    mk(`XMP pdfaid:part is '${part ?? '(absent)'}', expected '${ctx.part}'.`);
  }
  const want = expectedConformance(ctx);
  if (want === undefined) {
    // ISO 19005-4 6.7.3-3: the base conformance is spelled by ABSENCE.
    if (conf !== undefined) {
      mk(`XMP pdfaid:conformance is '${conf}', but PDF/A-4 requires it to be absent.`);
    }
  } else if ((conf ?? '').toLowerCase() !== want.toLowerCase()) {
    mk(`XMP pdfaid:conformance is '${conf ?? '(absent)'}', expected '${want}'.`);
  }
  if (ctx.part === 4) {
    // ISO 19005-4 6.7.3-5. Parts 1–3 have no rev property at all.
    const rev = pdfaIdValue(xmp, 'rev');
    if (rev !== '2020') mk(`XMP pdfaid:rev is '${rev ?? '(absent)'}', expected '2020'.`);
  }
  return issues;
};
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS. If the clean part-4 baseline reports anything other than nothing, print `report.Errors` and fix the *fixture* first — no rule beyond version and identification should fire on it.

- [ ] **Step 7: Mutation-check both rules**

Temporarily change `/^2\.\d+$/` to `/^\d+\.\d+$/` — the two `Version` cases must redden. Restore. Temporarily drop the `rev !== '2020'` check — the two rev cases must redden. Restore. Temporarily make `want === undefined` fall through to the equality branch — the base-conformance case must redden. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): PDF 2.0 version and PDF/A-4 identification

At part 4 the version rule stops being a ceiling and becomes an exact
major: header and catalog /Version must both read 2.n, so a valid PDF 1.7
file is simply not PDF/A-4.

Identification gains pdfaid:rev = 2020, and the base conformance is
spelled by ABSENCE - '4' requires no pdfaid:conformance at all, where 4e
and 4f require E and F. A clean part-4 fixture now validates clean.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The four inversions — rules that must go silent at part 4

**Files:**
- Modify: `src/pdfavalidate.ts` (`toUnicodeRule`, `fontCidSetRule`, `xmpInfoConsistencyRule`, `actionsRule`)
- Test: `test/pdfa4-validate.test.ts`

**Interfaces:**
- Consumes: Task 1's `Ctx`, Task 2's fixture mode.
- Produces: nothing new; four rules gain a part-4 early return.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfa4-validate.test.ts`. **Each case is a cross-part pair** — the same fixture must report at parts 1–3 and stay silent at part 4. A single-part assertion cannot tell a rule that correctly went quiet from one that was never wired up.

```ts
describe('ValidatePdfA — part 4 inversions (the rule must go SILENT)', () => {
  const errs = (bytes: Uint8Array, level: any) =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('/ToUnicode: required at 2u, not required at 4', () => {
    expect(errs(buildPdfaPdf({ type0: true, omitToUnicode: true }, 2), '2u')).toContain('ToUnicode');
    expect(errs(buildPdfaPdf({ type0: true, omitToUnicode: true }, 4), '4')).not.toContain('ToUnicode');
  });

  it('/CIDSet: required at 2b, no such rule at 4', () => {
    expect(errs(buildPdfaPdf({ type0: true, omitCidSet: true }, 2), '2b')).toContain('FontCIDSet');
    const part4 = Document.Open(buildPdfaPdf({ type0: true, omitCidSet: true }, 4))
      .ValidatePdfA('4').Issues.map((i) => i.rule);
    expect(part4).not.toContain('FontCIDSet');
  });

  it('JavaScript actions: prohibited at 2b, permitted at 4', () => {
    expect(errs(buildPdfaPdf({ jsAction: true }, 2), '2b')).toContain('Actions');
    expect(errs(buildPdfaPdf({ jsAction: true }, 4), '4')).not.toContain('Actions');
  });

  it('/Info-vs-XMP consistency: reported at 2b, superseded at 4', () => {
    const opts = { infoTitle: 'A', xmpTitle: 'B' };
    const at2 = Document.Open(buildPdfaPdf(opts, 2)).ValidatePdfA('2b')
      .Issues.map((i) => i.rule);
    expect(at2).toContain('XmpInfoConsistency');
    const at4 = Document.Open(buildPdfaPdf({ ...opts, pieceInfo: true }, 4)).ValidatePdfA('4')
      .Issues.map((i) => i.rule);
    expect(at4).not.toContain('XmpInfoConsistency');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts -t inversions`
Expected: FAIL on all four — each rule currently fires at part 4.

- [ ] **Step 3: Silence `toUnicodeRule` and `fontCidSetRule` at part 4**

In `src/pdfavalidate.ts`, change the first line of `toUnicodeRule`'s body:

```ts
const toUnicodeRule: Rule = (ctx) => {
  // ISO 19005-4 has NO /ToUnicode presence requirement — clause 6.2.10.7
  // constrains a ToUnicode CMap's contents only if one exists (see
  // toUnicodeContentRule). This contradicts the widespread 'PDF/A-4 ≈
  // PDF/A-2u' folklore; the veraPDF profile is the anchor and has no such rule.
  if (ctx.part === 4 || ctx.level === 'b') return [];
```

And the first line of `fontCidSetRule`'s body, immediately inside the `flatMap` guard — add a whole-rule guard before the `enumerateFonts` call instead:

```ts
const fontCidSetRule: Rule = (ctx) => {
  // ISO 19005-4 has no /CIDSet or /CharSet rule at all; PDF 2.0 deprecated both.
  if (ctx.part === 4) return [];
  return enumerateFonts(ctx).flatMap(({ ref: object, dict }) => {
```

(close the added `return` with the existing `});` — the body is otherwise unchanged.)

- [ ] **Step 4: Silence `xmpInfoConsistencyRule` at part 4**

```ts
const xmpInfoConsistencyRule: Rule = (ctx) => {
  // Superseded at part 4 by infoRestrictionRule: PDF/A-4 permits /Info only
  // alongside a catalog /PieceInfo, and then only /ModDate — so there is no
  // title or author left to disagree with XMP about.
  if (ctx.part === 4) return [];
  const info = ctx.doc.GetMetadata();
```

- [ ] **Step 5: Permit JavaScript at part 4 in `actionsRule`**

Replace `PROHIBITED_ACTIONS` and `actionsRule` in `src/pdfavalidate.ts`:

```ts
const PROHIBITED_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript', 'SetState', 'Hide', 'SetOCGState',
]);

/** ISO 19005-4 6.6.1-1. Note what is ABSENT: JavaScript is permitted in
 *  PDF/A-4, where parts 1–3 prohibit it. 'Trans' and 'Rendition' are new. */
const PROHIBITED_ACTIONS_A4 = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide',
  'Rendition', 'Trans', 'SetOCGState', 'GoTo3DView', 'SetState', 'NoOp',
]);

/** ISO 19005-4 6.6.1-2: named actions are limited to page navigation. */
const PERMITTED_NAMED_ACTIONS = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);

/** The prohibited-action set for the target. PDF/A-4e re-permits SetOCGState
 *  and GoTo3DView, which is most of what makes it the engineering level. */
function prohibitedActions(ctx: Ctx): Set<string> {
  if (ctx.part !== 4) return PROHIBITED_ACTIONS;
  if (ctx.level !== 'e') return PROHIBITED_ACTIONS_A4;
  const s = new Set(PROHIBITED_ACTIONS_A4);
  s.delete('SetOCGState');
  s.delete('GoTo3DView');
  return s;
}

const actionsRule: Rule = (ctx) => {
  const banned = prohibitedActions(ctx);
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.6.1' : 'ISO 19005-1 §6.6.1';
  const issues: ValidationIssue[] = [];
  const check = (obj: PdfObject | undefined, where: string): void => {
    for (const t of collectActionTypes(ctx, obj)) {
      if (banned.has(t)) {
        issues.push({ rule: 'Actions', severity: 'error', clause,
          message: `Prohibited action /${t} (${where}).` });
      }
    }
  };
  check(ctx.catalog.get('OpenAction'), 'catalog /OpenAction');
  // A /Names /JavaScript tree implies JavaScript actions — prohibited at parts
  // 1–3 and permitted at part 4, so this check is part-gated with the set above.
  if (banned.has('JavaScript')) {
    const names = ctx.R(ctx.catalog.get('Names'));
    if (isDict(names) && names.get('JavaScript') !== undefined) {
      issues.push({ rule: 'Actions', severity: 'error', clause,
        message: 'Document contains a /Names /JavaScript tree (JavaScript actions).' });
    }
  }
  for (const { dict } of eachAnnotation(ctx)) check(dict.get('A'), 'annotation /A');
  if (ctx.part === 4) {
    for (const named of collectNamedActions(ctx)) {
      if (!PERMITTED_NAMED_ACTIONS.has(named)) {
        issues.push({ rule: 'Actions', severity: 'error', clause: 'ISO 19005-4 §6.6.1',
          message: `Named action /${named} is not one of NextPage, PrevPage, FirstPage, LastPage.` });
      }
    }
  }
  return issues;
};
```

Add this helper immediately below `collectActionTypes`:

```ts
/** Every /N value of a /Named action reachable from the catalog or an
 *  annotation, for ISO 19005-4 6.6.1-2. */
function collectNamedActions(ctx: Ctx): string[] {
  const out: string[] = [];
  const walk = (obj: PdfObject | undefined, seen = new Set<PdfDict>()): void => {
    const a = ctx.R(obj);
    if (!isDict(a) || seen.has(a)) return;
    seen.add(a);
    if (nameOf(ctx, a, 'S') === 'Named') {
      const n = nameOf(ctx, a, 'N');
      if (n) out.push(n);
    }
    const next = ctx.R(a.get('Next'));
    if (isArray(next)) for (const n of next) walk(n, seen);
    else if (isDict(next)) walk(next, seen);
  };
  walk(ctx.catalog.get('OpenAction'));
  for (const { dict } of eachAnnotation(ctx)) walk(dict.get('A'));
  return out;
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS. The parts 1–3 halves of every pair must still report — that is the whole point of the pairs.

- [ ] **Step 7: Mutation-check the silencing**

Remove `ctx.part === 4 ||` from `toUnicodeRule` — the ToUnicode pair's part-4 half must redden while its `'2u'` half stays green. Restore. Repeat for `fontCidSetRule`, `xmpInfoConsistencyRule`, and by adding `'JavaScript'` back into `PROHIBITED_ACTIONS_A4`.

- [ ] **Step 8: Commit**

```bash
git add src/pdfavalidate.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): the four PDF/A-4 inversions

/ToUnicode presence, /CIDSet, JavaScript actions and the /Info-vs-XMP
consistency check all go SILENT at part 4 - a document that fails at '2u'
can pass at '4' for the same reason. The ToUnicode one contradicts the
'PDF/A-4 = PDF/A-2u' folklore; the anchor has no presence rule.

Each is pinned by a CROSS-PART PAIR. A single-part assertion provably
cannot tell a rule that correctly went quiet from one never wired up.

Also adds PDF/A-4's own action rules: Rendition, Trans and GoTo3DView join
the prohibited set, named actions are limited to page navigation, and 4e
re-permits SetOCGState and GoTo3DView.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Annotation and form stances at part 4

**Files:**
- Modify: `src/pdfavalidate.ts` (`annotationSubtypeRule`, `annotationFlagsRule`, `annotationAppearanceRule`, `additionalActionsRule`, `externalStreamRule`, `blendModeRule`, `imageInterpolateRule`)
- Modify: `test/helpers/build-pdfa-pdf.ts` (three annotation options)
- Test: `test/pdfa4-validate.test.ts`

**Interfaces:**
- Consumes: Task 1's `Ctx`, Task 2's fixture mode.
- Produces: `PdfaOptions` gains `fileAttachAnnot?: boolean`, `threeDAnnot?: boolean`, `toggleNoViewAnnot?: boolean`, `apWithDown?: boolean`, `widgetWithAction?: boolean`, `extraStreamKeys?: boolean`. Task 8 reuses `apWithDown` and `widgetWithAction`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfa4-validate.test.ts`:

```ts
describe('ValidatePdfA — part 4 annotations, actions and severities', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);
  const warns = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Warnings.map((e) => e.rule);

  it('prohibits /FileAttachment at part 4 but permits it at 2b', () => {
    expect(errs(buildPdfaPdf({ fileAttachAnnot: true }, 4))).toContain('AnnotationSubtype');
    expect(errs(buildPdfaPdf({ fileAttachAnnot: true }, 2), '2b')).not.toContain('AnnotationSubtype');
  });
  it('prohibits /3D at the base level and permits it at 4e', () => {
    expect(errs(buildPdfaPdf({ threeDAnnot: true }, 4))).toContain('AnnotationSubtype');
    expect(errs(buildPdfaPdf({ threeDAnnot: true, pdfaConformance: 'E' }, 4), '4e'))
      .not.toContain('AnnotationSubtype');
  });
  it('prohibits the ToggleNoView flag at part 4 but not at 2b', () => {
    expect(errs(buildPdfaPdf({ toggleNoViewAnnot: true }, 4))).toContain('AnnotationFlags');
    expect(errs(buildPdfaPdf({ toggleNoViewAnnot: true }, 2), '2b')).not.toContain('AnnotationFlags');
  });
  it('restricts /AA keys at part 4 rather than banning the dictionary', () => {
    expect(errs(buildPdfaPdf({ additionalAction: true }, 4))).toContain('AdditionalActions');
  });
  it('rejects /FFilter on a stream at part 4', () => {
    expect(errs(buildPdfaPdf({ extraStreamKeys: true }, 4))).toContain('ExternalStream');
    expect(errs(buildPdfaPdf({ extraStreamKeys: true }, 2), '2b')).not.toContain('ExternalStream');
  });
  it('raises blend mode and /Interpolate to errors at part 4', () => {
    expect(errs(buildPdfaPdf({ nonStandardBlend: true }, 4))).toContain('BlendMode');
    expect(warns(buildPdfaPdf({ nonStandardBlend: true }, 2), '2b')).toContain('BlendMode');
    expect(errs(buildPdfaPdf({ interpolateImage: true }, 4))).toContain('ImageInterpolate');
    expect(warns(buildPdfaPdf({ interpolateImage: true }, 2), '2b')).toContain('ImageInterpolate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts -t "annotations, actions"`
Expected: FAIL — the new fixture options do not exist.

- [ ] **Step 3: Add the fixture options**

In `test/helpers/build-pdfa-pdf.ts`, add to `PdfaOptions` under `// annotations / forms / actions`:

```ts
  fileAttachAnnot?: boolean;   // add a /FileAttachment annot (part-4 prohibited)
  threeDAnnot?: boolean;       // add a /3D annot (prohibited at 4, allowed at 4e)
  toggleNoViewAnnot?: boolean; // annot with the ToggleNoView flag (bit 9)
  apWithDown?: boolean;        // annot whose /AP carries /D beside /N
  widgetWithAction?: boolean;  // a /Widget annot carrying /A
  extraStreamKeys?: boolean;   // content stream also carries /FFilter
```

In the annots block, after the `hiddenAnnot` line:

```ts
  if (opts.fileAttachAnnot) annots.push('24 0 R');
  if (opts.threeDAnnot) annots.push('25 0 R');
  if (opts.toggleNoViewAnnot) annots.push('26 0 R');
  if (opts.apWithDown) annots.push('27 0 R');
  if (opts.widgetWithAction) annots.push('28 0 R');
```

After the `objects[22]` line:

```ts
  const apRef = ' /AP << /N 22 0 R >>';
  const apForm = '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream';
  if (opts.fileAttachAnnot) objects[24] = `<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 10 10] /F 4${apRef} >>`;
  if (opts.threeDAnnot) objects[25] = `<< /Type /Annot /Subtype /3D /Rect [0 0 10 10] /F 4${apRef} >>`;
  if (opts.toggleNoViewAnnot) objects[26] = `<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 260${apRef} >>`;
  if (opts.apWithDown) objects[27] = '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /F 4 /AP << /N 22 0 R /D 22 0 R >> >>';
  if (opts.widgetWithAction) objects[28] = `<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /F 4${apRef} /A << /S /GoTo /D [3 0 R /Fit] >> >>`;
  if (opts.fileAttachAnnot || opts.threeDAnnot || opts.toggleNoViewAnnot
      || opts.apWithDown || opts.widgetWithAction) objects[22] = apForm;
```

Note `objects[22]` is now set by either `hiddenAnnot` or any of these — assigning the same form twice is harmless. Flag 260 is `Print` (4) plus `ToggleNoView` (256).

Finally, extend the content stream dictionary:

```ts
  const streamExtra = opts.extraStreamKeys ? ' /FFilter /FlateDecode' : '';
  objects[4] = `<< /Length ${byteLen(content)}${streamFilter}${streamExt}${streamExtra} >>\nstream\n${content}endstream`;
```

- [ ] **Step 4: Update the annotation rules**

In `src/pdfavalidate.ts`, replace `PROHIBITED_ANNOTS` and the three annotation rules:

```ts
const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** ISO 19005-4 6.3.1-1: FileAttachment joins the prohibited set. 3D and
 *  RichMedia come back off it at 4e — that allowance is most of what makes
 *  PDF/A-4e the engineering conformance. */
const PROHIBITED_ANNOTS_A4 = new Set([
  'Movie', 'Sound', 'Screen', '3D', 'RichMedia', 'FileAttachment',
]);

function prohibitedAnnots(ctx: Ctx): Set<string> {
  if (ctx.part !== 4) return PROHIBITED_ANNOTS;
  if (ctx.level !== 'e') return PROHIBITED_ANNOTS_A4;
  const s = new Set(PROHIBITED_ANNOTS_A4);
  s.delete('3D');
  s.delete('RichMedia');
  return s;
}

const annotationSubtypeRule: Rule = (ctx) => {
  const banned = prohibitedAnnots(ctx);
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.3.1' : 'ISO 19005-1 §6.5.2';
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    return subtype && banned.has(subtype)
      ? [{ rule: 'AnnotationSubtype', severity: 'error' as const, clause, object, page,
          message: `Annotation subtype /${subtype} is prohibited in PDF/A.` }]
      : [];
  });
};

const annotationAppearanceRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup' || subtype === 'Link') return [];
    // ISO 19005-4 6.3.3-1 adds /Projection to the exempt list.
    if (ctx.part === 4 && subtype === 'Projection') return [];
    const ap = ctx.R(dict.get('AP'));
    const n = isDict(ap) ? ap.get('N') : undefined;
    if (n === undefined) {
      return [{ rule: 'AnnotationAppearance', severity: 'error' as const,
        clause: ctx.part === 4 ? 'ISO 19005-4 §6.3.3' : 'ISO 19005-1 §6.5.3', object, page,
        message: `${subtype ?? 'Annotation'} has no normal appearance stream (/AP /N).` }];
    }
    return [];
  });

const annotationFlagsRule: Rule = (ctx) =>
  eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const subtype = nameOf(ctx, dict, 'Subtype');
    if (subtype === 'Popup') return [];
    const f = ctx.R(dict.get('F'));
    const flags = typeof f === 'number' ? f : 0;
    const clause = ctx.part === 4 ? 'ISO 19005-4 §6.3.2' : 'ISO 19005-1 §6.5.3';
    const mk = (which: string): ValidationIssue => ({
      rule: 'AnnotationFlags', severity: 'error', clause, object, page,
      message: `Annotation flag invalid for PDF/A (${which}).`,
    });
    const issues: ValidationIssue[] = [];
    if ((flags & 2) !== 0) issues.push(mk('Hidden'));       // bit 2
    if ((flags & 32) !== 0) issues.push(mk('NoView'));      // bit 6
    if ((flags & 1) !== 0) issues.push(mk('Invisible'));    // bit 1
    if ((flags & 4) === 0) issues.push(mk('not Print'));    // bit 3 must be set
    // ISO 19005-4 6.3.2-2 adds ToggleNoView (bit 9).
    if (ctx.part === 4 && (flags & 256) !== 0) issues.push(mk('ToggleNoView'));
    return issues;
  });
```

- [ ] **Step 5: Restrict `/AA` keys at part 4**

Replace the `else` branch of `additionalActionsRule` so part 4 gets its own arm. The full rule becomes:

```ts
/** ISO 19005-4 6.6.3-1: the permitted additional-action triggers. */
const PERMITTED_AA_KEYS = new Set(['E', 'X', 'D', 'U', 'Fo', 'Bl']);

const additionalActionsRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const slots: [PdfObject | undefined, string, string | undefined][] = [
    [ctx.catalog.get('AA'), 'catalog /AA', undefined],
    ...ctx.doc.Pages.map((p) => [p.Dict.get('AA'), 'page /AA', undefined] as [PdfObject | undefined, string, string | undefined]),
    ...eachAnnotation(ctx).map(({ dict }) =>
      [dict.get('AA'), 'annotation /AA', nameOf(ctx, dict, 'Subtype')] as [PdfObject | undefined, string, string | undefined]),
  ];
  for (const [aa, where, subtype] of slots) {
    const d = ctx.R(aa);
    if (!isDict(d)) continue;
    if (ctx.part === 1) {
      issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-1 §6.6.2',
        message: `Additional-actions dictionary (${where}) is prohibited in PDF/A-1.` });
      continue;
    }
    if (ctx.part === 4) {
      // 6.6.3-1 exempts Widget annotations, whose triggers are the form's.
      if (subtype === 'Widget') continue;
      for (const k of d.keys()) {
        if (!PERMITTED_AA_KEYS.has(k)) {
          issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-4 §6.6.3',
            message: `Additional-actions key /${k} (${where}) is not one of E, X, D, U, Fo, Bl.` });
        }
      }
      continue;
    }
    for (const v of d.values()) {
      for (const t of collectActionTypes(ctx, v)) {
        if (PROHIBITED_ACTIONS.has(t)) {
          issues.push({ rule: 'AdditionalActions', severity: 'error', clause: 'ISO 19005-2 §6.6.2',
            message: `Prohibited action /${t} in additional-actions (${where}).` });
        }
      }
    }
  }
  return issues;
};
```

- [ ] **Step 6: Widen `externalStreamRule` and raise the two severities**

```ts
const externalStreamRule: Rule = (ctx) => {
  // ISO 19005-4 6.1.6.1-2 bans /FFilter and /FDecodeParms alongside /F.
  const keys = ctx.part === 4 ? ['F', 'FFilter', 'FDecodeParms'] : ['F'];
  return allObjects(ctx).flatMap(([object, obj]) => {
    if (!isStream(obj)) return [];
    const hit = keys.find((k) => obj.dict.get(k) !== undefined);
    return hit === undefined ? [] : [{
      rule: 'ExternalStream', severity: 'error' as const,
      clause: ctx.part === 4 ? 'ISO 19005-4 §6.1.6.1' : 'ISO 19005-1 §6.1.7', object,
      message: `Stream references external file data (/${hit}); PDF/A requires embedded data.`,
    }];
  });
};
```

In `blendModeRule`, replace the pushed severity with `ctx.part === 4 ? 'error' : 'warning'` and the clause with `ctx.part === 4 ? 'ISO 19005-4 §6.2.9' : 'ISO 19005-2 §6.2.4.3'`. In `imageInterpolateRule`, replace `severity: 'warning'` with `severity: ctx.part === 4 ? 'error' : 'warning'` and the clause with `ctx.part === 4 ? 'ISO 19005-4 §6.2.7.1' : 'ISO 19005-1 §6.2.6'`. Both need the rule body converted from a bare `flatMap` expression to a block body so `ctx` is in scope for the ternary — `imageInterpolateRule` becomes:

```ts
const imageInterpolateRule: Rule = (ctx) => {
  const severity: Severity = ctx.part === 4 ? 'error' : 'warning';
  const clause = ctx.part === 4 ? 'ISO 19005-4 §6.2.7.1' : 'ISO 19005-1 §6.2.6';
  return allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Image' && ctx.R(obj.dict.get('Interpolate')) === true
      ? [{ rule: 'ImageInterpolate', severity, clause, object,
          message: 'Image /Interpolate true is prohibited in PDF/A.' }]
      : []);
};
```

- [ ] **Step 7: Run the tests and mutation-check**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS.

Then: remove `'FileAttachment'` from `PROHIBITED_ANNOTS_A4` (the FileAttachment pair reddens); remove the `flags & 256` line (the ToggleNoView pair reddens); remove `'FFilter'` from the key list (the `/FFilter` pair reddens). Restore each.

- [ ] **Step 8: Commit**

```bash
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): PDF/A-4 annotation, /AA and severity stances

/FileAttachment joins the prohibited annotation set and ToggleNoView joins
the prohibited flags; /Projection joins Popup and Link as exempt from the
appearance requirement. 4e takes 3D and RichMedia back off the set, which
is most of what makes it the engineering conformance.

/AA is no longer banned outright nor merely scanned for prohibited action
types - part 4 restricts its KEYS to E, X, D, U, Fo, Bl, exempting Widget
annotations. Blend mode and /Interpolate become errors at part 4, both
being shall clauses; parts 2/3 keep their warnings.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: New catalog-level part-4 rules

**Files:**
- Modify: `src/pdfavalidate.ts` (five new rules + `RULES`)
- Modify: `test/helpers/build-pdfa-pdf.ts` (five options)
- Test: `test/pdfa4-validate.test.ts`

**Interfaces:**
- Consumes: Task 1's `Ctx`, Task 2's fixture mode.
- Produces: rules `InfoRestriction`, `Permissions`, `NeedsRendering`, `Requirements`, `AlternatePresentations`. `PdfaOptions` gains `perms?: 'ok' | 'bad'`, `needsRendering?: boolean`, `requirements?: boolean`, `alternatePresentations?: boolean`, `presSteps?: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
describe('ValidatePdfA — part 4 catalog rules', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags /Info present with no catalog /PieceInfo', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X' }, 4))).toContain('InfoRestriction');
  });
  it('flags /Info holding anything but /ModDate', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X', pieceInfo: true }, 4))).toContain('InfoRestriction');
  });
  it('accepts /Info holding only /ModDate beside a /PieceInfo', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X', infoModDateOnly: true, pieceInfo: true }, 4)))
      .not.toContain('InfoRestriction');
  });
  it('does not restrict /Info at parts 1-3', () => {
    expect(errs(buildPdfaPdf({ infoTitle: 'X' }, 2), '2b')).not.toContain('InfoRestriction');
  });

  it('flags a /Perms key other than /DocMDP', () => {
    expect(errs(buildPdfaPdf({ perms: 'bad' }, 4))).toContain('Permissions');
    expect(errs(buildPdfaPdf({ perms: 'ok' }, 4))).not.toContain('Permissions');
  });
  it('flags catalog /NeedsRendering', () => {
    expect(errs(buildPdfaPdf({ needsRendering: true }, 4))).toContain('NeedsRendering');
  });
  it('flags catalog /Requirements', () => {
    expect(errs(buildPdfaPdf({ requirements: true }, 4))).toContain('Requirements');
  });
  it('flags /Names /AlternatePresentations', () => {
    expect(errs(buildPdfaPdf({ alternatePresentations: true }, 4))).toContain('AlternatePresentations');
  });
  it('flags a page /PresSteps', () => {
    expect(errs(buildPdfaPdf({ presSteps: true }, 4))).toContain('AlternatePresentations');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts -t "catalog rules"`
Expected: FAIL — options and rules do not exist.

- [ ] **Step 3: Add the fixture options**

Add to `PdfaOptions` under `// file / structure`:

```ts
  perms?: 'ok' | 'bad';          // catalog /Perms with /DocMDP only, or with /UR3
  needsRendering?: boolean;      // catalog /NeedsRendering true
  requirements?: boolean;        // catalog /Requirements array
  alternatePresentations?: boolean; // /Names /AlternatePresentations
  presSteps?: boolean;           // page /PresSteps
```

In the catalog block, after the `pieceInfo` line:

```ts
  if (opts.perms === 'ok') catParts.push('/Perms << /DocMDP 29 0 R >>');
  if (opts.perms === 'bad') catParts.push('/Perms << /DocMDP 29 0 R /UR3 29 0 R >>');
  if (opts.needsRendering) catParts.push('/NeedsRendering true');
  if (opts.requirements) catParts.push('/Requirements [<< /Type /Requirement /S /EnableJavaScripts >>]');
  if (opts.alternatePresentations) catParts.push('/Names << /AlternatePresentations << /Names [] >> >>');
```

After the annotation objects:

```ts
  if (opts.perms) objects[29] = '<< /Type /Sig /Filter /Adobe.PPKLite >>';
```

In the page block, beside `if (opts.transparencyGroup)`:

```ts
  if (opts.presSteps) pageParts.push('/PresSteps << /Type /NavNode >>');
```

- [ ] **Step 4: Add the five rules**

Append to `src/pdfavalidate.ts` above the `RULES` array:

```ts
// ---- PDF/A-4 (ISO 19005-4) catalog rules -----------------------------------

const infoRestrictionRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const infoObj = ctx.doc.trailer.get('Info');
  if (infoObj === undefined) return [];
  const issues: ValidationIssue[] = [];
  const object = isRef(infoObj) ? infoObj : undefined;
  // 6.1.3-4: PDF 2.0 deprecates /Info, so PDF/A-4 permits it only as the
  // companion of a catalog /PieceInfo.
  if (ctx.catalog.get('PieceInfo') === undefined) {
    issues.push({ rule: 'InfoRestriction', severity: 'error', clause: 'ISO 19005-4 §6.1.3', object,
      message: 'Trailer /Info is present but the catalog has no /PieceInfo; PDF/A-4 permits /Info only alongside one.' });
  }
  // 6.1.3-5: and then it may hold nothing but /ModDate.
  const info = ctx.R(infoObj);
  if (isDict(info)) {
    for (const k of info.keys()) {
      if (k !== 'ModDate') {
        issues.push({ rule: 'InfoRestriction', severity: 'error', clause: 'ISO 19005-4 §6.1.3', object,
          message: `Document information dictionary contains /${k}; PDF/A-4 permits only /ModDate.` });
      }
    }
  }
  return issues;
};

const permissionsRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const perms = ctx.R(ctx.catalog.get('Perms'));
  if (!isDict(perms)) return [];
  return [...perms.keys()].filter((k) => k !== 'DocMDP').map((k) => ({
    rule: 'Permissions', severity: 'error' as const, clause: 'ISO 19005-4 §6.1.11',
    message: `Catalog /Perms contains /${k}; PDF/A-4 permits only /DocMDP.`,
  }));
};

const needsRenderingRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  if (ctx.catalog.get('NeedsRendering') === undefined) return [];
  return [{ rule: 'NeedsRendering', severity: 'error', clause: 'ISO 19005-4 §6.4.2',
    message: 'Catalog /NeedsRendering is prohibited in PDF/A-4.' }];
};

const requirementsRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  if (ctx.catalog.get('Requirements') === undefined) return [];
  return [{ rule: 'Requirements', severity: 'error', clause: 'ISO 19005-4 §6.12',
    message: 'Catalog /Requirements is prohibited in PDF/A-4.' }];
};

const alternatePresentationsRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('AlternatePresentations') !== undefined) {
    issues.push({ rule: 'AlternatePresentations', severity: 'error', clause: 'ISO 19005-4 §6.11',
      message: '/Names /AlternatePresentations is prohibited in PDF/A-4.' });
  }
  for (const page of ctx.doc.Pages) {
    if (page.Dict.get('PresSteps') !== undefined) {
      issues.push({ rule: 'AlternatePresentations', severity: 'error', clause: 'ISO 19005-4 §6.11', page,
        message: 'Page /PresSteps is prohibited in PDF/A-4.' });
    }
  }
  return issues;
};
```

Add all five to `RULES`, after `xmpInfoConsistencyRule`:

```ts
  infoRestrictionRule, permissionsRule, needsRenderingRule,
  requirementsRule, alternatePresentationsRule,
```

- [ ] **Step 5: Run the tests and mutation-check**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS.

Mutation: change `k !== 'ModDate'` to `false` (the "anything but /ModDate" case reddens); drop the `PieceInfo` branch (the no-PieceInfo case reddens); change `k !== 'DocMDP'` to `false` (the `/Perms` case reddens). Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): PDF/A-4 catalog rules

PDF 2.0 deprecates /Info, so PDF/A-4 near-bans it: permitted only as the
companion of a catalog /PieceInfo, and then holding nothing but /ModDate.
That is what supersedes the /Info-vs-XMP consistency check at part 4.

Plus /Perms limited to /DocMDP, and /NeedsRendering, /Requirements,
/Names /AlternatePresentations and page /PresSteps all prohibited.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: New graphics-state, image and output-intent rules

**Files:**
- Modify: `src/pdfavalidate.ts` (six new rules + `RULES`)
- Modify: `test/helpers/build-pdfa-pdf.ts` (six options)
- Test: `test/pdfa4-validate.test.ts`

**Interfaces:**
- Consumes: `extGStates(ctx)`, `allObjects(ctx)` from `validatectx.js` (already imported).
- Produces: rules `ExtGStateKeys`, `Halftone`, `ImageKeys`, `FormXObjectOpi`, `OutputIntentKeys`, `TransparencyBlendingSpace`. `PdfaOptions` gains `trExtGState?: boolean`, `htoExtGState?: boolean`, `badHalftone?: boolean`, `imageAlternates?: boolean`, `badBitsPerComponent?: boolean`, `formOpi?: boolean`, `destOutputProfileRef?: boolean`, `groupNoCs?: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
describe('ValidatePdfA — part 4 graphics rules', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags ExtGState /TR and /HTO', () => {
    expect(errs(buildPdfaPdf({ trExtGState: true }, 4))).toContain('ExtGStateKeys');
    expect(errs(buildPdfaPdf({ htoExtGState: true }, 4))).toContain('ExtGStateKeys');
  });
  it('flags a halftone that is neither type 1 nor type 5', () => {
    expect(errs(buildPdfaPdf({ badHalftone: true }, 4))).toContain('Halftone');
  });
  it('flags image /Alternates and a bad BitsPerComponent', () => {
    expect(errs(buildPdfaPdf({ imageAlternates: true }, 4))).toContain('ImageKeys');
    expect(errs(buildPdfaPdf({ badBitsPerComponent: true }, 4))).toContain('ImageKeys');
  });
  it('flags /OPI on a Form XObject', () => {
    expect(errs(buildPdfaPdf({ formOpi: true }, 4))).toContain('FormXObjectOpi');
  });
  it('flags /DestOutputProfileRef', () => {
    expect(errs(buildPdfaPdf({ destOutputProfileRef: true }, 4))).toContain('OutputIntentKeys');
  });
  it('flags a transparency group with no /CS when there is no output intent', () => {
    expect(errs(buildPdfaPdf({ groupNoCs: true, omitOutputIntent: true, deviceColorContent: false }, 4)))
      .toContain('TransparencyBlendingSpace');
  });
  it('accepts a transparency group with no /CS when a document output intent exists', () => {
    expect(errs(buildPdfaPdf({ groupNoCs: true }, 4))).not.toContain('TransparencyBlendingSpace');
  });
  it('applies none of these at parts 1-3', () => {
    expect(errs(buildPdfaPdf({ trExtGState: true }, 2), '2b')).not.toContain('ExtGStateKeys');
    expect(errs(buildPdfaPdf({ imageAlternates: true }, 2), '2b')).not.toContain('ImageKeys');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts -t "graphics rules"`
Expected: FAIL.

- [ ] **Step 3: Add the fixture options**

Add to `PdfaOptions`:

```ts
  trExtGState?: boolean;        // ExtGState with /TR
  htoExtGState?: boolean;       // ExtGState with /HTO
  badHalftone?: boolean;        // ExtGState /HT with /HalftoneType 6
  imageAlternates?: boolean;    // image XObject with /Alternates
  badBitsPerComponent?: boolean;// image XObject with /BitsPerComponent 12
  formOpi?: boolean;            // Form XObject with /OPI
  destOutputProfileRef?: boolean; // OutputIntent with /DestOutputProfileRef
  groupNoCs?: boolean;          // page /Group /S /Transparency with no /CS
```

In the ExtGState block:

```ts
  if (opts.trExtGState) egs.push('/GSt << /Type /ExtGState /TR /Identity >>');
  if (opts.htoExtGState) egs.push('/GSh << /Type /ExtGState /HTO 1 >>');
  if (opts.badHalftone) egs.push('/GSn << /Type /ExtGState /HT << /Type /Halftone /HalftoneType 6 /HalftoneName (x) >> >>');
```

In the XObject block:

```ts
  if (opts.imageAlternates) xobjs.push('/ImgA 30 0 R');
  if (opts.badBitsPerComponent) xobjs.push('/ImgB 31 0 R');
  if (opts.formOpi) xobjs.push('/FrmO 32 0 R');
```

Alongside the other object definitions:

```ts
  if (opts.imageAlternates) objects[30] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Alternates [] /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.badBitsPerComponent) objects[31] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 12 /Length 1 >>\nstream\n\x00\nendstream';
  if (opts.formOpi) objects[32] = '<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /OPI << >> /Length 0 >>\nstream\n\nendstream';
```

Change the transparency-group line and the output-intent line:

```ts
  if (opts.transparencyGroup) pageParts.push('/Group << /S /Transparency >>');
  else if (opts.groupNoCs) pageParts.push('/Group << /S /Transparency >>');
```

```ts
  if (!opts.omitOutputIntent) {
    const dopr = opts.destOutputProfileRef ? ' /DestOutputProfileRef << /DOS (x) >>' : '';
    catParts.push(`/OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) /DestOutputProfile 8 0 R${dopr} >>]`);
  }
```

Note `groupNoCs` and `transparencyGroup` emit the same dictionary; they are separate options only so a reader of a test can see which rule the case is aimed at.

- [ ] **Step 4: Add the six rules**

Append to `src/pdfavalidate.ts` above `RULES`:

```ts
// ---- PDF/A-4 graphics ------------------------------------------------------

const extGStateKeysRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict } of extGStates(ctx)) {
    // 6.2.5-1/-3: transfer and halftone-origin functions are prohibited outright.
    for (const k of ['TR', 'HTO']) {
      if (dict.get(k) !== undefined) {
        issues.push({ rule: 'ExtGStateKeys', severity: 'error', clause: 'ISO 19005-4 §6.2.5', object,
          message: `ExtGState /${k} is prohibited in PDF/A-4.` });
      }
    }
    // 6.2.5-2: /TR2 survives, but only as /Default.
    const tr2 = dict.get('TR2');
    if (tr2 !== undefined && nameOf(ctx, dict, 'TR2') !== 'Default') {
      issues.push({ rule: 'ExtGStateKeys', severity: 'error', clause: 'ISO 19005-4 §6.2.5', object,
        message: 'ExtGState /TR2 must be /Default in PDF/A-4.' });
    }
  }
  return issues;
};

const halftoneRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict } of extGStates(ctx)) {
    const ht = ctx.R(dict.get('HT'));
    if (!isDict(ht)) continue;
    const type = ctx.R(ht.get('HalftoneType'));
    if (typeof type === 'number' && type !== 1 && type !== 5) {
      issues.push({ rule: 'Halftone', severity: 'error', clause: 'ISO 19005-4 §6.2.5', object,
        message: `Halftone type ${type} is prohibited in PDF/A-4; only 1 and 5 are permitted.` });
    }
    if (ht.get('HalftoneName') !== undefined) {
      issues.push({ rule: 'Halftone', severity: 'error', clause: 'ISO 19005-4 §6.2.5', object,
        message: 'Halftone /HalftoneName is prohibited in PDF/A-4.' });
    }
  }
  return issues;
};

const PERMITTED_BPC = new Set([1, 2, 4, 8, 16]);

const imageKeysRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj) || nameOf(ctx, obj.dict, 'Subtype') !== 'Image') continue;
    for (const k of ['Alternates', 'OPI']) {
      if (obj.dict.get(k) !== undefined) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause: 'ISO 19005-4 §6.2.7.1', object,
          message: `Image /${k} is prohibited in PDF/A-4.` });
      }
    }
    const bpc = ctx.R(obj.dict.get('BitsPerComponent'));
    const isMask = ctx.R(obj.dict.get('ImageMask')) === true;
    if (typeof bpc === 'number') {
      if (isMask && bpc !== 1) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause: 'ISO 19005-4 §6.2.7.1', object,
          message: `Image mask /BitsPerComponent is ${bpc}; must be 1.` });
      } else if (!isMask && !PERMITTED_BPC.has(bpc)) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause: 'ISO 19005-4 §6.2.7.1', object,
          message: `Image /BitsPerComponent is ${bpc}; must be 1, 2, 4, 8 or 16.` });
      }
    }
  }
  return issues;
};

const formXObjectOpiRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  return allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Form' && obj.dict.get('OPI') !== undefined
      ? [{ rule: 'FormXObjectOpi', severity: 'error' as const, clause: 'ISO 19005-4 §6.2.8.1', object,
          message: 'Form XObject /OPI is prohibited in PDF/A-4.' }]
      : []);
};

const outputIntentKeysRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const ois = ctx.R(ctx.catalog.get('OutputIntents'));
  if (!isArray(ois)) return [];
  const issues: ValidationIssue[] = [];
  let pdfaCount = 0;
  for (const e of ois) {
    const oi = ctx.R(e);
    if (!isDict(oi)) continue;
    if (nameOf(ctx, oi, 'S') === 'GTS_PDFA1') pdfaCount++;
    if (oi.get('DestOutputProfileRef') !== undefined) {
      issues.push({ rule: 'OutputIntentKeys', severity: 'error', clause: 'ISO 19005-4 §6.2.3',
        object: isRef(e) ? e : undefined,
        message: 'OutputIntent /DestOutputProfileRef is prohibited in PDF/A-4.' });
    }
  }
  if (pdfaCount > 1) {
    issues.push({ rule: 'OutputIntentKeys', severity: 'error', clause: 'ISO 19005-4 §6.2.3',
      message: `The /OutputIntents array holds ${pdfaCount} PDF/A output intents; at most one is permitted.` });
  }
  return issues;
};

const transparencyBlendingSpaceRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  // 6.2.9-2 only bites when the document declares no PDF/A output intent.
  if (pdfaOutputIntentProfile(ctx) !== 'missing') return [];
  const issues: ValidationIssue[] = [];
  for (const page of ctx.doc.Pages) {
    if (ctx.R(page.Dict.get('OutputIntents')) !== null
      && page.Dict.get('OutputIntents') !== undefined) continue; // page-level intent satisfies it
    const grp = ctx.R(page.Dict.get('Group'));
    if (!isDict(grp) || nameOf(ctx, grp, 'S') !== 'Transparency') continue;
    if (grp.get('CS') === undefined) {
      issues.push({ rule: 'TransparencyBlendingSpace', severity: 'error', clause: 'ISO 19005-4 §6.2.9', page,
        message: 'Page declares a transparency group but neither the document nor the page has a PDF/A output intent and the group has no /CS blending colour space.' });
    }
  }
  return issues;
};
```

**Recorded limitation, and it belongs in the source as a comment on
`transparencyBlendingSpaceRule`:** "contains transparency" is detected from the
page's own `/Group /S /Transparency` declaration only. Transparency arising
solely from an ExtGState soft mask or a constant alpha below 1 is not attributed
to a page here, because `extGStates(ctx)` is document-wide. Add that comment.

Add all six to `RULES`, after `blendModeRule`:

```ts
  extGStateKeysRule, halftoneRule, imageKeysRule, formXObjectOpiRule,
  outputIntentKeysRule, transparencyBlendingSpaceRule,
```

- [ ] **Step 4b: Verify the `pdfaOutputIntentProfile` ordering**

`transparencyBlendingSpaceRule` calls `pdfaOutputIntentProfile`, which is defined above `outputIntentRule` in the file. Confirm the new rule is placed *after* that definition, or TypeScript's `const` hoisting rules will reject it.

- [ ] **Step 5: Run the tests and mutation-check**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS.

Mutation: drop `'HTO'` from the key loop (the `/HTO` case reddens); change `type !== 1 && type !== 5` to `false` (the halftone case reddens); drop the `pdfaOutputIntentProfile` early return in `transparencyBlendingSpaceRule` (the "accepts a group with an output intent" case reddens — this is the half that proves the rule is conditional rather than absolute). Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): PDF/A-4 graphics-state, image and output-intent rules

ExtGState /TR and /HTO prohibited with /TR2 only /Default; halftone types
limited to 1 and 5 with no /HalftoneName; image /Alternates, /OPI and
BitsPerComponent constrained (a mask must be 1 bit); Form XObject /OPI
prohibited; /DestOutputProfileRef prohibited and at most one PDF/A intent.

The blending-colour-space rule is CONDITIONAL - it bites only when the
document declares no PDF/A output intent - and that conditionality is
pinned from both sides, since an unconditional reading also passes the
positive case.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: ToUnicode CMap contents, appearance keys, widget actions and optional-content configs

**Files:**
- Modify: `src/pdfavalidate.ts` (four new rules + `RULES`, one import)
- Modify: `test/helpers/build-pdfa-pdf.ts` (two options)
- Test: `test/pdfa4-validate.test.ts`

**Interfaces:**
- Consumes: `parseCMap` from `./cmap.js`, `inflateStream` from `./flate.js` (already imported by `pdfavalidate.ts`).
- Produces: rules `ToUnicodeContent`, `AppearanceKeys`, `WidgetAction`, `OcConfig`. `PdfaOptions` gains `badToUnicode?: boolean`, `ocConfigNoName?: boolean`. Reuses `apWithDown` and `widgetWithAction` from Task 4.

- [ ] **Step 1: Write the failing test**

```ts
describe('ValidatePdfA — part 4 ToUnicode contents, appearances, OC', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);

  it('flags a ToUnicode CMap mapping to U+0000', () => {
    expect(errs(buildPdfaPdf({ type0: true, badToUnicode: true }, 4))).toContain('ToUnicodeContent');
  });
  it('accepts a well-formed ToUnicode CMap', () => {
    expect(errs(buildPdfaPdf({ type0: true }, 4))).not.toContain('ToUnicodeContent');
  });
  it('does not apply the content rule at parts 1-3', () => {
    expect(errs(buildPdfaPdf({ type0: true, badToUnicode: true }, 2), '2b'))
      .not.toContain('ToUnicodeContent');
  });
  it('flags an /AP holding more than /N', () => {
    expect(errs(buildPdfaPdf({ apWithDown: true }, 4))).toContain('AppearanceKeys');
  });
  it('flags a Widget annotation carrying /A', () => {
    expect(errs(buildPdfaPdf({ widgetWithAction: true }, 4))).toContain('WidgetAction');
  });
  it('flags an optional-content configuration with no /Name', () => {
    expect(errs(buildPdfaPdf({ ocConfigNoName: true }, 4))).toContain('OcConfig');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts -t "ToUnicode contents"`
Expected: FAIL.

- [ ] **Step 3: Add the fixture options**

Add to `PdfaOptions`:

```ts
  badToUnicode?: boolean;    // ToUnicode CMap mapping a code to U+0000
  ocConfigNoName?: boolean;  // /OCProperties /D with no /Name
```

The clean Type0 fixture currently writes an empty `/ToUnicode` stream (object 19). Replace that assignment so both shapes are real CMaps:

```ts
    if (!opts.omitToUnicode) {
      const uni = opts.badToUnicode ? '0000' : '0041';
      const cm = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n`
        + `1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n`
        + `1 beginbfchar\n<0001> <${uni}>\nendbfchar\n`
        + `endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
      objects[19] = `<< /Length ${byteLen(cm)} >>\nstream\n${cm}endstream`;
    }
```

For the OC config, replace the existing `optionalContent` catalog line so the two shapes differ:

```ts
  if (opts.optionalContent) catParts.push('/OCProperties << /OCGs [] /D << /Name (Default) >> >>');
  if (opts.ocConfigNoName) catParts.push('/OCProperties << /OCGs [] /D << >> >>');
```

- [ ] **Step 4: Add the four rules**

Add the import at the top of `src/pdfavalidate.ts`:

```ts
import { parseCMap } from './cmap.js';
```

Append above `RULES`:

```ts
// ---- PDF/A-4 ToUnicode contents, appearances, optional content -------------

/** ISO 19005-4 6.2.10.7-1. Note the direction: PDF/A-4 has NO /ToUnicode
 *  presence requirement (see toUnicodeRule) — this constrains the contents of
 *  a CMap that does exist. */
const toUnicodeContentRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  for (const { ref: object, dict } of enumerateFonts(ctx)) {
    const tu = ctx.R(dict.get('ToUnicode'));
    if (!isStream(tu)) continue;
    let entries: [number, string][];
    try {
      entries = parseCMap(inflateStream(tu)).entries();
    } catch {
      continue; // an unreadable CMap is not this rule's finding
    }
    for (const [code, value] of entries) {
      for (const ch of value) {
        const cp = ch.codePointAt(0);
        if (cp === 0x0000 || cp === 0xFEFF || cp === 0xFFFE) {
          issues.push({ rule: 'ToUnicodeContent', severity: 'error', clause: 'ISO 19005-4 §6.2.10.7', object,
            message: `ToUnicode CMap maps code ${code} to U+${cp.toString(16).toUpperCase().padStart(4, '0')}, which is prohibited.` });
          break;
        }
      }
    }
  }
  return issues;
};

const appearanceKeysRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const ap = ctx.R(dict.get('AP'));
    if (!isDict(ap)) return [];
    return [...ap.keys()].filter((k) => k !== 'N').map((k) => ({
      rule: 'AppearanceKeys', severity: 'error' as const, clause: 'ISO 19005-4 §6.3.3', object, page,
      message: `Appearance dictionary contains /${k}; PDF/A-4 permits only /N.`,
    }));
  });
};

const widgetActionRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) =>
    nameOf(ctx, dict, 'Subtype') === 'Widget' && dict.get('A') !== undefined
      ? [{ rule: 'WidgetAction', severity: 'error' as const, clause: 'ISO 19005-4 §6.4.1', object, page,
          message: 'Widget annotation carries an /A action; prohibited in PDF/A-4.' }]
      : []);
};

/** ISO 19005-4 6.10-1/-2. veraPDF's third test — /Order naming every OCG
 *  (6.10-3) — is deliberately NOT implemented: it needs a full walk of the OCG
 *  set against a nested order array, for a check no caller has asked for. */
const ocConfigRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const ocp = ctx.R(ctx.catalog.get('OCProperties'));
  if (!isDict(ocp)) return [];
  const configs: PdfDict[] = [];
  const d = ctx.R(ocp.get('D'));
  if (isDict(d)) configs.push(d);
  const alt = ctx.R(ocp.get('Configs'));
  if (isArray(alt)) for (const c of alt) { const cd = ctx.R(c); if (isDict(cd)) configs.push(cd); }
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const cfg of configs) {
    const nm = ctx.R(cfg.get('Name'));
    if (!isString(nm)) {
      issues.push({ rule: 'OcConfig', severity: 'error', clause: 'ISO 19005-4 §6.10',
        message: 'Optional-content configuration has no /Name.' });
      continue;
    }
    const key = new TextDecoder('latin1').decode(nm.bytes);
    if (seen.has(key)) {
      issues.push({ rule: 'OcConfig', severity: 'error', clause: 'ISO 19005-4 §6.10',
        message: `Optional-content configuration name '${key}' is not unique.` });
    }
    seen.add(key);
  }
  return issues;
};
```

`PdfString` is `{ readonly kind: 'string'; readonly bytes: Uint8Array }` (`src/types.ts:5`), so `.bytes` is correct as written, and `isString` is already in `pdfavalidate.ts`'s import list from `./types.js` — no import change is needed for this rule.

Note `ocConfigNoName` and `optionalContent` each push their own `/OCProperties` entry, so setting both would emit a duplicate key. No test does, and the builder makes no attempt to prevent it.

Add all four to `RULES`, after `toUnicodeRule` for the first and after `annotationOpacityRule` for the rest:

```ts
  toUnicodeContentRule,
```
```ts
  appearanceKeysRule, widgetActionRule, ocConfigRule,
```

- [ ] **Step 5: Run the tests and mutation-check**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS.

Mutation: change `cp === 0x0000` to `false` (the bad-ToUnicode case reddens); change `k !== 'N'` to `false` (the `/AP /D` case reddens); drop the `Widget` subtype test (the widget case reddens). Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): ToUnicode contents, appearance keys, widget actions, OC configs

Note the direction on ToUnicode: PDF/A-4 has no PRESENCE requirement, so
this constrains the contents of a CMap that exists - no U+0000, U+FEFF or
U+FFFE - read back through cmap.ts rather than a second parser.

Also /AP limited to /N, Widget annotations barred from carrying /A, and
optional-content configurations required to have unique /Name values.
veraPDF's 6.10-3 (/Order naming every OCG) is deliberately not
implemented and says so in the source.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Embedded files — the 4f allowance and the unverifiable warning

**Files:**
- Modify: `src/pdfavalidate.ts` (three new rules + `RULES`)
- Modify: `test/helpers/build-pdfa-pdf.ts` (one option)
- Test: `test/pdfa4-validate.test.ts`

**Interfaces:**
- Consumes: `allObjects(ctx)`.
- Produces: rules `EmbeddedFileSpec`, `EmbeddedFilesRequired`, `EmbeddedFileConformance`. `PdfaOptions` gains `embeddedFile?: 'full' | 'bare'`.

- [ ] **Step 1: Write the failing test**

```ts
describe('ValidatePdfA — part 4 embedded files', () => {
  const errs = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Errors.map((e) => e.rule);
  const warns = (bytes: Uint8Array, level: any = '4') =>
    Document.Open(bytes).ValidatePdfA(level).Warnings.map((e) => e.rule);

  it('flags a file specification missing /UF, /AFRelationship and /Subtype', () => {
    const r = errs(buildPdfaPdf({ embeddedFile: 'bare' }, 4));
    expect(r).toContain('EmbeddedFileSpec');
  });
  it('accepts a complete file specification', () => {
    expect(errs(buildPdfaPdf({ embeddedFile: 'full' }, 4))).not.toContain('EmbeddedFileSpec');
  });
  it('4f requires an /EmbeddedFiles name tree', () => {
    expect(errs(buildPdfaPdf({ pdfaConformance: 'F' }, 4), '4f')).toContain('EmbeddedFilesRequired');
    expect(errs(buildPdfaPdf({ pdfaConformance: 'F', embeddedFile: 'full' }, 4), '4f'))
      .not.toContain('EmbeddedFilesRequired');
  });
  it('base 4 does not require embedded files', () => {
    expect(errs(buildPdfaPdf({}, 4))).not.toContain('EmbeddedFilesRequired');
  });
  it('warns that an embedded file conformance is unverified at 4, silent at 4f', () => {
    expect(warns(buildPdfaPdf({ embeddedFile: 'full' }, 4))).toContain('EmbeddedFileConformance');
    expect(warns(buildPdfaPdf({ embeddedFile: 'full', pdfaConformance: 'F' }, 4), '4f'))
      .not.toContain('EmbeddedFileConformance');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfa4-validate.test.ts -t "embedded files"`
Expected: FAIL.

- [ ] **Step 3: Add the fixture option**

Add to `PdfaOptions`:

```ts
  embeddedFile?: 'full' | 'bare'; // /Names /EmbeddedFiles; 'bare' omits /UF, /AFRelationship, /Subtype
```

In the catalog block — note this must merge with the `alternatePresentations` `/Names` entry rather than emit a second `/Names` key:

```ts
  const nameTree: string[] = [];
  if (opts.alternatePresentations) nameTree.push('/AlternatePresentations << /Names [] >>');
  if (opts.embeddedFile) nameTree.push('/EmbeddedFiles << /Names [(a) 33 0 R] >>');
  if (nameTree.length) catParts.push(`/Names << ${nameTree.join(' ')} >>`);
```

Delete the earlier standalone `if (opts.alternatePresentations) catParts.push('/Names ...')` line added in Task 5, replacing it with the block above.

Alongside the other objects:

```ts
  if (opts.embeddedFile === 'full') {
    objects[33] = '<< /Type /Filespec /F (a.txt) /UF (a.txt) /AFRelationship /Data /EF << /F 34 0 R >> >>';
    objects[34] = '<< /Type /EmbeddedFile /Subtype /text#2Fplain /Length 1 >>\nstream\na\nendstream';
  }
  if (opts.embeddedFile === 'bare') {
    objects[33] = '<< /Type /Filespec /F (a.txt) /EF << /F 34 0 R >> >>';
    objects[34] = '<< /Type /EmbeddedFile /Length 1 >>\nstream\na\nendstream';
  }
```

- [ ] **Step 4: Add the three rules**

Append above `RULES`:

```ts
// ---- PDF/A-4 embedded files ------------------------------------------------

const embeddedFileSpecRule: Rule = (ctx) => {
  if (ctx.part !== 4) return [];
  const issues: ValidationIssue[] = [];
  for (const [object, obj] of allObjects(ctx)) {
    if (!isDict(obj)) continue;
    if (nameOf(ctx, obj, 'Type') !== 'Filespec' || obj.get('EF') === undefined) continue;
    // 6.9-2 and 6.9-4.
    for (const k of ['F', 'UF', 'AFRelationship']) {
      if (obj.get(k) === undefined) {
        issues.push({ rule: 'EmbeddedFileSpec', severity: 'error', clause: 'ISO 19005-4 §6.9', object,
          message: `Embedded-file specification has no /${k}.` });
      }
    }
    // 6.9-1: the stream itself must declare a MIME type.
    const ef = ctx.R(obj.get('EF'));
    if (!isDict(ef)) continue;
    for (const v of ef.values()) {
      const stream = ctx.R(v);
      if (isStream(stream) && stream.dict.get('Subtype') === undefined) {
        issues.push({ rule: 'EmbeddedFileSpec', severity: 'error', clause: 'ISO 19005-4 §6.9',
          object: isRef(v) ? v : object,
          message: 'Embedded file stream has no /Subtype MIME type.' });
      }
    }
  }
  return issues;
};

/** ISO 19005-4 6.9-5, and the one place PDF/A-4f DEMANDS something rather than
 *  relaxing something: a 4f file must actually carry an embedded file. */
const embeddedFilesRequiredRule: Rule = (ctx) => {
  if (ctx.part !== 4 || ctx.level !== 'f') return [];
  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('EmbeddedFiles') !== undefined) return [];
  return [{ rule: 'EmbeddedFilesRequired', severity: 'error', clause: 'ISO 19005-4 §6.9',
    message: 'A PDF/A-4f file must have an /EmbeddedFiles entry in the catalog name dictionary.' }];
};

/** ISO 19005-4 6.9-3 — base '4' only; 4e and 4f drop the rule, which is the
 *  whole point of 4f. We cannot decide it: recursive PDF/A validation of the
 *  embedded bytes is outside this validator's documented scope. Reported as a
 *  WARNING rather than passed over, because silence reads as 'we checked and it
 *  is fine', which is the one answer that is certainly wrong. */
const embeddedFileConformanceRule: Rule = (ctx) => {
  if (ctx.part !== 4 || ctx.level !== '') return [];
  const issues: ValidationIssue[] = [];
  for (const [object, obj] of allObjects(ctx)) {
    if (!isDict(obj)) continue;
    if (nameOf(ctx, obj, 'Type') !== 'Filespec' || obj.get('EF') === undefined) continue;
    issues.push({ rule: 'EmbeddedFileConformance', severity: 'warning', clause: 'ISO 19005-4 §6.9', object,
      message: 'PDF/A-4 requires every embedded file to conform to ISO 19005-1, -2 or -4; this validator does not verify embedded files.' });
  }
  return issues;
};
```

Add all three to the end of `RULES`:

```ts
  embeddedFileSpecRule, embeddedFilesRequiredRule, embeddedFileConformanceRule,
```

- [ ] **Step 5: Run the tests and mutation-check**

Run: `npx vitest run test/pdfa4-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts`
Expected: PASS.

Mutation: change `ctx.level !== 'f'` to `false` in `embeddedFilesRequiredRule` (the "base 4 does not require" case reddens); change `ctx.level !== ''` to `false` in `embeddedFileConformanceRule` (the "silent at 4f" case reddens). Both mutations target the *level* gating, which is what distinguishes the three conformances. Restore each.

- [ ] **Step 6: Commit**

```bash
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.1): PDF/A-4 embedded files, including the 4f allowance

File specifications must carry /F, /UF and /AFRelationship and the stream
a /Subtype MIME type. 4f is the one place PDF/A-4f DEMANDS something
rather than relaxing it: the file must actually carry an /EmbeddedFiles
name tree.

Clause 6.9-3 - embedded files must themselves be PDF/A - applies to base
'4' only and is not decidable here, so it draws a WARNING per file rather
than silence. Silence would read as 'we checked and it is fine'. 4e and 4f
drop the rule, which is what 4f exists for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Documentation, the recorded divergences, and the backport issue

**Files:**
- Modify: `README.md:61` area and `README.md:2594` area
- Modify: `CLAUDE.md` (the `structvalidate.ts` / `pdfavalidate.ts` bullet)
- Modify: `CHANGELOG.md`
- Modify: `src/pdfavalidate.ts` (the `psXObjectRule` divergence comment)

**Interfaces:**
- Consumes: everything above.
- Produces: no code surface.

- [ ] **Step 1: Record the `psXObjectRule` divergence in the source**

Add above `psXObjectRule` in `src/pdfavalidate.ts`:

```ts
/** Note, a deliberate divergence from the anchor: the veraPDF PDF/A-4 profile
 *  has NO PostScript-XObject rule, because PDF 2.0 removed the construct
 *  outright. This keeps firing at part 4 — it can only match something PDF 2.0
 *  does not define, so a hit is a real defect the profile happens not to
 *  enumerate. Recorded so it reads as a decision rather than an oversight. */
```

- [ ] **Step 2: Update `CHANGELOG.md`**

Under `## [Unreleased]` → `### Added` (create the heading if absent):

```markdown
- **PDF/A-4 validation** — `doc.ValidatePdfA('4' | '4e' | '4f')` checks the
  ISO 19005-4:2020 rule set. PDF/A-4 is a PDF 2.0-era standard whose rules are
  not a superset of parts 1–3: four checks this library makes at `'2u'` go
  **silent** at `'4'`, so a document can fail the older level and pass the newer
  one for the same reason. `/ToUnicode` is no longer required to be present
  (only constrained if it exists), `/CIDSet` has no rule at all, JavaScript
  actions are permitted, and `/Info` is near-banned — allowed only alongside a
  catalog `/PieceInfo` and then holding nothing but `/ModDate`, which supersedes
  the `/Info`-versus-XMP consistency check. New checks cover PDF 2.0 versioning,
  `pdfaid:rev`, the conformance-by-absence identification, `/Perms`,
  `/NeedsRendering`, `/Requirements`, alternate presentations, ExtGState `/TR`
  and `/HTO`, halftone types, image keys and bit depths, `/OPI`, output-intent
  keys, the transparency blending colour space, appearance keys, widget actions,
  optional-content configurations and embedded-file specifications. `'4e'`
  permits 3D and RichMedia annotations plus the `SetOCGState` and `GoTo3DView`
  actions; `'4f'` permits arbitrary embedded files and is the one conformance
  that *requires* the document to carry some. Conversion to part 4 is not yet
  supported and `ConvertToPdfA('4')` refuses rather than running part-2-shaped
  remediation. (72nc.1)
```

- [ ] **Step 3: Update `README.md`**

There is exactly **one** occurrence of the string `PDF/A-4 is not covered`, in the limitations paragraph at `README.md:2594`. Replace that clause (`; PDF/A-4 is not covered`) with a full stop, then append the paragraph below. Separately, the **conversion** bullet at `README.md:61` ends by describing `ConvertToPdfA` for parts 1–3 — append one sentence to it: `PDF/A-4 conversion is not supported; \`ConvertToPdfA('4')\` throws \`UnsupportedFeatureError\` rather than running part-2-shaped remediation, which would write a \`pdfaid:conformance\` that PDF/A-4 forbids.` Use this wording for the limitations paragraph:

```markdown
PDF/A-4 (ISO 19005-4:2020) is covered for `'4'`, `'4e'` and `'4f'`, with the
same curated posture: about twenty of its clauses are checked and roughly
twenty-five are not — ICC profile internals, glyph presence and widths inside
font programs, `.notdef` references, JPEG 2000 codestream internals, embedded
CMap internals, byte-level file structure (binary comment, xref EOL,
hex-string syntax, `obj`/`endobj` spacing, `/Length` accuracy, trailing bytes),
undefined content operators, UTF-8 name validity, ActualText private-use
values, DeviceN and Separation consistency, and CMYK overprint. Clause 6.9-3
(embedded files must themselves be PDF/A) is reported as a **warning** rather
than checked, since this validator does not recursively validate embedded
documents. The part-4 rules are transcribed from veraPDF's published
validation profiles; there is no runnable oracle in this repository, so a
passing report attests agreement with that transcription, not certified
ISO 19005-4 conformance.
```

- [ ] **Step 4: Update `CLAUDE.md`**

In the Source list bullet covering `structvalidate.ts`, `pdfavalidate.ts`, `pdfxvalidate.ts` and `validation.ts`, append these invariants:

```markdown
  **Invariant (`72nc.1`):** PDF/A-4 has NO accessibility level. ISO 19005-4 has
  no clause 6.8, so `'4a'` is *unrepresentable* rather than unsupported, and
  `validatePdfA`'s `lvl === 'a'` PDF/UA chain provably cannot fire at part 4.
  Expect "why doesn't PDF/A-4 check tagging" to be filed as a bug; it is the
  standard's decision, and tagging is declared separately through PDF/UA.
  **Invariant (`72nc.1`), and it is the trap:** PDF/A-4's rule set is NOT a
  superset of parts 1–3 — it INVERTS four rules, which must go SILENT at part 4.
  `/ToUnicode` has no presence requirement (only a content constraint if one
  exists); `/CIDSet` and `/CharSet` have no rule at all; JavaScript actions are
  PERMITTED; and `/Info` is near-banned, so the `/Info`-versus-XMP consistency
  check has nothing left to compare. A document that fails at `'2u'` can pass at
  `'4'` for the same reason. The `/ToUnicode` one contradicts the widespread
  "PDF/A-4 ≈ PDF/A-2u" folklore.
  **Invariant (`72nc.1`):** each inversion is pinned by a CROSS-PART PAIR in
  `test/pdfa4-validate.test.ts` — the fixture must report at its part-1/2/3 level
  AND stay silent at `'4'`. A single-part assertion provably cannot tell a rule
  that correctly went quiet from one that was never wired up, which is the
  failure mode this file is otherwise most exposed to.
  **Invariant (`72nc.1`):** the part-4 checks that ALSO apply to parts 1–3
  (`/Requirements`, `/NeedsRendering`, `/PresSteps`, `/TR`, `/HTO`, halftone
  types, `/Alternates`, `/OPI`, `BitsPerComponent`, filespec `/F`+`/UF`+
  `/AFRelationship`) are gated at `ctx.part === 4` DELIBERATELY, tracked as
  their own issue. Not tidiness: `ConvertToPdfA` re-runs `ValidatePdfA` and
  mirrors it into `unresolved`/`passed`, so widening a rule to parts 1–3
  silently changes the outcome of a shipped feature. `test/pdfavalidate.test.ts`
  and `test/pdfaconvert.test.ts` passing UNEDITED is the fence for that claim.
  **Note on the anchor, and it is a TRANSCRIPTION rather than a differential
  test:** the part-4 rules come from veraPDF's published validation profiles
  (`veraPDF/veraPDF-validation-profiles`, `integration` branch,
  `PDF_A/PDFA-4{,E,F}.xml`, fetched 2026-09-04). veraPDF is not installed and a
  profile is a rule list rather than bytes, so unlike `test/fixtures/pdfx/` there
  is NO runnable oracle. The suite proves the implementation agrees with our
  reading of the profile; it proves nothing about whether either matches
  ISO 19005-4. Do not read a green suite as conformance evidence.
  **Note, a deliberate divergence:** `psXObjectRule` fires at part 4 though the
  profile has no such rule, because PDF 2.0 removed PostScript XObjects — a hit
  can only be a real defect. `ocConfigRule` implements 6.10-1 and 6.10-2 but not
  6.10-3 (`/Order` naming every OCG), and `transparencyBlendingSpaceRule`
  detects transparency only from a page's own `/Group /S /Transparency`, not
  from an ExtGState soft mask. Both are recorded in the source.
```

- [ ] **Step 5: Verify the CLAUDE.md module sweep is still clean**

Run:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```

Expected: **empty output**. No new module was created by this plan, so this must stay clean. A non-empty result means a module lost its entry — fix it, do not ignore it.

- [ ] **Step 6: File the backport issue**

```bash
bd create "Backport the PDF/A-4 structural checks to parts 1-3" \
  -t task -p 2 \
  -d "72nc.1 gated ~15 checks at ctx.part === 4 that the PDF/A-2 and -3 profiles also carry: /Requirements, /NeedsRendering, /PresSteps, /AlternatePresentations, ExtGState /TR and /HTO, halftone types, image /Alternates and /OPI, BitsPerComponent, Form XObject /OPI, /DestOutputProfileRef, and filespec /F + /UF + /AFRelationship. Gating was deliberate: ConvertToPdfA re-runs ValidatePdfA and mirrors it into unresolved/passed, so widening a rule to parts 1-3 silently changes the outcome of a shipped feature. Backporting means deciding what to do about conversions that currently report clean and would stop doing so - check each against the veraPDF PDFA-2B/3B profiles first, since not all fifteen apply to every part."
```

- [ ] **Step 7: Full verification**

Run: `npm run typecheck && npm test`
Expected: both green, whole suite.

- [ ] **Step 8: Commit and close**

```bash
git add README.md CLAUDE.md CHANGELOG.md src/pdfavalidate.ts
git commit -m "docs(72nc.1): PDF/A-4 validation, its divergences and its ceiling

Records the four inversions and the cross-part-pair rule that pins them,
the deliberate part-4 gating of checks that also apply to parts 1-3 (and
why - ConvertToPdfA mirrors the validator), and the three divergences from
the anchor: psXObjectRule fires where the profile has no rule, OcConfig
skips 6.10-3, and the blending-space rule sees only page /Group.

States the ceiling plainly in both README and CLAUDE.md: the rules are a
transcription of veraPDF's profiles with no runnable oracle here, so a
passing report attests agreement with that transcription rather than
certified ISO 19005-4 conformance.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-72nc.1
git pull --rebase && git push && git status
```

---

## Notes for the executor

- **`test/pdfavalidate.test.ts` and `test/pdfaconvert.test.ts` are a fence, not a chore.** If either reddens, a part-1/2/3 rule moved. Stop and report which — do not edit those files to make them pass.
- **No import changes are needed except `parseCMap` (Task 7) and `UnsupportedFeatureError` (Task 1).** Verified: `Severity` is already imported from `./validation.js`, and `isString`, `isRef`, `isArray`, `isDict`, `isStream`, `isName`, `PdfDict`, `PdfObject`, `PdfRef` are all already imported from `./types.js` (`src/pdfavalidate.ts:2-4`). `inflateStream`, `enumerateFonts`, `extGStates`, `eachAnnotation`, `allObjects` and `pageScans` are likewise already in scope.
- **Object numbers in the fixture builder are a flat sparse array.** Tasks 4–8 claim 24–34. If a number collides with one already in use, pick the next free one and keep going; nothing depends on the specific values.
- **Rule ordering inside `RULES` does not affect correctness**, only the order findings appear in. Keep related rules adjacent for readability.
