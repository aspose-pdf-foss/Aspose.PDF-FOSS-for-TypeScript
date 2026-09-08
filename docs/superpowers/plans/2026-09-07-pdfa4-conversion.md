# PDF/A-4 conversion (`72nc.2`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.ConvertToPdfA('4' | '4e' | '4f')` remediates a document toward
ISO 19005-4:2020 and reports what it could not fix, instead of throwing
`UnsupportedFeatureError`.

**Architecture:** Part 4 joins the single `PASSES` array in `src/pdfaconvert.ts`
as a peer, gated with the `if (ctx.part === 4)` idiom the file already uses —
never a second `PASSES_A4` table. Six existing passes gain a part-4 branch, six
new part-4-only passes are appended, and one public type (`XmpMetadata.pdfaRev`)
is added so identification XMP can carry `pdfaid:rev="2020"`. Conversion
re-runs `ValidatePdfA(level)` and mirrors the result into
`unresolved`/`passed`, exactly as parts 1–3 do.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-pdfa4-conversion-design.md` — read
it alongside this plan.

---

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension
  (`import { name } from './types.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be green before any commit.
- **TDD.** Write the failing test, watch it fail, implement, watch it pass,
  commit. Every task follows that cycle.
- **The fence, and it is the acceptance criterion the spec names:**
  `test/pdfaconvert.test.ts`'s existing **21** `it` cases and
  `test/pdfavalidate.test.ts`'s **42** must stay green **unedited**. New part-4
  cases are *appended* to `test/pdfaconvert.test.ts` as new `describe` blocks;
  `git diff` on that file must show additions only.
- **One test in `test/pdfa4-validate.test.ts` must be replaced**, and it is the
  only pre-existing case this work may touch: `'refuses to convert to part 4
  rather than running part-2 remediation'` (line ~20) asserts the
  `UnsupportedFeatureError` that Task 2 removes. That file has 54 cases; the
  other 53 stay green unedited.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**
  (see the repo's `CLAUDE.md`): a bold lead-in, then prose saying what it does,
  why the design went that way, and what was measured, with `(72nc.2)` at the
  end.
- **Issue tracking is `bd`**, never TodoWrite or a markdown checklist. Run
  `bd prime` for the command reference.
- **Commit message style:** `feat(72nc.2): <subject>` /
  `test(72nc.2): …` / `docs(72nc.2): …`, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **The oracle is circular and must be described that way in every doc you
  write.** veraPDF is not installed. Conversion is verified against *our own*
  validator, itself a transcription of veraPDF's published profiles. A green
  suite attests that the two halves agree with each other, not that either
  matches ISO 19005-4.

---

## Divergences from the spec, and why

The spec is unchanged and travels with this plan. Three of its statements do
not survive contact with the validator `72nc.1` shipped; each is implemented as
described below and must be recorded in the code comments and in `CLAUDE.md`.

**1. `infoPass` cannot merely reduce `/Info` to `/ModDate`.** The spec says
that is "legal without a `/PieceInfo`". Measured against
`infoRestrictionRule` (`src/pdfavalidate.ts:963`), it is not: the rule reports
whenever the trailer has an `/Info` **and** the catalog has no `/PieceInfo`,
whatever the dictionary holds — `test/pdfa4-validate.test.ts:143` pins exactly
that, with an `/Info` holding only `/ModDate`. Reducing alone therefore leaves
`InfoRestriction` unresolved for every real document, and *no* part-4
conversion could ever report `passed === true`.

So `infoPass` does both, branching on what makes the dictionary legal:

| catalog | action |
|---|---|
| has `/PieceInfo` | keep `/Info`, delete every key but `/ModDate` — the spec's rule, where it works |
| no `/PieceInfo` | delete `/Info` and its object outright |

The spec rejected deletion because "it discards `/ModDate` too". This plan
answers that objection rather than ignoring it: `identificationPass` mirrors
`/ModDate` into XMP `xmp:ModifyDate` (at part 4 only) *before* `infoPass` runs,
alongside the title/author/subject/keywords mirror it already performs. Probed
end to end on a fixture with `/Info /Title 'Real Title'`: after the two passes
the document validates clean at `'4'` and `doc.GetXmp().title` is still
`'Real Title'`.

**2. `infoPass` is mandatory even for a document that never had an `/Info`.**
The spec does not anticipate this. `Document.SetXmp` (`src/document.ts:1531`)
calls `ensureInfo()` **unconditionally**, so `identificationPass` itself creates
an empty `/Info` and sets the trailer entry. Measured: `SetXmp({ pdfaPart: 4 })`
on the clean part-4 fixture — which has no `/Info` at all — produces
`InfoRestriction`. Task 3 pins this with its own case.

**3. Two smaller corrections.** The spec cites `3zpi` for the parts-1–3
backport issue; the real id is **`pjy7`** ("Backport the PDF/A-4 structural
checks to parts 1-3"). And the spec's pass table omits the part-4 `/AA`
restriction: `additionalActionsRule` bans any `/AA` key outside
`E, X, D, U, Fo, Bl` at part 4 (exempting Widgets), which parts 1–3 do not
police that way, so `actionsPass` gains that branch in Task 9 or the
`AdditionalActions` rule is mechanically fixable and left unfixed.

**Reported, never fixed** (beyond the spec's own list of `EmbeddedFilesRequired`,
`ImageKeys`, `Halftone` and `ToUnicodeContent`): a `/Named` action outside
`NextPage`/`PrevPage`/`FirstPage`/`LastPage`. Removing it would silently drop
navigation the author asked for, and no fixture in the builder produces one.

---

## File Structure

**Modified:**

- `src/xmp.ts` — `XmpMetadata.pdfaRev`, parsed in `readXmp`, emitted by
  `buildXmp`. The only public API addition in this issue.
- `src/pdfaconvert.ts` — everything else. `Cctx` widens, `ConvertCategory`
  gains `'info'`, the part-4 refusal comes out, six passes gain a part-4 branch
  and six new passes are appended to `PASSES`.
- `test/helpers/build-pdfa-pdf.ts` — six additive `PdfaOptions` members
  (`infoWithModDate`, `tr2ExtGState`, `imageOpi`, `twoPdfaOutputIntents`,
  `launchAction`, `setOcgStateAction`). Additive only: no existing option's
  meaning or emitted bytes may change, or `test/pdfa4-validate.test.ts`'s other
  53 cases move.
- `test/pdfaconvert.test.ts` — new `describe` blocks appended.
- `test/xmp.test.ts` — `pdfaid:rev` round-trip cases.
- `test/pdfa4-validate.test.ts` — the one obsolete refusal case replaced.
- `README.md`, `CLAUDE.md`, `CHANGELOG.md`.

**Created:** nothing. Every new pass is a `Pass` in the file that owns the
others; a second module would split the `PASSES` array across two files.

---

### Task 1: `XmpMetadata.pdfaRev`

**Files:**
- Modify: `src/xmp.ts` (interface at :12-25, `readXmp` at :150-166,
  `buildXmp`'s `pdfaDesc` at :232-238)
- Test: `test/xmp.test.ts` (append to the `describe('xmp pdfaid')` block at :210)

**Interfaces:**
- Consumes: nothing.
- Produces: `XmpMetadata.pdfaRev?: number` — readable via `doc.GetXmp().pdfaRev`,
  writable via `doc.SetXmp({ pdfaRev: 2020 })` (and `null` to delete, through
  the existing `XmpUpdate` mapped type). Task 2 writes it.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('xmp pdfaid', …)` block in
`test/xmp.test.ts`:

```ts
  it('round-trips pdfaid:rev', () => {
    const packet = buildXmp({ pdfaPart: 4, pdfaRev: 2020 });
    expect(packet).toContain('pdfaid:rev="2020"');
    const back = readXmp(new TextEncoder().encode(packet));
    expect(back.pdfaPart).toBe(4);
    expect(back.pdfaRev).toBe(2020);
  });

  it('emits no pdfaid:rev when it is unset', () => {
    // Parts 1-3 have no rev property at all; a packet rebuilt for one must not
    // grow the attribute, which is what keeps the parts-1-3 fence still.
    expect(buildXmp({ pdfaPart: 2, pdfaConformance: 'B' })).not.toContain('pdfaid:rev');
  });

  it('emits a pdfaid block for a rev with no part or conformance', () => {
    expect(buildXmp({ pdfaRev: 2020 })).toContain('pdfaid:rev="2020"');
  });

  it('reads pdfaid:rev written in element form', () => {
    const xml = '<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">'
      + '<pdfaid:part>4</pdfaid:part><pdfaid:rev>2020</pdfaid:rev></rdf:Description>';
    expect(readXmp(new TextEncoder().encode(xml)).pdfaRev).toBe(2020);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/xmp.test.ts`
Expected: FAIL — `pdfaRev` is not a property of `XmpMetadata` (a typecheck
error inside the test), and the built packet contains no `pdfaid:rev`.

- [ ] **Step 3: Add the field to the interface**

In `src/xmp.ts`, beside `pdfaConformance` (line ~16):

```ts
  pdfaConformance?: string;       // pdfaid:conformance (A/B/U)
  pdfaRev?: number;               // pdfaid:rev (PDF/A-4 identification; 2020)
```

- [ ] **Step 4: Parse it in `readXmp`**

After the `confAttr` block (line ~160), matching the shape of its neighbours —
attribute form first, element form as the fallback:

```ts
  // ISO 19005-4 6.7.3-5 requires pdfaid:rev="2020"; parts 1-3 have no rev
  // property at all, so an absent one stays absent rather than defaulting.
  const revAttr = /pdfaid:rev\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfaid:rev>\s*([^<]+?)\s*<\/pdfaid:rev>/.exec(raw);
  if (revAttr) meta.pdfaRev = Number(revAttr[1].trim());
```

- [ ] **Step 5: Emit it in `buildXmp`**

Replace the `pdfaDesc` block (line ~232):

```ts
  const pdfaDesc = (meta.pdfaPart !== undefined || meta.pdfaConformance !== undefined
    || meta.pdfaRev !== undefined)
    ? `\n  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"`
      + (meta.pdfaPart !== undefined ? ` pdfaid:part="${meta.pdfaPart}"` : '')
      + (meta.pdfaConformance !== undefined ? ` pdfaid:conformance="${escapeXml(meta.pdfaConformance)}"` : '')
      + (meta.pdfaRev !== undefined ? ` pdfaid:rev="${meta.pdfaRev}"` : '')
      + `/>`
    : '';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/xmp.test.ts test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS, all files. The three older files are the fence — `readXmp` now
surfaces `pdfaid:rev`, so a *rebuilt* packet preserves it where it used to be
dropped; no parts-1–3 fixture declares one, so nothing moves.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/xmp.ts test/xmp.test.ts
git commit -m "feat(72nc.2): XmpMetadata.pdfaRev for PDF/A-4 identification"
```

---

### Task 2: Accept part 4 — types, entry point, identification, version

**Files:**
- Modify: `src/pdfaconvert.ts` (`ConvertCategory` :14-15, `Cctx` :24-32,
  `convertToPdfA` :37-58, `identificationPass` :70-84, `versionPass` :86-96)
- Modify: `test/pdfa4-validate.test.ts` (replace the case at :20-23)
- Test: `test/pdfaconvert.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `XmpMetadata.pdfaRev` (Task 1).
- Produces:
  - `Cctx.part: 1 | 2 | 3 | 4` and
    `Cctx.level: 'b' | 'u' | 'a' | '' | 'e' | 'f'` — every later task's pass
    branches on these.
  - `ConvertCategory` gains `'info'` (consumed in Task 3).
  - `convertToPdfA(doc, catalog, level, opts)` no longer throws for part 4.
  - Module-private `conformanceUpdate(ctx: Cctx): string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pdfaconvert.test.ts`:

```ts
describe('ConvertToPdfA — part 4 identification and version', () => {
  const errs = (d: Document, lvl: any) => d.ValidatePdfA(lvl).Errors.map((e) => e.rule);

  it('writes pdfaid part 4 with rev 2020 and NO conformance at the base level', () => {
    const doc = open(buildPdfaPdf({ headerVersion: '1.7' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('PdfaIdentification');
    const xmp = doc.GetXmp();
    expect(xmp.pdfaPart).toBe(4);
    expect(xmp.pdfaRev).toBe(2020);
    expect(xmp.pdfaConformance).toBeUndefined();  // 6.7.3-3: spelled by ABSENCE
    expect(errs(doc, '4')).not.toContain('PdfaIdentification');
  });

  it('writes conformance E at 4e and F at 4f', () => {
    const e = open(buildPdfaPdf({}, 4));
    e.ConvertToPdfA('4e');
    expect(e.GetXmp().pdfaConformance).toBe('E');
    expect(errs(e, '4e')).not.toContain('PdfaIdentification');

    const f = open(buildPdfaPdf({ embeddedFile: 'full' }, 4));
    f.ConvertToPdfA('4f');
    expect(f.GetXmp().pdfaConformance).toBe('F');
    expect(errs(f, '4f')).not.toContain('PdfaIdentification');
  });

  it('deletes a stray pdfaid:conformance when converting to the base level', () => {
    const doc = open(buildPdfaPdf({ pdfaConformance: 'B' }, 4));
    doc.ConvertToPdfA('4');
    expect(doc.GetXmp().pdfaConformance).toBeUndefined();
    expect(errs(doc, '4')).not.toContain('PdfaIdentification');
  });

  it('declares PDF 2.0, so the saved header satisfies the part-4 version rule', () => {
    const doc = open(buildPdfaPdf({ headerVersion: '1.7' }, 4));
    doc.ConvertToPdfA('4');
    const saved = doc.Save();
    expect(new TextDecoder('latin1').decode(saved.subarray(0, 8))).toBe('%PDF-2.0');
    expect(open(saved).ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('Version');
  });

  it('leaves the part 1 and part 2 version ceilings alone', () => {
    const d1 = open(buildPdfaPdf({ headerVersion: '1.4' }, 1));
    d1.ConvertToPdfA('1b');
    expect(new TextDecoder('latin1').decode(d1.Save().subarray(0, 8))).toBe('%PDF-1.4');
    const d2 = open(buildPdfaPdf({}, 2));
    d2.ConvertToPdfA('2b');
    expect(new TextDecoder('latin1').decode(d2.Save().subarray(0, 8))).toBe('%PDF-1.7');
  });
});
```

And replace the obsolete refusal case in `test/pdfa4-validate.test.ts`
(remove the `UnsupportedFeatureError` import if it becomes unused there):

```ts
  it('converts to part 4 rather than refusing', () => {
    const doc = Document.Open(buildPdfaPdf({}, 4));
    const report = doc.ConvertToPdfA('4');
    expect(Array.isArray(report.applied)).toBe(true);
    expect(typeof report.passed).toBe('boolean');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfa4-validate.test.ts`
Expected: FAIL — `UnsupportedFeatureError: PDF/A-4 conversion is not supported`.

- [ ] **Step 3: Widen the types and drop the refusal**

In `src/pdfaconvert.ts`:

```ts
export type ConvertCategory =
  | 'javascript' | 'multimedia' | 'embeddedFiles' | 'xfa' | 'optionalContent'
  | 'postScript' | 'info';
```

```ts
export interface Cctx {
  doc: Document;
  catalog: PdfDict;
  part: 1 | 2 | 3 | 4;
  level: 'b' | 'u' | 'a' | '' | 'e' | 'f';
  preserve: Set<ConvertCategory>;
  icc: { bytes: Uint8Array; n: 1 | 3 | 4; identifier: string };
  R(o: PdfObject | undefined): PdfObject;
}
```

In `convertToPdfA`, delete the whole `if (part === 4) { throw … }` block and its
comment, and drop the cast:

```ts
  const ctx: Cctx = {
    doc, catalog, part, level: lvl,
    preserve: new Set(opts.preserve ?? []),
    icc: { bytes: ic.bytes, n: ic.n, identifier: ic.identifier ?? 'Custom' },
    R: (o) => doc.resolve(o),
  };
```

Remove the now-unused `import { UnsupportedFeatureError } from './errors.js';`.

- [ ] **Step 4: Make `identificationPass` part-4 shaped**

Replace `identificationPass` and add the helper above it:

```ts
/** The pdfaid:conformance to write. PDF/A-4's base conformance is spelled by
 *  ABSENCE (ISO 19005-4 6.7.3-3), and `null` is how mergeXmp deletes a field —
 *  `ctx.level.toUpperCase()` would write `pdfaid:conformance=""`, which is the
 *  precise thing the part-4 refusal this replaces existed to prevent. */
function conformanceUpdate(ctx: Cctx): string | null {
  if (ctx.part !== 4) return ctx.level.toUpperCase();       // 'B' | 'U' | 'A'
  return ctx.level === '' ? null : ctx.level.toUpperCase(); // 'E' | 'F'
}

/** Write identification XMP (pdfaid + /Info mirror) via the facade.
 *
 *  Ordering invariant: this MUST run before infoPass. It reads /Info through
 *  GetMetadata() to mirror the fields into XMP, and at part 4 infoPass then
 *  strips or deletes that dictionary — strip it first and the mirror silently
 *  comes out empty, a loss invisible in the converted file, which validates
 *  either way. The /ModDate mirror is part-4 ONLY, because it exists to rescue
 *  the one field PDF/A-4 would otherwise permit and this conversion removes;
 *  mirroring it at parts 1-3 would move bytes for every existing caller. */
const identificationPass: Pass = (ctx) => {
  const conf = conformanceUpdate(ctx);
  const info = ctx.doc.GetMetadata();
  ctx.doc.SetXmp({
    pdfaPart: ctx.part,
    pdfaConformance: conf,
    ...(ctx.part === 4 ? { pdfaRev: 2020 } : {}),
    ...(info.title !== undefined ? { title: info.title } : {}),
    ...(info.author !== undefined ? { authors: [info.author] } : {}),
    ...(info.subject !== undefined ? { description: info.subject } : {}),
    ...(info.keywords !== undefined ? { keywords: info.keywords } : {}),
    ...(ctx.part === 4 && info.modDate !== undefined ? { modifyDate: info.modDate } : {}),
  });
  const idPart = conf === null ? `part ${ctx.part} (no conformance)` : `part ${ctx.part}/conformance ${conf}`;
  return [{ rule: 'PdfaIdentification', action: `Wrote pdfaid:${idPart}${ctx.part === 4 ? '/rev 2020' : ''} and mirrored /Info into XMP.` }];
};
```

- [ ] **Step 5: Make `versionPass` part-4 shaped**

```ts
/** Declare the part's version in the catalog. This is unconditional: the
 *  serializer emits the catalog /Version as the `%PDF-x.y` header and defaults
 *  to 1.7 without it, so a converted file would otherwise breach its own rule
 *  no matter what the input header said.
 *
 *  Note part 4 is NOT a ceiling but an exact major (ISO 19005-4 6.1.2-1): a
 *  perfectly good PDF 1.7 file is simply not PDF/A-4, so the value is raised
 *  here where parts 1-3 lower it. */
const versionPass: Pass = (ctx) => {
  const target = ctx.part === 4 ? '2.0' : ctx.part === 1 ? '1.4' : '1.7';
  if (nameOf(ctx, ctx.catalog, 'Version') === target) return [];
  ctx.catalog.set('Version', name(target));
  return [{ rule: 'Version', action: `Set catalog /Version to ${target}.` }];
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfa4-validate.test.ts test/pdfavalidate.test.ts`
Expected: PASS. The part-4 documents still report `InfoRestriction` (Task 3
closes that); none of these cases asserts `passed`.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts test/pdfa4-validate.test.ts
git commit -m "feat(72nc.2): accept PDF/A-4 in ConvertToPdfA; part-4 identification and version"
```

---

### Task 3: `infoPass` and the `'info'` preserve category

**Files:**
- Modify: `src/pdfaconvert.ts` (new pass + `PASSES`)
- Modify: `test/helpers/build-pdfa-pdf.ts` (one additive option)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Cctx.part`/`.level`/`.preserve` and `ConvertCategory` `'info'`
  (Task 2); `identificationPass`'s `/ModDate` mirror (Task 2).
- Produces: `infoPass`, placed **last** in `PASSES`. Later tasks append their
  passes *before* it.
- Produces: `PdfaOptions.infoWithModDate?: boolean` in the fixture builder.

- [ ] **Step 1: Add the fixture option**

In `test/helpers/build-pdfa-pdf.ts`, beside `infoModDateOnly` in the interface:

```ts
  infoModDateOnly?: boolean;  // /Info holds only /ModDate instead of /Title
  infoWithModDate?: boolean;  // /Info holds /Title AND /ModDate (part-4 conversion)
```

and in the `// info` block near the end of `buildPdfaPdf`:

```ts
  if (infoTitle !== null) {
    objects[infoNum] = opts.infoModDateOnly
      ? '<< /ModDate (D:20260904000000Z) >>'
      : opts.infoWithModDate
        ? `<< /Title (${infoTitle}) /ModDate (D:20260904000000Z) >>`
        : `<< /Title (${infoTitle}) >>`;
  }
```

- [ ] **Step 2: Write the failing tests**

Append to `test/pdfaconvert.test.ts`:

```ts
describe('ConvertToPdfA — part 4 /Info', () => {
  const rules = (d: Document, lvl: any = '4') => d.ValidatePdfA(lvl).Errors.map((e) => e.rule);

  it('removes /Info when the catalog has no /PieceInfo, having mirrored it into XMP first', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Real Title' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('InfoRestriction');
    expect(doc.trailer.get('Info')).toBeUndefined();
    // The ordering invariant: identificationPass must have run FIRST, or this
    // title is gone. A fixture whose /Info is already absent measures nothing.
    expect(doc.GetXmp().title).toBe('Real Title');
    expect(rules(doc)).not.toContain('InfoRestriction');
  });

  it('reduces /Info to /ModDate when the catalog has a /PieceInfo', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Real Title', infoWithModDate: true, pieceInfo: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('InfoRestriction');
    expect(doc.trailer.get('Info')).toBeDefined();
    const meta = doc.GetMetadata();
    expect(meta.title).toBeUndefined();
    expect(meta.modDate).toBeDefined();
    expect(doc.GetXmp().title).toBe('Real Title');
    expect(rules(doc)).not.toContain('InfoRestriction');
  });

  it('removes the empty /Info that writing identification XMP itself creates', () => {
    // SetXmp calls ensureInfo() unconditionally, so identificationPass creates
    // an /Info even for a document that had none - and an /Info with no
    // /PieceInfo is an InfoRestriction error however empty it is.
    const doc = open(buildPdfaPdf({}, 4));
    expect(doc.trailer.get('Info')).toBeUndefined();
    doc.ConvertToPdfA('4');
    expect(doc.trailer.get('Info')).toBeUndefined();
    expect(rules(doc)).not.toContain('InfoRestriction');
  });

  it('preserve: [info] keeps /Info and reports it unresolved', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Real Title' }, 4));
    const report = doc.ConvertToPdfA('4', { preserve: ['info'] });
    expect(report.applied.map((a) => a.rule)).not.toContain('InfoRestriction');
    expect(doc.trailer.get('Info')).toBeDefined();
    expect(report.unresolved.map((i) => i.rule)).toContain('InfoRestriction');
  });

  it('leaves /Info alone at parts 1-3', () => {
    const doc = open(buildPdfaPdf({ infoTitle: 'Keep me' }, 2));
    doc.ConvertToPdfA('2b');
    expect(doc.GetMetadata().title).toBe('Keep me');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — `/Info` survives and `InfoRestriction` is still reported.

- [ ] **Step 4: Implement `infoPass`**

Add to `src/pdfaconvert.ts`, after `versionPass`:

```ts
/** PDF/A-4 near-bans the document information dictionary: ISO 19005-4 6.1.3-4
 *  permits /Info only alongside a catalog /PieceInfo, and 6.1.3-5 then allows
 *  it to hold nothing but /ModDate. Essentially every real document carries a
 *  title, author, producer and dates, so converting one to PDF/A-4 destroys
 *  that dictionary; the `'info'` category is how a caller declines the trade
 *  and takes an unresolved InfoRestriction instead.
 *
 *  Note the two branches are NOT alternatives to pick between. Reducing to
 *  /ModDate is legal ONLY beside a /PieceInfo: infoRestrictionRule reports a
 *  present /Info without one whatever it holds, so a reduce-only pass could
 *  never reach passed === true for a document that has no /PieceInfo. Deleting
 *  discards nothing, because identificationPass has already mirrored the title,
 *  author, subject, keywords AND /ModDate into XMP - which is where PDF 2.0
 *  wants them, and why identificationPass must run first. */
const infoPass: Pass = (ctx) => {
  if (ctx.part !== 4 || ctx.preserve.has('info')) return [];
  const infoObj = ctx.doc.trailer.get('Info');
  if (infoObj === undefined) return [];
  const info = ctx.R(infoObj);
  if (!isDict(info)) return [];
  const object = isRef(infoObj) ? infoObj : undefined;

  if (ctx.catalog.get('PieceInfo') !== undefined) {
    const dropped = [...info.keys()].filter((k) => k !== 'ModDate');
    if (dropped.length === 0) return [];
    for (const k of dropped) info.delete(k);
    return [{ rule: 'InfoRestriction', object,
      action: `Reduced /Info to /ModDate (dropped ${dropped.map((k) => `/${k}`).join(', ')}).` }];
  }

  ctx.doc.trailer.delete('Info');
  if (isRef(infoObj)) ctx.doc.deleteObject(infoObj.num);
  return [{ rule: 'InfoRestriction', action:
    'Removed the document information dictionary (PDF/A-4 permits one only alongside a catalog /PieceInfo); its fields were mirrored into XMP first.' }];
};
```

- [ ] **Step 5: Put it last in `PASSES`**

```ts
const PASSES: Pass[] = [
  identificationPass, versionPass, fileIdPass, outputIntentPass,
  annotationFlagsPass, formsPass, cosmeticPass,
  actionsPass, multimediaPass, xfaPass, optionalContentPass, embeddedFilesPass, postScriptPass,
  toUnicodePass,
  // LAST, and deliberately: identificationPass reads /Info through
  // GetMetadata() and SetXmp's mirror writes it back, so anything that strips
  // /Info must follow every pass that could touch it.
  infoPass,
];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts test/helpers/build-pdfa-pdf.ts
git commit -m "feat(72nc.2): infoPass - PDF/A-4's /Info restriction, behind a preserve category"
```

---

### Task 4: `pdfa4CatalogPass`

**Files:**
- Modify: `src/pdfaconvert.ts`
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Cctx`, `nameOf`, the `ConvertAction` shape.
- Produces: `pdfa4CatalogPass`, inserted into `PASSES` after `toUnicodePass`
  and before `infoPass`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pdfaconvert.test.ts`:

```ts
describe('ConvertToPdfA — part 4 catalog', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };

  it('removes catalog /NeedsRendering', () => {
    const r = conv({ needsRendering: true });
    expect(r.applied).toContain('NeedsRendering');
    expect(r.errors).not.toContain('NeedsRendering');
  });

  it('removes catalog /Requirements', () => {
    const r = conv({ requirements: true });
    expect(r.applied).toContain('Requirements');
    expect(r.errors).not.toContain('Requirements');
  });

  it('removes /Names /AlternatePresentations and page /PresSteps', () => {
    const r = conv({ alternatePresentations: true, presSteps: true });
    expect(r.applied.filter((x) => x === 'AlternatePresentations').length).toBe(2);
    expect(r.errors).not.toContain('AlternatePresentations');
  });

  it('removes a /Perms key other than /DocMDP and keeps /DocMDP', () => {
    const r = conv({ perms: 'bad' });
    expect(r.applied).toContain('Permissions');
    expect(r.errors).not.toContain('Permissions');
    const perms = r.doc.resolve(r.doc.catalog().get('Perms')) as PdfDict;
    expect([...perms.keys()]).toEqual(['DocMDP']);
  });

  it('leaves these catalog keys alone at parts 1-3', () => {
    const doc = open(buildPdfaPdf({ needsRendering: true, requirements: true, perms: 'bad' }, 2));
    doc.ConvertToPdfA('2b');
    expect(doc.catalog().get('NeedsRendering')).toBeDefined();
    expect(doc.catalog().get('Requirements')).toBeDefined();
  });
});
```

Add `import type { PdfDict } from '../src/types.js';` to the test file's imports
if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — `NeedsRendering`, `Requirements`, `AlternatePresentations` and
`Permissions` are all still reported.

- [ ] **Step 3: Implement the pass**

```ts
/** ISO 19005-4's catalog prohibitions: /NeedsRendering (6.4.2), /Requirements
 *  (6.12), /Names /AlternatePresentations and page /PresSteps (6.11), and every
 *  /Perms key but /DocMDP (6.1.11). All are non-destructive to page content -
 *  they name behaviour a conforming reader must not have - so none of them is
 *  gated on a preserve category. */
const pdfa4CatalogPass: Pass = (ctx) => {
  if (ctx.part !== 4) return [];
  const actions: ConvertAction[] = [];

  for (const key of ['NeedsRendering', 'Requirements'] as const) {
    if (ctx.catalog.get(key) !== undefined) {
      ctx.catalog.delete(key);
      actions.push({ rule: key, action: `Removed catalog /${key}.` });
    }
  }

  const names = ctx.R(ctx.catalog.get('Names'));
  if (isDict(names) && names.get('AlternatePresentations') !== undefined) {
    names.delete('AlternatePresentations');
    actions.push({ rule: 'AlternatePresentations', action: 'Removed /Names /AlternatePresentations.' });
  }
  for (const page of ctx.doc.Pages) {
    if (page.Dict.get('PresSteps') !== undefined) {
      page.Dict.delete('PresSteps');
      actions.push({ rule: 'AlternatePresentations', action: 'Removed page /PresSteps.', page });
    }
  }

  const perms = ctx.R(ctx.catalog.get('Perms'));
  if (isDict(perms)) {
    for (const k of [...perms.keys()]) {
      if (k === 'DocMDP') continue;
      perms.delete(k);
      actions.push({ rule: 'Permissions', action: `Removed catalog /Perms /${k}.` });
    }
    if (perms.size === 0) ctx.catalog.delete('Perms');
  }
  return actions;
};
```

- [ ] **Step 4: Register it in `PASSES`**

```ts
  toUnicodePass,
  pdfa4CatalogPass,
  infoPass,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(72nc.2): pdfa4CatalogPass - NeedsRendering, Requirements, AlternatePresentations, Perms"
```

---

### Task 5: `pdfa4GraphicsPass`

**Files:**
- Modify: `src/pdfaconvert.ts`
- Modify: `test/helpers/build-pdfa-pdf.ts` (two additive options)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: the module-private `extGStates(ctx)` (`src/pdfaconvert.ts:167`) and
  `ctx.doc.objectEntries()`.
- Produces: `pdfa4GraphicsPass`, registered after `pdfa4CatalogPass`.
- Produces: `PdfaOptions.tr2ExtGState?: boolean`, `PdfaOptions.imageOpi?: boolean`.

- [ ] **Step 1: Add the fixture options**

In `test/helpers/build-pdfa-pdf.ts`, in the interface beside `trExtGState`:

```ts
  tr2ExtGState?: boolean;       // ExtGState with a /TR2 that is not /Default
  imageOpi?: boolean;           // image XObject with /OPI
```

in the ExtGState block:

```ts
  if (opts.tr2ExtGState) egs.push('/GS2 << /Type /ExtGState /TR2 /Identity >>');
```

in the XObject block and object table (object 35 is free):

```ts
  if (opts.imageOpi) xobjs.push('/ImgO 35 0 R');
```
```ts
  if (opts.imageOpi) objects[35] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /OPI << >> /Length 1 >>\nstream\n\x00\nendstream';
```

- [ ] **Step 2: Write the failing tests**

Append to `test/pdfaconvert.test.ts`:

```ts
describe('ConvertToPdfA — part 4 graphics', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };

  it('removes ExtGState /TR and /HTO', () => {
    const r = conv({ trExtGState: true, htoExtGState: true });
    expect(r.applied.filter((x) => x === 'ExtGStateKeys').length).toBe(2);
    expect(r.errors).not.toContain('ExtGStateKeys');
  });

  it('forces a non-/Default /TR2 to /Default rather than deleting it', () => {
    const r = conv({ tr2ExtGState: true });
    expect(r.applied).toContain('ExtGStateKeys');
    expect(r.errors).not.toContain('ExtGStateKeys');
    const res = r.doc.resolve(r.doc.Pages[0].Resources) as PdfDict;
    const egs = r.doc.resolve(res.get('ExtGState')) as PdfDict;
    const gs = r.doc.resolve(egs.get('GS2')) as PdfDict;
    expect(gs.get('TR2')).toEqual({ kind: 'name', name: 'Default' });
  });

  it('removes /HalftoneName', () => {
    const r = conv({ halftoneName: true });
    expect(r.applied).toContain('Halftone');
    expect(r.errors).not.toContain('Halftone');
  });

  it('reports a prohibited halftone type rather than forcing it to 1', () => {
    // Forcing the type would change how the page prints; reporting beats that.
    const r = conv({ badHalftone: true });
    expect(r.applied).not.toContain('Halftone');
    expect(r.errors).toContain('Halftone');
  });

  it('removes image /Alternates, image /OPI and Form XObject /OPI', () => {
    const r = conv({ imageAlternates: true, imageOpi: true, formOpi: true });
    expect(r.errors).not.toContain('ImageKeys');
    expect(r.errors).not.toContain('FormXObjectOpi');
  });

  it('reports a bad /BitsPerComponent rather than re-encoding the image', () => {
    const r = conv({ badBitsPerComponent: true });
    expect(r.errors).toContain('ImageKeys');
  });

  it('leaves ExtGState /TR alone at parts 1-3', () => {
    const doc = open(buildPdfaPdf({ trExtGState: true }, 2));
    doc.ConvertToPdfA('2b');
    const res = doc.resolve(doc.Pages[0].Resources) as PdfDict;
    const egs = doc.resolve(res.get('ExtGState')) as PdfDict;
    const gs = doc.resolve(egs.get('GSt')) as PdfDict;
    expect(gs.get('TR')).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — `ExtGStateKeys`, `Halftone`, `ImageKeys` and
`FormXObjectOpi` are still reported.

- [ ] **Step 4: Implement the pass**

```ts
/** ISO 19005-4 6.2.5 (transfer functions and halftones), 6.2.7.1 (image keys)
 *  and 6.2.8.1 (Form XObject /OPI). Note what is NOT fixed and why: a halftone
 *  TYPE outside {1,5} and a /BitsPerComponent outside {1,2,4,8,16} both change
 *  how the page prints or would need the image re-encoded, so they are reported
 *  by the re-validation instead. */
const pdfa4GraphicsPass: Pass = (ctx) => {
  if (ctx.part !== 4) return [];
  const actions: ConvertAction[] = [];

  for (const { ref: object, dict } of extGStates(ctx)) {
    for (const k of ['TR', 'HTO']) {
      if (dict.get(k) !== undefined) {
        dict.delete(k);
        actions.push({ rule: 'ExtGStateKeys', action: `Removed ExtGState /${k}.`, object });
      }
    }
    // 6.2.5-2: /TR2 survives, but only as /Default - so it is SET, not deleted.
    if (dict.get('TR2') !== undefined && nameOf(ctx, dict, 'TR2') !== 'Default') {
      dict.set('TR2', name('Default'));
      actions.push({ rule: 'ExtGStateKeys', action: 'Set ExtGState /TR2 to /Default.', object });
    }
    const ht = ctx.R(dict.get('HT'));
    if (isDict(ht) && ht.get('HalftoneName') !== undefined) {
      ht.delete('HalftoneName');
      actions.push({ rule: 'Halftone', action: 'Removed /HalftoneName from a halftone dictionary.', object });
    }
  }

  for (const [object, obj] of ctx.doc.objectEntries()) {
    if (!isStream(obj)) continue;
    const subtype = nameOf(ctx, obj.dict, 'Subtype');
    if (subtype === 'Image') {
      for (const k of ['Alternates', 'OPI']) {
        if (obj.dict.get(k) !== undefined) {
          obj.dict.delete(k);
          actions.push({ rule: 'ImageKeys', action: `Removed image /${k}.`, object });
        }
      }
    } else if (subtype === 'Form' && obj.dict.get('OPI') !== undefined) {
      obj.dict.delete('OPI');
      actions.push({ rule: 'FormXObjectOpi', action: 'Removed Form XObject /OPI.', object });
    }
  }
  return actions;
};
```

- [ ] **Step 5: Register it in `PASSES`** (after `pdfa4CatalogPass`, before `infoPass`)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts test/helpers/build-pdfa-pdf.ts
git commit -m "feat(72nc.2): pdfa4GraphicsPass - transfer functions, halftone names, image and form keys"
```

---

### Task 6: `pdfa4OutputIntentPass`

**Files:**
- Modify: `src/pdfaconvert.ts`
- Modify: `test/helpers/build-pdfa-pdf.ts` (one additive option)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Cctx`, `nameOf`, `isRef`.
- Produces: `pdfa4OutputIntentPass`. It must be registered **after**
  `outputIntentPass`, which may itself add one — a pass that policed the array
  before it was populated would police the wrong array.
- Produces: `PdfaOptions.twoPdfaOutputIntents?: boolean`.

- [ ] **Step 1: Add the fixture option**

In `test/helpers/build-pdfa-pdf.ts`, in the interface beside
`destOutputProfileRef`:

```ts
  twoPdfaOutputIntents?: boolean; // two GTS_PDFA1 intents sharing one profile
```

and in the `catParts` block, replacing the single-entry push:

```ts
  if (!opts.omitOutputIntent) {
    const dopr = opts.destOutputProfileRef ? ' /DestOutputProfileRef << /DOS (x) >>' : '';
    const oi = `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) /DestOutputProfile 8 0 R${dopr} >>`;
    // The two intents share ONE profile object, so pdfaOutputIntentProfile sees
    // a single distinct profile and only the count rule (6.2.3) can fire.
    catParts.push(`/OutputIntents [${opts.twoPdfaOutputIntents ? `${oi} ${oi}` : oi}]`);
  }
```

- [ ] **Step 2: Write the failing tests**

```ts
describe('ConvertToPdfA — part 4 output intents', () => {
  const conv = (opts: any) => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA('4');
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA('4').Errors.map((e) => e.rule) };
  };

  it('removes /DestOutputProfileRef', () => {
    const r = conv({ destOutputProfileRef: true });
    expect(r.applied).toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
  });

  it('drops a surplus PDF/A output intent, keeping the first', () => {
    const r = conv({ twoPdfaOutputIntents: true });
    expect(r.applied).toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
    const ois = r.doc.resolve(r.doc.catalog().get('OutputIntents')) as unknown[];
    expect(ois.length).toBe(1);
  });

  it('leaves /DestOutputProfileRef alone at parts 1-3', () => {
    const doc = open(buildPdfaPdf({ destOutputProfileRef: true }, 2));
    doc.ConvertToPdfA('2b');
    const ois = doc.resolve(doc.catalog().get('OutputIntents')) as unknown[];
    const oi = doc.resolve(ois[0]) as PdfDict;
    expect(oi.get('DestOutputProfileRef')).toBeDefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — `OutputIntentKeys` still reported for both cases.

- [ ] **Step 4: Implement the pass**

```ts
/** ISO 19005-4 6.2.3: no /DestOutputProfileRef (it names a profile the file
 *  does not carry), and at most one PDF/A output intent. Registered AFTER
 *  outputIntentPass, which may add one - policing the array before it is
 *  populated polices the wrong array. */
const pdfa4OutputIntentPass: Pass = (ctx) => {
  if (ctx.part !== 4) return [];
  const ois = ctx.R(ctx.catalog.get('OutputIntents'));
  if (!isArray(ois)) return [];
  const actions: ConvertAction[] = [];
  const kept: PdfObject[] = [];
  let seenPdfa = false;
  for (const e of ois) {
    const oi = ctx.R(e);
    if (!isDict(oi)) { kept.push(e); continue; }
    const object = isRef(e) ? e : undefined;
    if (oi.get('DestOutputProfileRef') !== undefined) {
      oi.delete('DestOutputProfileRef');
      actions.push({ rule: 'OutputIntentKeys', action: 'Removed OutputIntent /DestOutputProfileRef.', object });
    }
    if (nameOf(ctx, oi, 'S') === 'GTS_PDFA1') {
      if (seenPdfa) {
        actions.push({ rule: 'OutputIntentKeys', object,
          action: 'Dropped a surplus PDF/A OutputIntent (at most one is permitted).' });
        continue;
      }
      seenPdfa = true;
    }
    kept.push(e);
  }
  if (kept.length !== ois.length) ctx.catalog.set('OutputIntents', kept);
  return actions;
};
```

- [ ] **Step 5: Register it in `PASSES`** (after `pdfa4GraphicsPass`, before `infoPass`)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts test/helpers/build-pdfa-pdf.ts
git commit -m "feat(72nc.2): pdfa4OutputIntentPass - DestOutputProfileRef and surplus PDF/A intents"
```

---

### Task 7: `pdfa4AnnotPass` and ToggleNoView

**Files:**
- Modify: `src/pdfaconvert.ts` (`annotationFlagsPass` :140-163, new pass)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: the module-private `eachAnnotation(ctx)` (`src/pdfaconvert.ts:126`).
- Produces: `pdfa4AnnotPass`, registered after `pdfa4OutputIntentPass`. It must
  follow `formsPass`, which generates the `/AP` dictionaries it then prunes.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConvertToPdfA — part 4 annotations', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };
  const firstAnnot = (doc: Document): PdfDict => {
    const arr = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
    return doc.resolve(arr[0]) as PdfDict;
  };

  it('removes appearance keys other than /N', () => {
    const r = conv({ apWithDown: true });
    expect(r.applied).toContain('AppearanceKeys');
    expect(r.errors).not.toContain('AppearanceKeys');
    const ap = r.doc.resolve(firstAnnot(r.doc).get('AP')) as PdfDict;
    expect([...ap.keys()]).toEqual(['N']);
  });

  it('removes /A from a Widget annotation', () => {
    const r = conv({ widgetWithAction: true });
    expect(r.applied).toContain('WidgetAction');
    expect(r.errors).not.toContain('WidgetAction');
  });

  it('clears the ToggleNoView flag at part 4', () => {
    const r = conv({ toggleNoViewAnnot: true });
    expect(r.applied).toContain('AnnotationFlags');
    expect(r.errors).not.toContain('AnnotationFlags');
    expect(Number(firstAnnot(r.doc).get('F')) & 256).toBe(0);
  });

  it('leaves ToggleNoView alone at parts 1-3, which have no such rule', () => {
    const doc = open(buildPdfaPdf({ toggleNoViewAnnot: true }, 2));
    doc.ConvertToPdfA('2b');
    const arr = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
    const annot = doc.resolve(arr[0]) as PdfDict;
    expect(Number(annot.get('F')) & 256).toBe(256);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — `AppearanceKeys`, `WidgetAction` and `AnnotationFlags` are
still reported at part 4.

- [ ] **Step 3: Widen `annotationFlagsPass`**

Replace the flag arithmetic inside `annotationFlagsPass`:

```ts
    const f = ctx.R(dict.get('F'));
    const flags = typeof f === 'number' ? f : 0;
    // set Print(4); clear Invisible(1)/Hidden(2)/NoView(32), and at part 4 also
    // ToggleNoView(256), which ISO 19005-4 6.3.2-2 adds and parts 1-3 permit.
    const clear = ctx.part === 4 ? (1 | 2 | 32 | 256) : (1 | 2 | 32);
    const fixed = (flags | 4) & ~clear;
```

- [ ] **Step 4: Implement `pdfa4AnnotPass`**

```ts
/** ISO 19005-4 6.3.3-2 (an appearance dictionary may hold only /N) and 6.4.1-1
 *  (a Widget annotation may carry no /A action). Registered after formsPass,
 *  which generates the /AP dictionaries this then prunes. */
const pdfa4AnnotPass: Pass = (ctx) => {
  if (ctx.part !== 4) return [];
  const actions: ConvertAction[] = [];
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    const ap = ctx.R(dict.get('AP'));
    if (isDict(ap)) {
      for (const k of [...ap.keys()]) {
        if (k === 'N') continue;
        ap.delete(k);
        actions.push({ rule: 'AppearanceKeys', action: `Removed appearance /${k}.`, object, page });
      }
    }
    if (nameOf(ctx, dict, 'Subtype') === 'Widget' && dict.get('A') !== undefined) {
      dict.delete('A');
      actions.push({ rule: 'WidgetAction', action: 'Removed /A from a Widget annotation.', object, page });
    }
  }
  return actions;
};
```

- [ ] **Step 5: Register it in `PASSES`** (after `pdfa4OutputIntentPass`, before `infoPass`)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(72nc.2): pdfa4AnnotPass and the part-4 ToggleNoView flag"
```

---

### Task 8: `ocConfigPass`

**Files:**
- Modify: `src/pdfaconvert.ts` (add `isString` to the `types.js` import)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Cctx`, `isString` from `./types.js`.
- Produces: `ocConfigPass`, registered after `pdfa4AnnotPass`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConvertToPdfA — part 4 optional content', () => {
  it('names an optional-content configuration that has none', () => {
    const doc = open(buildPdfaPdf({ ocConfigNoName: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('OcConfig');
    expect(doc.ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('OcConfig');
  });

  it('keeps optional content at part 4 - only part 1 removes it', () => {
    const doc = open(buildPdfaPdf({ optionalContent: true }, 4));
    doc.ConvertToPdfA('4');
    expect(doc.catalog().get('OCProperties')).toBeDefined();
    expect(doc.ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('OcConfig');
  });

  it('leaves an already-named configuration untouched', () => {
    const doc = open(buildPdfaPdf({ optionalContent: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).not.toContain('OcConfig');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — the first case still reports `OcConfig`.

- [ ] **Step 3: Implement the pass**

Add `isString` to the existing `types.js` import, then:

```ts
/** ISO 19005-4 6.10-1/-2: every optional-content configuration needs a /Name,
 *  and the names must be unique. Only the missing-name half is remediable -
 *  the collected names are checked so this pass cannot MANUFACTURE the
 *  duplicate the same clause forbids. */
const ocConfigPass: Pass = (ctx) => {
  if (ctx.part !== 4) return [];
  const ocp = ctx.R(ctx.catalog.get('OCProperties'));
  if (!isDict(ocp)) return [];
  const configs: PdfDict[] = [];
  const d = ctx.R(ocp.get('D'));
  if (isDict(d)) configs.push(d);
  const alt = ctx.R(ocp.get('Configs'));
  if (isArray(alt)) for (const c of alt) { const cd = ctx.R(c); if (isDict(cd)) configs.push(cd); }

  const used = new Set<string>();
  for (const cfg of configs) {
    const nm = ctx.R(cfg.get('Name'));
    if (isString(nm)) used.add(new TextDecoder('latin1').decode(nm.bytes));
  }

  const actions: ConvertAction[] = [];
  for (const cfg of configs) {
    if (isString(ctx.R(cfg.get('Name')))) continue;
    let label = 'Default';
    for (let i = 2; used.has(label); i++) label = `Default ${i}`;
    used.add(label);
    cfg.set('Name', { kind: 'string' as const, bytes: new TextEncoder().encode(label) });
    actions.push({ rule: 'OcConfig', action: `Named an optional-content configuration '${label}'.` });
  }
  return actions;
};
```

- [ ] **Step 4: Register it in `PASSES`** (after `pdfa4AnnotPass`, before `infoPass`)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(72nc.2): ocConfigPass - name an unnamed optional-content configuration"
```

---

### Task 9: The part-4 action and annotation-subtype sets

**Files:**
- Modify: `src/pdfaconvert.ts` (`PROHIBITED_ANNOTS`/`PROHIBITED_ACTIONS` :219-222,
  `isProhibitedAction` :225-228, `actionsPass` :230-262, `multimediaPass` :277-289)
- Modify: `test/helpers/build-pdfa-pdf.ts` (two additive options)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Cctx.part`/`.level`.
- Produces: module-private `prohibitedActions(ctx): Set<string>` and
  `prohibitedAnnots(ctx): Set<string>` — deliberately the same names and the
  same shape as `src/pdfavalidate.ts`'s, so the two files' sets read as one
  rule stated twice rather than two rules.
- Produces: `PdfaOptions.launchAction?: boolean`,
  `PdfaOptions.setOcgStateAction?: boolean`.

- [ ] **Step 1: Add the fixture options**

In `test/helpers/build-pdfa-pdf.ts`, beside `jsAction`:

```ts
  launchAction?: boolean;      // catalog /OpenAction /S /Launch (prohibited everywhere)
  setOcgStateAction?: boolean; // catalog /OpenAction /S /SetOCGState (permitted at 4e only)
```

and in `catParts` (each is mutually exclusive with `jsAction`; a fixture sets
one):

```ts
  if (opts.launchAction) catParts.push('/OpenAction << /S /Launch /F (x.exe) >>');
  if (opts.setOcgStateAction) catParts.push('/OpenAction << /S /SetOCGState /State [] >>');
```

- [ ] **Step 2: Write the failing tests**

```ts
describe('ConvertToPdfA — part 4 actions and annotation subtypes', () => {
  const conv = (opts: any, lvl: any = '4') => {
    const doc = open(buildPdfaPdf(opts, 4));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };

  it('KEEPS a JavaScript action at part 4, which permits it', () => {
    const r = conv({ jsAction: true });
    expect(r.applied).not.toContain('Actions');
    expect(r.errors).not.toContain('Actions');
    expect(r.doc.catalog().get('OpenAction')).toBeDefined();
  });

  it('still removes a JavaScript action at parts 1-3', () => {
    const doc = open(buildPdfaPdf({ jsAction: true }, 2));
    doc.ConvertToPdfA('2b');
    expect(doc.catalog().get('OpenAction')).toBeUndefined();
  });

  it('removes a /Launch action at part 4', () => {
    const r = conv({ launchAction: true });
    expect(r.applied).toContain('Actions');
    expect(r.errors).not.toContain('Actions');
  });

  it('removes SetOCGState at 4 and keeps it at 4e', () => {
    expect(conv({ setOcgStateAction: true }, '4').doc.catalog().get('OpenAction')).toBeUndefined();
    const e = conv({ setOcgStateAction: true }, '4e');
    expect(e.doc.catalog().get('OpenAction')).toBeDefined();
    expect(e.errors).not.toContain('Actions');
  });

  it('removes an /AA key outside the part-4 permitted set', () => {
    const r = conv({ additionalAction: true });   // catalog /AA << /WC ... >>
    expect(r.applied).toContain('AdditionalActions');
    expect(r.errors).not.toContain('AdditionalActions');
    expect(r.doc.catalog().get('AA')).toBeUndefined();
  });

  it('removes a FileAttachment annotation at part 4, which prohibits it', () => {
    const r = conv({ fileAttachAnnot: true });
    expect(r.applied).toContain('AnnotationSubtype');
    expect(r.errors).not.toContain('AnnotationSubtype');
  });

  it('removes a 3D annotation at 4 and keeps it at 4e', () => {
    expect(conv({ threeDAnnot: true }, '4').applied).toContain('AnnotationSubtype');
    const e = conv({ threeDAnnot: true }, '4e');
    expect(e.applied).not.toContain('AnnotationSubtype');
    expect(e.errors).not.toContain('AnnotationSubtype');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — JavaScript is removed at part 4, `/Launch` is not, 4e loses
its `SetOCGState` and its 3D annotation, and the `/AA` key survives.

- [ ] **Step 4: Add the part-4 sets**

Replace the two constants and `isProhibitedAction`:

```ts
const PROHIBITED_ANNOTS = new Set(['Movie', 'Sound', 'Screen', '3D', 'RichMedia']);

/** ISO 19005-4 6.3.1-1: FileAttachment joins the prohibited set. 3D and
 *  RichMedia come back off it at 4e - that allowance is most of what makes
 *  PDF/A-4e the engineering conformance. Mirrors pdfavalidate.ts's set. */
const PROHIBITED_ANNOTS_A4 = new Set([
  'Movie', 'Sound', 'Screen', '3D', 'RichMedia', 'FileAttachment',
]);

function prohibitedAnnots(ctx: Cctx): Set<string> {
  if (ctx.part !== 4) return PROHIBITED_ANNOTS;
  if (ctx.level !== 'e') return PROHIBITED_ANNOTS_A4;
  const s = new Set(PROHIBITED_ANNOTS_A4);
  s.delete('3D');
  s.delete('RichMedia');
  return s;
}

const PROHIBITED_ACTIONS = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'JavaScript', 'SetState', 'Hide', 'SetOCGState',
]);

/** ISO 19005-4 6.6.1-1. Note what is ABSENT: JavaScript is PERMITTED in
 *  PDF/A-4, where parts 1-3 prohibit it - so conversion must stop removing it,
 *  and stop deleting the /Names /JavaScript tree with it. */
const PROHIBITED_ACTIONS_A4 = new Set([
  'Launch', 'Sound', 'Movie', 'ResetForm', 'ImportData', 'Hide',
  'Rendition', 'Trans', 'SetOCGState', 'GoTo3DView', 'SetState', 'NoOp',
]);

function prohibitedActions(ctx: Cctx): Set<string> {
  if (ctx.part !== 4) return PROHIBITED_ACTIONS;
  if (ctx.level !== 'e') return PROHIBITED_ACTIONS_A4;
  const s = new Set(PROHIBITED_ACTIONS_A4);
  s.delete('SetOCGState');
  s.delete('GoTo3DView');
  return s;
}

/** ISO 19005-4 6.6.3-1: the permitted additional-action triggers. */
const PERMITTED_AA_KEYS_A4 = new Set(['E', 'X', 'D', 'U', 'Fo', 'Bl']);

/** True when the named action dict is prohibited for this target. */
function isProhibitedAction(ctx: Cctx, actionObj: PdfObject | undefined): boolean {
  const a = ctx.R(actionObj);
  return isDict(a) && prohibitedActions(ctx).has(nameOf(ctx, a, 'S') ?? '');
}
```

- [ ] **Step 5: Rewrite `actionsPass`'s JavaScript-tree and `/AA` branches**

```ts
/** Remove prohibited actions (and /AA at part 1). What counts as prohibited is
 *  the target's set, so JavaScript survives at part 4 - including its /Names
 *  tree, which is gated on the same set rather than on the part number. */
const actionsPass: Pass = (ctx) => {
  if (ctx.preserve.has('javascript')) return [];
  const banned = prohibitedActions(ctx);
  const actions: ConvertAction[] = [];
  if (isProhibitedAction(ctx, ctx.catalog.get('OpenAction'))) {
    ctx.catalog.delete('OpenAction');
    actions.push({ rule: 'Actions', action: 'Removed prohibited /OpenAction.' });
  }
  const names = ctx.R(ctx.catalog.get('Names'));
  if (banned.has('JavaScript') && isDict(names) && names.get('JavaScript') !== undefined) {
    names.delete('JavaScript');
    actions.push({ rule: 'Actions', action: 'Removed /Names /JavaScript tree.' });
  }
  const stripAA = (dict: PdfDict, subtype?: string): void => {
    const aa = ctx.R(dict.get('AA'));
    if (!isDict(aa)) return;
    if (ctx.part === 1) { dict.delete('AA'); actions.push({ rule: 'AdditionalActions', action: 'Removed /AA.' }); return; }
    if (ctx.part === 4) {
      // 6.6.3-1 restricts the KEY SET rather than the action types, and exempts
      // Widget annotations, whose triggers are the form's.
      if (subtype !== 'Widget') {
        for (const k of [...aa.keys()]) {
          if (!PERMITTED_AA_KEYS_A4.has(k)) {
            aa.delete(k);
            actions.push({ rule: 'AdditionalActions', action: `Removed /AA /${k} (not one of E, X, D, U, Fo, Bl).` });
          }
        }
      }
    } else {
      for (const k of [...aa.keys()]) {
        if (isProhibitedAction(ctx, aa.get(k))) { aa.delete(k); actions.push({ rule: 'AdditionalActions', action: `Removed prohibited /AA /${k}.` }); }
      }
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
    stripAA(dict, nameOf(ctx, dict, 'Subtype'));
  }
  return actions;
};
```

- [ ] **Step 6: Point `multimediaPass` at the target's set**

```ts
/** Remove prohibited annotation subtypes. */
const multimediaPass: Pass = (ctx) => {
  if (ctx.preserve.has('multimedia')) return [];
  const banned = prohibitedAnnots(ctx);
  const actions: ConvertAction[] = [];
  for (const { ref, dict, page } of eachAnnotation(ctx)) {
    const st = nameOf(ctx, dict, 'Subtype');
    if (st && banned.has(st)) {
      removeAnnot(ctx, dict);
      actions.push({ rule: 'AnnotationSubtype', action: `Removed /${st} annotation.`, object: ref, page });
    }
  }
  return actions;
};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS. `test/pdfaconvert.test.ts`'s pre-existing "removes JavaScript
actions" and "removes a multimedia annotation" cases target `'2b'` and are the
fence that parts 1–3 did not move.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts test/helpers/build-pdfa-pdf.ts
git commit -m "feat(72nc.2): part-4 prohibited action and annotation sets, and the /AA key restriction"
```

---

### Task 10: `embeddedFilesPass` at part 4

**Files:**
- Modify: `src/pdfaconvert.ts` (`embeddedFilesPass` :302-327)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `Cctx`, `isString`, `name` from `./types.js`.
- Produces: the part-4 branch of `embeddedFilesPass` — additive only, and
  deliberately **not** gated on `preserve: ['embeddedFiles']`, which is
  documented as "destructive-removal categories to skip" and has nothing to
  skip here.

- [ ] **Step 1: Write the failing tests**

```ts
describe('ConvertToPdfA — part 4 embedded files', () => {
  it('adds /UF, /AFRelationship and a /Subtype MIME type rather than removing the file', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'bare' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).toContain('EmbeddedFileSpec');
    expect(doc.ValidatePdfA('4').Errors.map((e) => e.rule)).not.toContain('EmbeddedFileSpec');
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    expect(names.get('EmbeddedFiles')).toBeDefined();
  });

  it('writes the MIME type as ONE name, letting the serializer escape the slash', () => {
    // A MIME type is a PDF name and `/` is a delimiter inside one, so the value
    // is the name whose TEXT is application/octet-stream. Pre-escaping it in
    // name() double-escapes; a bare /application/octet-stream is not one name.
    const doc = open(buildPdfaPdf({ embeddedFile: 'noMime' }, 4));
    doc.ConvertToPdfA('4');
    const saved = new TextDecoder('latin1').decode(doc.Save());
    expect(saved).toContain('/application#2foctet-stream');
    expect(saved).not.toContain('#232F');
  });

  it('leaves an already-conformant file spec alone', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'full' }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).not.toContain('EmbeddedFileSpec');
  });

  it('still removes attachments at part 1', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'full' }, 1));
    const report = doc.ConvertToPdfA('1b');
    expect(report.applied.map((a) => a.rule)).toContain('EmbeddedFiles');
  });

  it('4f with no attachment reports EmbeddedFilesRequired and remediates the rest', () => {
    // Clause 6.9-5 demands an embedded file and conversion cannot synthesize
    // one, so all three levels are still accepted and this is REPORTED.
    const doc = open(buildPdfaPdf({ headerVersion: '1.7', needsRendering: true }, 4));
    const report = doc.ConvertToPdfA('4f');
    expect(report.unresolved.map((i) => i.rule)).toEqual(['EmbeddedFilesRequired']);
    expect(report.passed).toBe(false);
  });

  it('4f with an attachment converts to passing', () => {
    const doc = open(buildPdfaPdf({ embeddedFile: 'bare' }, 4));
    const report = doc.ConvertToPdfA('4f');
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — `EmbeddedFileSpec` still reported; no `/Subtype` in the saved
bytes.

- [ ] **Step 3: Implement the part-4 branch**

Insert into `embeddedFilesPass`, after the `if (ctx.part === 1) { … }` block:

```ts
  if (ctx.part === 4) {
    // ISO 19005-4 6.9-1/-2/-4. Note the direction: part 4 never REMOVES an
    // attachment - 4f is built on carrying one - so this only adds what the
    // clause newly requires, and is not gated on the 'embeddedFiles' preserve
    // category, which names destructive removals and has nothing to skip here.
    for (const [object, obj] of ctx.doc.objectEntries()) {
      if (!isDict(obj)) continue;
      if (nameOf(ctx, obj, 'Type') !== 'Filespec' || obj.get('EF') === undefined) continue;
      if (obj.get('AFRelationship') === undefined) {
        obj.set('AFRelationship', name('Unspecified'));
        actions.push({ rule: 'EmbeddedFileSpec', action: 'Set /AFRelationship on a file spec.', object });
      }
      const f = ctx.R(obj.get('F'));
      if (obj.get('UF') === undefined && isString(f)) {
        obj.set('UF', { kind: 'string' as const, bytes: f.bytes });
        actions.push({ rule: 'EmbeddedFileSpec', action: 'Copied /F to /UF on a file spec.', object });
      }
      const ef = ctx.R(obj.get('EF'));
      if (!isDict(ef)) continue;
      for (const v of ef.values()) {
        const stream = ctx.R(v);
        if (isStream(stream) && stream.dict.get('Subtype') === undefined) {
          // A MIME type is a NAME: build it from the raw text and let
          // escapeName emit `/application#2foctet-stream`.
          stream.dict.set('Subtype', name('application/octet-stream'));
          actions.push({ rule: 'EmbeddedFileSpec', object: isRef(v) ? v : object,
            action: 'Set /Subtype application/octet-stream on an embedded file stream.' });
        }
      }
    }
    return actions;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(72nc.2): part-4 embedded files - add /UF, /AFRelationship and a /Subtype MIME type"
```

---

### Task 11: End to end, the unresolved set, and the mutation sweep

**Files:**
- Test: `test/pdfaconvert.test.ts`
- Modify (only if a mutation reveals a defect): `src/pdfaconvert.ts`

**Interfaces:**
- Consumes: every pass from Tasks 2–10.
- Produces: no source API. It produces the *evidence* — the end-to-end cases
  and the recorded mutation results that later tasks' documentation cites.

- [ ] **Step 1: Write the end-to-end and report-only tests**

```ts
describe('ConvertToPdfA — part 4 end to end', () => {
  const messyOpts = {
    headerVersion: '1.7', infoTitle: 'Messy', omitId: true, omitMetadata: true,
    needsRendering: true, requirements: true, alternatePresentations: true, presSteps: true,
    perms: 'bad' as const, trExtGState: true, htoExtGState: true, tr2ExtGState: true,
    halftoneName: true, imageAlternates: true, imageOpi: true, formOpi: true,
    destOutputProfileRef: true, apWithDown: true, widgetWithAction: true,
    toggleNoViewAnnot: true, ocConfigNoName: true, launchAction: true,
    additionalAction: true, fileAttachAnnot: true, needAppearances: true,
    nonStandardBlend: true, interpolateImage: true,
  };

  for (const level of ['4', '4e'] as const) {
    it(`converts a messy document to a passing ${level}`, () => {
      const doc = open(buildPdfaPdf({ ...messyOpts }, 4));
      const report = doc.ConvertToPdfA(level);
      expect(report.unresolved).toEqual([]);
      expect(report.passed).toBe(true);
      expect(open(doc.Save()).ValidatePdfA(level).Passed).toBe(true);
    });
  }

  it('converts a messy document carrying an attachment to a passing 4f', () => {
    const doc = open(buildPdfaPdf({ ...messyOpts, embeddedFile: 'bare' }, 4));
    const report = doc.ConvertToPdfA('4f');
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
    expect(open(doc.Save()).ValidatePdfA('4f').Passed).toBe(true);
  });

  it('emits no TransparencyBlendingSpace remediation, because the rule is unreachable', () => {
    // outputIntentPass adds a PDF/A output intent whenever there is none, and
    // 6.2.9-2 fires ONLY when there is none - so the rule is closed by
    // construction rather than by a pass somebody forgot to write.
    const doc = open(buildPdfaPdf({ groupNoCs: true, omitOutputIntent: true }, 4));
    const report = doc.ConvertToPdfA('4');
    expect(report.applied.map((a) => a.rule)).not.toContain('TransparencyBlendingSpace');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('TransparencyBlendingSpace');
  });

  it('reports the rules conversion deliberately does not fix', () => {
    const bpc = open(buildPdfaPdf({ badBitsPerComponent: true }, 4));
    expect(bpc.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('ImageKeys');

    const ht = open(buildPdfaPdf({ badHalftone: true }, 4));
    expect(ht.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('Halftone');

    // Deleting the offending CMap would be LEGAL at part 4 (no /ToUnicode
    // presence requirement) and would destroy text extraction to fix a handful
    // of bad code points. Reporting beats silently taking that trade.
    const tu = open(buildPdfaPdf({ type0: true, badToUnicode: true }, 4));
    expect(tu.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('ToUnicodeContent');

    const font = open(buildPdfaPdf({ fontEmbedded: false }, 4));
    expect(font.ConvertToPdfA('4').unresolved.map((i) => i.rule)).toContain('FontEmbedded');
  });
});
```

- [ ] **Step 2: Run them and fix what they find**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: PASS. If a messy case reports an unexpected `unresolved` rule, the
message names the pass to fix — do not weaken the assertion to
`expect(report.passed).toBe(true)` alone, which cannot say *which* rule
survived.

- [ ] **Step 3: Run the whole suite and the typecheck**

```bash
npm run typecheck
npm test
```
Expected: fully green. `test/pdfavalidate.test.ts` (42) and the 53 untouched
cases in `test/pdfa4-validate.test.ts` are the fence.

- [ ] **Step 4: Run the mutation sweep**

For each mutation: apply it to `src/pdfaconvert.ts`, run
`npx vitest run test/pdfaconvert.test.ts`, record which cases redden, then
`git checkout src/pdfaconvert.ts`. **A mutation that reddens nothing is
recorded as uncovered, not quietly kept** — write it into the commit message
and into the `CLAUDE.md` entry in Task 12.

1. Move `infoPass` to the FRONT of `PASSES` → expect the ordering case
   ("removes /Info … having mirrored it into XMP first") to redden.
2. `infoPass`: make the no-`/PieceInfo` branch reduce instead of delete →
   expect `InfoRestriction` unresolved.
3. `conformanceUpdate`: return `ctx.level.toUpperCase()` for part 4 → expect
   the base-level identification case to redden.
4. `identificationPass`: drop the `pdfaRev` spread → expect
   `PdfaIdentification`.
5. `versionPass`: use `'1.7'` at part 4 → expect `Version`.
6. `annotationFlagsPass`: drop `256` from the part-4 mask → expect
   `AnnotationFlags`.
7. `pdfa4CatalogPass`: delete the `/Perms` loop → expect `Permissions`.
8. `pdfa4GraphicsPass`: delete the `/TR2` branch → expect `ExtGStateKeys`.
9. `pdfa4OutputIntentPass`: keep every PDF/A intent → expect
   `OutputIntentKeys`.
10. `pdfa4AnnotPass`: keep non-`/N` appearance keys → expect `AppearanceKeys`.
11. `ocConfigPass`: `return []` → expect `OcConfig`.
12. `prohibitedActions`: always return `PROHIBITED_ACTIONS` → expect the
    JavaScript-kept and `/Launch` cases to redden.
13. `prohibitedAnnots`: always return `PROHIBITED_ANNOTS` → expect the
    FileAttachment case to redden.
14. `embeddedFilesPass`: skip the `/UF` copy → expect `EmbeddedFileSpec`.
15. `embeddedFilesPass`: pass the pre-escaped
    `name('application#2Foctet-stream')` → expect the escaping case to redden
    on the double-escaped bytes.

- [ ] **Step 5: Commit**

```bash
git add test/pdfaconvert.test.ts
git commit -m "test(72nc.2): part-4 conversion end to end, the unresolved set, and the mutation sweep"
```

The commit body records the sweep result, one line per mutation, in the form
this repo uses: `<mutation> -> reddens <n> case(s): <names>` or
`-> reddens NOTHING (uncovered, retained because …)`.

---

### Task 12: Documentation, the follow-up issue, and closing

**Files:**
- Modify: `README.md` (the PDF/A conversion bullet at :61; the conversion
  limitation at :2596)
- Modify: `CLAUDE.md` (the validators/remediation entry that names
  `conversion.ts`, `pdfaconvert.ts`)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- No source changes.

**Interfaces:**
- Consumes: everything Tasks 1–11 produced, and the mutation results recorded
  in Task 11.
- Produces: a `bd` issue for the signing path's hardcoded header; `72nc.2`
  closed.

- [ ] **Step 1: Update `README.md`'s conversion bullet**

Replace the last sentence of the `**PDF/A conversion**` bullet (the one
beginning "PDF/A-4 conversion is not supported") with:

```
PDF/A-4 (`'4'`/`'4e'`/`'4f'`) is remediated too, and its rule set is not a
superset of parts 1–3: identification writes `pdfaid:rev="2020"` with the
conformance *absent* at the base level, the catalog `/Version` is raised to
`2.0` rather than lowered to a ceiling, JavaScript actions are kept rather than
removed, and embedded files are never removed — instead a file spec gains `/UF`
and `/AFRelationship` and the embedded stream a `/Subtype` MIME type. The
document information dictionary is the casualty: ISO 19005-4 permits `/Info`
only alongside a catalog `/PieceInfo` and then only holding `/ModDate`, so
conversion mirrors its fields into XMP and then reduces it to `/ModDate` (with
a `/PieceInfo`) or removes it (without one). Pass `opts.preserve: ['info']` to
keep the dictionary and take an unresolved `InfoRestriction` instead. A
PDF/A-4f document with no attachment reports `EmbeddedFilesRequired`
unresolved, since conversion cannot synthesize one.
```

- [ ] **Step 2: Update `README.md`'s conversion limitation (line ~2596)**

Append to that bullet:

```
At part 4 it additionally cannot fix a `/BitsPerComponent` outside {1,2,4,8,16}
(`ImageKeys`) or a halftone type outside {1,5} (`Halftone`) without re-encoding
the image or changing how the page prints, does not delete a `/ToUnicode` CMap
carrying prohibited code points (`ToUnicodeContent`) — legal at part 4, but it
destroys text extraction — does not remove a `/Named` action outside the four
page-navigation names, and cannot supply the embedded file a PDF/A-4f document
must carry (`EmbeddedFilesRequired`). Part-4 remediation is verified against
this library's own PDF/A-4 validator, itself a transcription of veraPDF's
published profiles: the two halves now agree with each other by construction,
so a passing conversion is not evidence that a certified validator would agree.
```

- [ ] **Step 3: Update `CLAUDE.md`**

In the Source-list entry that names `conversion.ts`, `pdfaconvert.ts`,
`pdfuaconvert.ts`, `pdfxconvert.ts`, add — in this repo's invariant voice, and
citing what was measured:

- **Invariant (`72nc.2`):** part 4 joins the ONE `PASSES` array, gated with
  `if (ctx.part === 4)`. A second `PASSES_A4` table duplicates the ~8 passes
  identical across eras.
- **Invariant (`72nc.2`), and it is the ordering mistake the design exists to
  prevent:** `identificationPass` runs BEFORE `infoPass`, which is why the
  latter is LAST in `PASSES`. It reads `/Info` through `GetMetadata()` to
  mirror title, author, subject, keywords and `/ModDate` into XMP; strip
  `/Info` first and the mirror comes out empty — invisible in the converted
  file, which validates either way. Mutation-checked: moving `infoPass` to the
  front reddens the ordering case.
- **Invariant (`72nc.2`), and the design got this half wrong:** `infoPass` has
  TWO branches because reducing `/Info` to `/ModDate` is legal ONLY beside a
  catalog `/PieceInfo`. `infoRestrictionRule` reports a present `/Info` without
  one whatever it holds (`test/pdfa4-validate.test.ts` pins exactly that with a
  `/ModDate`-only dictionary), so a reduce-only pass could never reach
  `passed === true`. With a `/PieceInfo` it reduces; without one it deletes,
  which discards nothing because the mirror already ran.
- **Note (`72nc.2`), and it is why the pass is mandatory rather than
  conditional:** `SetXmp` calls `ensureInfo()` unconditionally, so
  `identificationPass` CREATES an `/Info` for a document that had none — and an
  empty `/Info` with no `/PieceInfo` is still an `InfoRestriction` error.
  Measured on the clean part-4 fixture.
- **Invariant (`72nc.2`):** `preserve: ['info']` is the one new
  `ConvertCategory`. Everything else part 4 adds is either non-destructive
  normalisation or falls under a category that already exists.
- **Invariant (`72nc.2`):** a MIME `/Subtype` is built through `name()` from the
  RAW text and escaped by the serializer (`/application#2foctet-stream`).
  Pre-escaping double-escapes; a bare `/application/octet-stream` is not one
  name.
- **Invariant (`72nc.2`):** `embeddedFilesPass` never removes at part 4 and its
  additive half is NOT gated on `preserve: ['embeddedFiles']`, which names
  destructive removals and has nothing to skip there.
- **Note (`72nc.2`):** `TransparencyBlendingSpace` gets no pass and needs none —
  `outputIntentPass` adds a PDF/A output intent whenever there is none, and
  6.2.9-2 fires only when there is none, so the rule is unreachable after
  conversion by construction. Asserted directly so it reads as reasoning rather
  than as a pass somebody forgot.
- **Note on the oracle (`72nc.2`), and it is sharper than for validation:**
  there is NONE that runs here. Conversion is verified against our own
  validator, itself a transcription of veraPDF's profiles, so the two halves
  agree by construction. Do not read a green suite as evidence a certified
  validator would pass the output.
- Plus one line per mutation from Task 11's sweep that **reddened nothing**,
  in the "measured, and it covers NOTHING" form this file uses.

- [ ] **Step 4: Add the `CHANGELOG.md` entry**

Under `## [Unreleased]` → `### Added`, above the PDF/A-4 validation entry:

```markdown
- **PDF/A-4 conversion.** `doc.ConvertToPdfA('4' | '4e' | '4f')` remediates
  toward ISO 19005-4:2020 instead of throwing. Part 4's rules are not a
  superset of parts 1–3, so conversion runs in both directions: it *stops*
  removing JavaScript actions and embedded files, and *starts* raising the
  catalog `/Version` to 2.0, writing `pdfaid:rev="2020"` with the conformance
  absent at the base level, clearing the ToggleNoView annotation flag, adding
  `/UF` + `/AFRelationship` + a `/Subtype` MIME type to embedded files, and
  removing `/NeedsRendering`, `/Requirements`, `/AlternatePresentations`,
  `/PresSteps`, non-`/DocMDP` `/Perms`, transfer functions, halftone names,
  image `/Alternates` and `/OPI`, `/DestOutputProfileRef` and non-`/N`
  appearance streams. The casualty is the document information dictionary:
  PDF/A-4 permits `/Info` only alongside a catalog `/PieceInfo` and then only
  holding `/ModDate`, so its fields are mirrored into XMP first and the
  dictionary is then reduced or removed — `preserve: ['info']` keeps it and
  reports `InfoRestriction` unresolved instead. A PDF/A-4f file with no
  attachment reports `EmbeddedFilesRequired`, which conversion cannot
  synthesize. `XmpMetadata.pdfaRev` is the one public type addition. Verified
  against this library's own PDF/A-4 validator, itself a transcription of
  veraPDF's profiles — the two halves now agree by construction, which is not
  evidence that a certified validator would. (72nc.2)
```

- [ ] **Step 5: File the follow-up issue**

```bash
bd create "Signing serializes a hardcoded %PDF-1.7 header" \
  -t bug -p 2 \
  -d "serializer.ts:208 pushes '%PDF-1.7' unconditionally when serializing for a signature, ignoring the catalog /Version that headerVersion() reports and every other save path honours. Signing a PDF/A-4 document therefore silently breaches its own version rule (ISO 19005-4 6.1.2-1 requires PDF 2.n, exactly - not a ceiling), and signing a PDF/A-1 document writes a header above its 1.4 ceiling. Found while confirming that catalog /Version drives the header for 72nc.2; a signing bug rather than a conversion one, so it was filed rather than fixed there."
```

Record the returned id in the `72nc.2` close reason.

- [ ] **Step 6: Verify the module-documentation sweep is clean**

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```
Expected: EMPTY (this issue creates no new module). A non-empty result means
work — do **not** "simplify" the sweep to a bare `grep -q "$b"`.

- [ ] **Step 7: Final verification**

```bash
npm run typecheck
npm test
git status
```
Expected: typecheck clean, suite fully green, no stray files.

- [ ] **Step 8: Commit, close the issue, and push**

```bash
git add README.md CLAUDE.md CHANGELOG.md
git commit -m "docs(72nc.2): PDF/A-4 conversion - the /Info decision, the ordering invariant, the circular oracle"
bd close aspose-pdf-foss-for-ts-72nc.2
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Work is not complete until `git push` succeeds.

---

## Acceptance (from the spec, plus what this plan adds)

- `doc.ConvertToPdfA('4' | '4e' | '4f')` returns a `ConversionReport`; the
  messy-but-achievable fixture converts to `passed === true` at each level, and
  the saved-and-reopened document validates.
- A 4f document with no attachment reports exactly `['EmbeddedFilesRequired']`
  unresolved and remediates everything else.
- `preserve: ['info']` keeps `/Info` **and** reports `InfoRestriction`
  unresolved — both halves, since either alone passes with the category
  ignored.
- XMP still carries the title after `/Info` is stripped.
- `test/pdfaconvert.test.ts`'s original 21 cases and all 42 of
  `test/pdfavalidate.test.ts` pass unedited; 53 of
  `test/pdfa4-validate.test.ts`'s 54 do, the 54th replaced because it asserted
  the removed refusal.
- Every new pass is mutation-checked; any that reddens nothing is recorded as
  uncovered in `CLAUDE.md` rather than quietly kept.
- `npm run typecheck` and `npm test` green.
- README, `CLAUDE.md` and `CHANGELOG.md` record the `/Info` decision, the
  ordering invariant, the unresolved set and the circular-oracle caveat.
