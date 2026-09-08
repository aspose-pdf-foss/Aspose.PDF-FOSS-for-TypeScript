# PDF/A structural backport (`pjy7`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the nine PDF/A-4 structural checks that ISO 19005-1/-2/-3 also
carry so they report at parts 1–3, and widen `ConvertToPdfA`'s matching passes
with them so conversions that report clean keep doing so.

**Architecture:** The nine rules in `src/pdfavalidate.ts` lose their
`if (ctx.part !== 4) return []` gate, keeping only the parts each profile
actually carries. Three value divergences — the permitted `BitsPerComponent`
set, the `GTS_PDFX` exemption, and the Widget key set — move into named
per-part helpers exported from `pdfavalidate.ts` and imported by
`pdfaconvert.ts`, so a rule and the pass that repairs it can never disagree
about which parts they serve. Three converter passes are renamed off their now
false `pdfa4` prefix and ungated; stripping a Widget's actions goes behind a new
`formActions` preserve category.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-pdfa-structural-backport-design.md`
— read it alongside this plan; its matrix is the authority for every per-part
decision here.

---

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries `.js`.
- **`strict` TypeScript.** `npm run typecheck` green before any commit.
- **TDD.** Failing test, watch it fail, implement, watch it pass, commit.
- **Every widened rule gets a CROSS-PART PAIR**, and this is the plan's central
  testing rule: the same fixture asserted as *reported* at each part that
  carries the check and *silent* at each part that does not. A single-part
  assertion cannot tell a rule that widened correctly from one that widened too
  far.
- **Part-1 validation fixtures must pass `headerVersion: '1.4'`.** Measured: the
  builder defaults to 1.7, which breaches the part-1 ceiling and adds a spurious
  `Version` error to every part-1 report. Parts 2 and 3 are clean by default.
- **The fence differs from `72nc.1`'s and `72nc.2`'s.**
  `test/pdfavalidate.test.ts` (42 cases) and `test/pdfaconvert.test.ts` (21) may
  legitimately MOVE here — widening is the point of the issue. **Every case that
  moves is read and explained in that task's commit message, never
  blanket-updated.** A newly-failing fixture is either a fixture that was always
  non-conformant, or the backport reaching too far; only reading it says which.
  Measured up front: no existing case in either file sets `trExtGState`,
  `imageAlternates`, `imageOpi`, `formOpi`, `badHalftone`, `halftoneName`,
  `destOutputProfileRef`, `apWithDown`, `widgetWithAction` or `needsRendering`,
  so movement is *expected to be none* — if a case moves, that is information.
- **No test in these three files asserts message text** (measured: zero matches
  for `message` in `pdfavalidate.test.ts`, `pdfaconvert.test.ts`,
  `pdfa4-validate.test.ts`), so making clauses and messages part-aware is free.
- **`CHANGELOG.md` in the same commit** as the user-visible change.
- **Issue tracking is `bd`.** Commit style `feat(pjy7): …`, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **The oracle is veraPDF's published profiles, fetched not vendored, and
  nothing runs it here.** A green suite attests that our reading of those
  profiles is self-consistent. Do not describe it as conformance evidence.

---

## File Structure

**Modified:**

- `src/pdfavalidate.ts` — the nine rules, plus four exported per-part helpers
  (`partClause`, `permittedBpc`, `destProfileRefExempt`, `widgetActionKeys`).
- `src/pdfaconvert.ts` — three passes renamed and ungated; `ConvertCategory`
  gains `'formActions'`.
- `test/helpers/build-pdfa-pdf.ts` — three additive `PdfaOptions` members
  (`bpc16Image`, `widgetWithAA`, `pdfxIntentProfileRef`). Additive only: no
  existing option's emitted bytes may change.
- `test/pdfa-backport.test.ts` — **created**. Every cross-part pair lives here
  rather than in `pdfa4-validate.test.ts`, because these cases are about parts
  1–3 and that file is named for part 4.
- `test/pdfaconvert.test.ts` — the converter's cross-part cases appended.
- `README.md`, `CLAUDE.md`, `CHANGELOG.md`.

**Created:** one test file. No new source module: every change lands in the two
files that already own these rules and passes.

---

### Task 1: Per-part helpers, and `extGStateKeysRule` widened

**Files:**
- Modify: `src/pdfavalidate.ts` (`extGStateKeysRule` ~:844)
- Test: `test/pdfa-backport.test.ts` (create)

**Interfaces:**
- Produces, all exported from `src/pdfavalidate.ts` and consumed by later tasks
  and by `pdfaconvert.ts`:
  - `partClause(part: 1|2|3|4, cl: PartClauses): string` where
    `PartClauses = { 1?: string; 2?: string; 4?: string }` — key `2` serves
    parts 2 **and** 3, which share clause numbering.
  - `permittedBpc(part: 1|2|3|4): Set<number>` (Task 2)
  - `destProfileRefExempt(part: 1|2|3|4, s: string|undefined): boolean` (Task 5)
  - `widgetActionKeys(part: 1|2|3|4): string[]` (Task 4)

- [ ] **Step 1: Write the failing test**

Create `test/pdfa-backport.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildPdfaPdf, type PdfaOptions } from './helpers/build-pdfa-pdf.js';

/** pjy7. Every case here is a CROSS-PART PAIR: the same fixture asserted as
 *  reported at each part whose veraPDF profile carries the check, and silent at
 *  each part that does not. A single-part assertion cannot tell a rule that
 *  widened correctly from one that widened too far.
 *
 *  Note part 1 passes headerVersion '1.4': the builder defaults to 1.7, which
 *  breaches the part-1 ceiling and adds a spurious Version error. */
const errs = (opts: PdfaOptions, part: 1 | 2 | 3 | 4, level: any) =>
  Document.Open(buildPdfaPdf(part === 1 ? { headerVersion: '1.4', ...opts } : opts, part))
    .ValidatePdfA(level).Errors.map((e) => e.rule);

const at1 = (o: PdfaOptions) => errs(o, 1, '1b');
const at2 = (o: PdfaOptions) => errs(o, 2, '2b');
const at3 = (o: PdfaOptions) => errs(o, 3, '3b');
const at4 = (o: PdfaOptions) => errs(o, 4, '4');

describe('pjy7 — ExtGState transfer functions', () => {
  it('reports /TR at every part', () => {
    expect(at1({ trExtGState: true })).toContain('ExtGStateKeys');
    expect(at2({ trExtGState: true })).toContain('ExtGStateKeys');
    expect(at3({ trExtGState: true })).toContain('ExtGStateKeys');
    expect(at4({ trExtGState: true })).toContain('ExtGStateKeys');
  });

  it('reports a non-/Default /TR2 at every part', () => {
    expect(at1({ tr2ExtGState: true })).toContain('ExtGStateKeys');
    expect(at2({ tr2ExtGState: true })).toContain('ExtGStateKeys');
    expect(at4({ tr2ExtGState: true })).toContain('ExtGStateKeys');
  });

  it('reports /HTO at part 4 ONLY - it is a PDF 2.0 key', () => {
    expect(at4({ htoExtGState: true })).toContain('ExtGStateKeys');
    expect(at1({ htoExtGState: true })).not.toContain('ExtGStateKeys');
    expect(at2({ htoExtGState: true })).not.toContain('ExtGStateKeys');
    expect(at3({ htoExtGState: true })).not.toContain('ExtGStateKeys');
  });

  it('cites the part-1 clause at part 1 and the part-2 clause at part 2', () => {
    // 19005-1 numbers this 6.2.8 and 19005-2/-3 number it 6.2.5. The clause is
    // what a caller acts on, so a backport that keeps citing -4 is half done.
    const one = Document.Open(buildPdfaPdf({ headerVersion: '1.4', trExtGState: true }, 1))
      .ValidatePdfA('1b').Errors.find((e) => e.rule === 'ExtGStateKeys');
    expect(one?.clause).toBe('ISO 19005-1 §6.2.8');
    const two = Document.Open(buildPdfaPdf({ trExtGState: true }, 2))
      .ValidatePdfA('2b').Errors.find((e) => e.rule === 'ExtGStateKeys');
    expect(two?.clause).toBe('ISO 19005-2 §6.2.5');
  });
});
```

Add `export type { PdfaOptions }` to `test/helpers/build-pdfa-pdf.ts` if it is
not already exported — it is declared as `export interface PdfaOptions`, so it
is.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/pdfa-backport.test.ts`
Expected: FAIL — the `/TR` and `/TR2` cases report nothing at parts 1–3, and the
clause case sees `undefined`.

- [ ] **Step 3: Add the clause helper**

In `src/pdfavalidate.ts`, above the rules:

```ts
/** The clause number a check carries in each standard. Key `2` serves parts 2
 *  AND 3, which share numbering; part 4 renumbered nearly everything. */
export type PartClauses = { 1?: string; 2?: string; 4?: string };

/** The ISO clause to cite for this target. Each rule states its own numbers,
 *  because the SAME test is numbered differently per standard — the image keys
 *  are 6.2.4 in 19005-1, 6.2.8 in -2/-3 and 6.2.7.1 in -4. A backport that
 *  keeps citing -4 reports the right defect against the wrong document. */
export function partClause(part: 1 | 2 | 3 | 4, cl: PartClauses): string {
  const n = part === 1 ? cl[1] : part === 4 ? cl[4] : cl[2];
  return `ISO 19005-${part} §${n}`;
}
```

- [ ] **Step 4: Widen the rule**

Replace `extGStateKeysRule`:

```ts
/** ISO 19005-1 6.2.8-1/-2, -2/-3 6.2.5-1/-2, -4 6.2.5-1/-2/-3. /TR and /TR2 are
 *  policed at every part; /HTO is a PDF 2.0 key and appears in the part-4
 *  profile alone, so it stays gated. */
const extGStateKeysRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const clause = partClause(ctx.part, { 1: '6.2.8', 2: '6.2.5', 4: '6.2.5' });
  const prohibited = ctx.part === 4 ? ['TR', 'HTO'] : ['TR'];
  for (const { ref: object, dict } of extGStates(ctx)) {
    for (const k of prohibited) {
      if (dict.get(k) !== undefined) {
        issues.push({ rule: 'ExtGStateKeys', severity: 'error', clause, object,
          message: `ExtGState /${k} is prohibited in PDF/A-${ctx.part}.` });
      }
    }
    // /TR2 survives, but only as /Default.
    if (dict.get('TR2') !== undefined && nameOf(ctx, dict, 'TR2') !== 'Default') {
      issues.push({ rule: 'ExtGStateKeys', severity: 'error', clause, object,
        message: `ExtGState /TR2 must be /Default in PDF/A-${ctx.part}.` });
    }
  }
  return issues;
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/pdfa-backport.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts test/pdfaconvert.test.ts`
Expected: PASS. If any pre-existing case moves, STOP and read it — see the fence
rule in Global Constraints.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfavalidate.ts test/pdfa-backport.test.ts
git commit -m "feat(pjy7): per-part clause helper; ExtGState /TR and /TR2 report at parts 1-3"
```

---

### Task 2: `imageKeysRule` and `formXObjectOpiRule`

**Files:**
- Modify: `src/pdfavalidate.ts` (`imageKeysRule` ~:885, `formXObjectOpiRule` ~:911)
- Modify: `test/helpers/build-pdfa-pdf.ts` (one additive option)
- Test: `test/pdfa-backport.test.ts`

**Interfaces:**
- Consumes: `partClause` (Task 1).
- Produces: `permittedBpc(part: 1|2|3|4): Set<number>`, exported.
- Produces: `PdfaOptions.bpc16Image?: boolean`.

- [ ] **Step 1: Add the fixture option**

In `test/helpers/build-pdfa-pdf.ts`, beside `badBitsPerComponent`:

```ts
  bpc16Image?: boolean;         // image XObject with /BitsPerComponent 16
```

in the XObject block:

```ts
  if (opts.bpc16Image) xobjs.push('/Img16 36 0 R');
```

and in the object table (36 is free):

```ts
  if (opts.bpc16Image) objects[36] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 16 /Length 1 >>\nstream\n\x00\nendstream';
```

**Write that line with the Write or Edit tool, not a shell heredoc** — a
heredoc eats the `\n` and `\x00` escapes and writes real control bytes into the
source. (Measured, twice.)

- [ ] **Step 2: Write the failing test**

Append to `test/pdfa-backport.test.ts`:

```ts
describe('pjy7 — image and form XObject keys', () => {
  it('reports image /Alternates and /OPI at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ imageAlternates: true })).toContain('ImageKeys');
      expect(at({ imageOpi: true })).toContain('ImageKeys');
    }
  });

  it('reports Form XObject /OPI at every part', () => {
    // Filed at 6.2.4-2 in -1 (object PDXObject, so forms as well as images),
    // 6.2.9-1 in -2/-3 (object PDXForm, bundled with the PostScript test) and
    // 6.2.8.1-1 in -4. Three clause numbers, one test.
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ formOpi: true })).toContain('FormXObjectOpi');
    }
  });

  it('reports a junk /BitsPerComponent at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ badBitsPerComponent: true })).toContain('ImageKeys');
    }
  });

  it('reports a 16-bit image at part 1 ONLY - PDF 1.4 had no 16-bit images', () => {
    // The sharpest divergence in this backport: a document that converts clean
    // to 2b can legitimately fail 1b for the same image.
    expect(at1({ bpc16Image: true })).toContain('ImageKeys');
    expect(at2({ bpc16Image: true })).not.toContain('ImageKeys');
    expect(at3({ bpc16Image: true })).not.toContain('ImageKeys');
    expect(at4({ bpc16Image: true })).not.toContain('ImageKeys');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/pdfa-backport.test.ts`
Expected: FAIL on the parts-1–3 halves and on the 16-bit part-1 case.

- [ ] **Step 4: Implement**

```ts
const PERMITTED_BPC = new Set([1, 2, 4, 8, 16]);
/** ISO 19005-1 6.2.4-4 stops at 8 where -2/-3/-4 admit 16: PDF 1.4 had no
 *  16-bit images. So a 16-bit image is legal at parts 2/3/4 and illegal at
 *  part 1 — the one place this backport can fail a document that converts
 *  clean at a later part. */
const PERMITTED_BPC_A1 = new Set([1, 2, 4, 8]);

export function permittedBpc(part: 1 | 2 | 3 | 4): Set<number> {
  return part === 1 ? PERMITTED_BPC_A1 : PERMITTED_BPC;
}

const imageKeysRule: Rule = (ctx) => {
  const issues: ValidationIssue[] = [];
  const clause = partClause(ctx.part, { 1: '6.2.4', 2: '6.2.8', 4: '6.2.7.1' });
  const permitted = permittedBpc(ctx.part);
  for (const [object, obj] of allObjects(ctx)) {
    if (!isStream(obj) || nameOf(ctx, obj.dict, 'Subtype') !== 'Image') continue;
    for (const k of ['Alternates', 'OPI']) {
      if (obj.dict.get(k) !== undefined) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause, object,
          message: `Image /${k} is prohibited in PDF/A-${ctx.part}.` });
      }
    }
    const bpc = ctx.R(obj.dict.get('BitsPerComponent'));
    const isMask = ctx.R(obj.dict.get('ImageMask')) === true;
    if (typeof bpc === 'number') {
      if (isMask && bpc !== 1) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause, object,
          message: `Image mask /BitsPerComponent is ${bpc}; must be 1.` });
      } else if (!isMask && !permitted.has(bpc)) {
        issues.push({ rule: 'ImageKeys', severity: 'error', clause, object,
          message: `Image /BitsPerComponent is ${bpc}; must be ${[...permitted].join(', ')}.` });
      }
    }
  }
  return issues;
};

/** ISO 19005-1 6.2.4-2 (object PDXObject, so forms as well as images),
 *  -2/-3 6.2.9-1 (PDXForm, bundled with the PostScript test) and -4 6.2.8.1-1. */
const formXObjectOpiRule: Rule = (ctx) =>
  allObjects(ctx).flatMap(([object, obj]) =>
    isStream(obj) && nameOf(ctx, obj.dict, 'Subtype') === 'Form' && obj.dict.get('OPI') !== undefined
      ? [{ rule: 'FormXObjectOpi', severity: 'error' as const,
          clause: partClause(ctx.part, { 1: '6.2.4', 2: '6.2.9', 4: '6.2.8.1' }), object,
          message: `Form XObject /OPI is prohibited in PDF/A-${ctx.part}.` }]
      : []);
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/pdfa-backport.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts test/pdfaconvert.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa-backport.test.ts
git commit -m "feat(pjy7): image and form XObject keys report at parts 1-3, with part 1's 8-bit ceiling"
```

---

### Task 3: `appearanceKeysRule`

**Files:**
- Modify: `src/pdfavalidate.ts` (`appearanceKeysRule` ~:790)
- Test: `test/pdfa-backport.test.ts`

**Interfaces:**
- Consumes: `partClause` (Task 1). Produces nothing new.

- [ ] **Step 1: Write the failing test**

```ts
describe('pjy7 — appearance dictionary holds only /N', () => {
  it('reports a /D appearance at every part', () => {
    // ISO 19005-1 6.5.3-4 and -2/-3 6.3.3-2 carry the same test as -4's 6.3.3-1.
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ apWithDown: true })).toContain('AppearanceKeys');
    }
  });

  it('leaves an /N-only appearance alone at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ hiddenAnnot: true })).not.toContain('AppearanceKeys');
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/pdfa-backport.test.ts`
Expected: FAIL for parts 1–3 on the first case.

- [ ] **Step 3: Implement**

```ts
/** ISO 19005-1 6.5.3-4, -2/-3 6.3.3-2, -4 6.3.3-1: an appearance dictionary
 *  may hold only /N. */
const appearanceKeysRule: Rule = (ctx) => {
  const clause = partClause(ctx.part, { 1: '6.5.3', 2: '6.3.3', 4: '6.3.3' });
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    const ap = ctx.R(dict.get('AP'));
    if (!isDict(ap)) return [];
    return [...ap.keys()].filter((k) => k !== 'N').map((k) => ({
      rule: 'AppearanceKeys', severity: 'error' as const, clause, object, page,
      message: `Appearance dictionary contains /${k}; PDF/A-${ctx.part} permits only /N.`,
    }));
  });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/pdfa-backport.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts test/pdfaconvert.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfavalidate.ts test/pdfa-backport.test.ts
git commit -m "feat(pjy7): appearance dictionaries report non-/N keys at parts 1-3"
```

---

### Task 4: `widgetActionRule`, widened as well as ungated

**Files:**
- Modify: `src/pdfavalidate.ts` (`widgetActionRule` ~:802)
- Modify: `test/helpers/build-pdfa-pdf.ts` (one additive option)
- Test: `test/pdfa-backport.test.ts`

**Interfaces:**
- Consumes: `partClause` (Task 1).
- Produces: `widgetActionKeys(part: 1|2|3|4): string[]`, exported — Task 7's
  converter pass reads the same function.
- Produces: `PdfaOptions.widgetWithAA?: boolean`.

- [ ] **Step 1: Add the fixture option**

In `test/helpers/build-pdfa-pdf.ts`, beside `widgetWithAction`:

```ts
  widgetWithAA?: boolean;      // a /Widget annot carrying /AA (parts 1-3 ban it)
```

in the annots block:

```ts
  if (opts.widgetWithAA) annots.push('37 0 R');
```

in the object table, and note it reuses the shared `apForm` at object 22:

```ts
  if (opts.widgetWithAA) objects[37] = `<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /F 4${apRef} /AA << /K << /S /JavaScript /JS (x) >> >> >>`;
```

Extend the existing `apForm` guard so object 22 is emitted for this option too:

```ts
  if (opts.fileAttachAnnot || opts.threeDAnnot || opts.toggleNoViewAnnot
      || opts.apWithDown || opts.widgetWithAction || opts.widgetWithAA) objects[22] = apForm;
```

- [ ] **Step 2: Write the failing test**

```ts
describe('pjy7 — Widget actions, where parts 1-3 are STRICTER than part 4', () => {
  it('reports a Widget /A at every part', () => {
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ widgetWithAction: true })).toContain('WidgetAction');
    }
  });

  it('reports a Widget /AA at parts 1-3 and NOT at part 4', () => {
    // ISO 19005-1 6.6.2-1 and -2/-3 6.4.1-1 ban a Widget's /AA outright;
    // 19005-4 6.6.3-1 EXEMPTS it, "whose triggers are the form's". Widening
    // part 4 to match would report a document ISO 19005-4 permits.
    expect(at1({ widgetWithAA: true })).toContain('WidgetAction');
    expect(at2({ widgetWithAA: true })).toContain('WidgetAction');
    expect(at3({ widgetWithAA: true })).toContain('WidgetAction');
    expect(at4({ widgetWithAA: true })).not.toContain('WidgetAction');
  });

  it('leaves a NON-widget annotation with /AA alone at every part', () => {
    // additionalActionsRule owns that case; this rule is Widget-only, and a
    // rule that fires on both would double-report the same dictionary.
    for (const at of [at1, at2, at3, at4]) {
      expect(at({ additionalAction: true })).not.toContain('WidgetAction');
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/pdfa-backport.test.ts`
Expected: FAIL — nothing reports at parts 1–3.

- [ ] **Step 4: Implement**

```ts
/** ISO 19005-1 6.6.1-3 (/A) and 6.6.2-1 (/AA), -2/-3 6.4.1-1 (both), and -4
 *  6.4.1-1 (/A alone).
 *
 *  Invariant, and it reads backwards: parts 1-3 are STRICTER than part 4 here.
 *  19005-4 6.6.3-1 explicitly exempts a Widget's additional actions, "whose
 *  triggers are the form's", so widening part 4 to match the older parts would
 *  report a document the newest standard permits. */
export function widgetActionKeys(part: 1 | 2 | 3 | 4): string[] {
  return part === 4 ? ['A'] : ['A', 'AA'];
}

const widgetActionRule: Rule = (ctx) => {
  const clause = partClause(ctx.part, { 1: '6.6.1', 2: '6.4.1', 4: '6.4.1' });
  const keys = widgetActionKeys(ctx.part);
  return eachAnnotation(ctx).flatMap(({ ref: object, dict, page }) => {
    if (nameOf(ctx, dict, 'Subtype') !== 'Widget') return [];
    return keys.filter((k) => dict.get(k) !== undefined).map((k) => ({
      rule: 'WidgetAction', severity: 'error' as const, clause, object, page,
      message: `Widget annotation carries /${k}; prohibited in PDF/A-${ctx.part}.`,
    }));
  });
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/pdfa-backport.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts test/pdfaconvert.test.ts`
Expected: PASS. **Note `additionalActionsRule` may ALSO report the widget's
`/AA` at parts 2/3** (it checks prohibited action types in any `/AA`). Two rules
reporting one dictionary is not a defect — they cite different clauses and the
existing part-4 behaviour already allows overlap — but if a pre-existing case
moves because of it, read it before changing anything.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa-backport.test.ts
git commit -m "feat(pjy7): Widget /A and /AA report at parts 1-3, where part 4 exempts /AA"
```

---

### Task 5: The four checks that start at part 2

**Files:**
- Modify: `src/pdfavalidate.ts` (`halftoneRule` ~:864, `outputIntentKeysRule`
  ~:920, `transparencyBlendingSpaceRule` ~:949, `needsRenderingRule` ~:1003)
- Modify: `test/helpers/build-pdfa-pdf.ts` (one additive option)
- Test: `test/pdfa-backport.test.ts`

**Interfaces:**
- Consumes: `partClause` (Task 1).
- Produces: `destProfileRefExempt(part: 1|2|3|4, s: string | undefined): boolean`,
  exported — Task 6's converter pass reads the same function.
- Produces: `PdfaOptions.pdfxIntentProfileRef?: boolean`.

- [ ] **Step 1: Add the fixture option**

In `test/helpers/build-pdfa-pdf.ts`, beside `destOutputProfileRef`:

```ts
  pdfxIntentProfileRef?: boolean; // a GTS_PDFX intent carrying /DestOutputProfileRef
```

and extend the OutputIntents block (which Task `72nc.2` already reshaped):

```ts
  if (!opts.omitOutputIntent) {
    const dopr = opts.destOutputProfileRef ? ' /DestOutputProfileRef << /DOS (x) >>' : '';
    const oi = `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) /DestOutputProfile 8 0 R${dopr} >>`;
    // A PDF/X intent beside the PDF/A one: legal at every part, and the place
    // /DestOutputProfileRef is EXEMPT at parts 2/3 but not at part 4.
    const px = ' << /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (none) /DestOutputProfileRef << /DOS (x) >> >>';
    const entries = opts.twoPdfaOutputIntents ? `${oi} ${oi}` : oi;
    catParts.push(`/OutputIntents [${entries}${opts.pdfxIntentProfileRef ? px : ''}]`);
  }
```

- [ ] **Step 2: Write the failing test**

```ts
describe('pjy7 — the checks that start at part 2', () => {
  it('reports a prohibited halftone type at parts 2-4 and not at part 1', () => {
    expect(at1({ badHalftone: true })).not.toContain('Halftone');
    expect(at2({ badHalftone: true })).toContain('Halftone');
    expect(at3({ badHalftone: true })).toContain('Halftone');
    expect(at4({ badHalftone: true })).toContain('Halftone');
  });

  it('reports /HalftoneName at parts 2-4 and not at part 1', () => {
    expect(at1({ halftoneName: true })).not.toContain('Halftone');
    expect(at2({ halftoneName: true })).toContain('Halftone');
    expect(at4({ halftoneName: true })).toContain('Halftone');
  });

  it('reports catalog /NeedsRendering at parts 2-4 and not at part 1', () => {
    expect(at1({ needsRendering: true })).not.toContain('NeedsRendering');
    expect(at2({ needsRendering: true })).toContain('NeedsRendering');
    expect(at3({ needsRendering: true })).toContain('NeedsRendering');
    expect(at4({ needsRendering: true })).toContain('NeedsRendering');
  });

  it('reports a missing transparency blending space at parts 2-4 and not at part 1', () => {
    // Part 1 bans transparency groups outright (Transparency), so the /CS rule
    // has nothing to attach to - which is why the part-1 half asserts the
    // ABSENCE of TransparencyBlendingSpace and not the absence of all errors.
    const o = { groupNoCs: true, omitOutputIntent: true };
    expect(at1(o)).not.toContain('TransparencyBlendingSpace');
    expect(at2(o)).toContain('TransparencyBlendingSpace');
    expect(at4(o)).toContain('TransparencyBlendingSpace');
  });

  it('reports /DestOutputProfileRef on a PDF/A intent at parts 2-4, not part 1', () => {
    expect(at1({ destOutputProfileRef: true })).not.toContain('OutputIntentKeys');
    expect(at2({ destOutputProfileRef: true })).toContain('OutputIntentKeys');
    expect(at4({ destOutputProfileRef: true })).toContain('OutputIntentKeys');
  });

  it('EXEMPTS /DestOutputProfileRef on a GTS_PDFX intent at parts 2-3 only', () => {
    // 19005-2/-3 6.2.3-3 is `S != 'GTS_PDFX' || containsDestOutputProfileRef ==
    // false`; 19005-4's is unconditional. Flattening either way is a plausible
    // wrong answer, so both directions are asserted.
    expect(at2({ pdfxIntentProfileRef: true })).not.toContain('OutputIntentKeys');
    expect(at3({ pdfxIntentProfileRef: true })).not.toContain('OutputIntentKeys');
    expect(at4({ pdfxIntentProfileRef: true })).toContain('OutputIntentKeys');
  });

  it('keeps the surplus-PDF/A-intent count rule at part 4 alone', () => {
    // Parts 2/3 require `sameOutputProfileIndirect` instead, which
    // outputIntentRule already reports as 'multiple' - so backporting the count
    // rule would report a shape those standards permit.
    expect(at4({ twoPdfaOutputIntents: true })).toContain('OutputIntentKeys');
    expect(at2({ twoPdfaOutputIntents: true })).not.toContain('OutputIntentKeys');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/pdfa-backport.test.ts`
Expected: FAIL on every parts-2/3 half.

- [ ] **Step 4: Implement the four rules**

`halftoneRule` — replace the gate and clause:

```ts
/** ISO 19005-2/-3 6.2.5-4/-5 and -4 6.2.5-4/-5. Absent from the part-1 profile.
 *  A type outside {1,5} is reported and never repaired: forcing it to 1 would
 *  change how the page prints. */
const halftoneRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  const clause = partClause(ctx.part, { 2: '6.2.5', 4: '6.2.5' });
  // …body unchanged except `clause` and `PDF/A-${ctx.part}` in the messages…
};
```

`needsRenderingRule`:

```ts
/** ISO 19005-2/-3 6.4.2-2 and -4 6.4.2-1. Absent from the part-1 profile. */
const needsRenderingRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  if (ctx.catalog.get('NeedsRendering') === undefined) return [];
  return [{ rule: 'NeedsRendering', severity: 'error',
    clause: partClause(ctx.part, { 2: '6.4.2', 4: '6.4.2' }),
    message: `Catalog /NeedsRendering is prohibited in PDF/A-${ctx.part}.` }];
};
```

`transparencyBlendingSpaceRule` — change the gate from `!== 4` to `=== 1` and
the clause to `partClause(ctx.part, { 2: '6.2.10', 4: '6.2.9' })`; the body,
including its documented "page `/Group` only" limitation, is unchanged.

`outputIntentKeysRule`:

```ts
/** ISO 19005-2/-3 6.2.3-3 and -4 6.2.3-3.
 *
 *  Invariant: the parts-2/3 test is `S != 'GTS_PDFX' || containsDest… == false`
 *  while part 4's is unconditional — those standards permit a PDF/X output
 *  intent beside the PDF/A one, and /DestOutputProfileRef is legal THERE. The
 *  surplus-PDF/A-intent count below stays part-4-only: parts 2/3 require
 *  `sameOutputProfileIndirect` instead, which outputIntentRule already reports. */
export function destProfileRefExempt(part: 1 | 2 | 3 | 4, s: string | undefined): boolean {
  return part !== 4 && s === 'GTS_PDFX';
}

const outputIntentKeysRule: Rule = (ctx) => {
  if (ctx.part === 1) return [];
  const ois = ctx.R(ctx.catalog.get('OutputIntents'));
  if (!isArray(ois)) return [];
  const clause = partClause(ctx.part, { 2: '6.2.3', 4: '6.2.3' });
  const issues: ValidationIssue[] = [];
  let pdfaCount = 0;
  for (const e of ois) {
    const oi = ctx.R(e);
    if (!isDict(oi)) continue;
    const s = nameOf(ctx, oi, 'S');
    if (s === 'GTS_PDFA1') pdfaCount++;
    if (oi.get('DestOutputProfileRef') !== undefined && !destProfileRefExempt(ctx.part, s)) {
      issues.push({ rule: 'OutputIntentKeys', severity: 'error', clause,
        object: isRef(e) ? e : undefined,
        message: `OutputIntent /DestOutputProfileRef is prohibited in PDF/A-${ctx.part}.` });
    }
  }
  if (ctx.part === 4 && pdfaCount > 1) {
    issues.push({ rule: 'OutputIntentKeys', severity: 'error', clause,
      message: `The /OutputIntents array holds ${pdfaCount} PDF/A output intents; at most one is permitted.` });
  }
  return issues;
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/pdfa-backport.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts test/pdfaconvert.test.ts test/pdfx-real.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfavalidate.ts test/helpers/build-pdfa-pdf.ts test/pdfa-backport.test.ts
git commit -m "feat(pjy7): halftones, /NeedsRendering, blending space and output-intent keys report at parts 2-3"
```

---

### Task 6: `graphicsKeysPass` and `outputIntentKeysPass`

**Files:**
- Modify: `src/pdfaconvert.ts` (`pdfa4GraphicsPass`, `pdfa4OutputIntentPass`, `PASSES`)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `permittedBpc`, `destProfileRefExempt` from `./pdfavalidate.js`
  (Tasks 2 and 5). `pdfaconvert.ts` already imports from that module, and
  `pdfavalidate.ts` imports nothing from it, so the edge closes no cycle.
- Produces: `pdfa4GraphicsPass` → **`graphicsKeysPass`**, and
  `pdfa4OutputIntentPass` → **`outputIntentKeysPass`**, both ungated.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfaconvert.test.ts`:

```ts
describe('ConvertToPdfA — the backported graphics and output-intent passes (pjy7)', () => {
  const conv = (opts: any, part: 1 | 2 | 3 | 4, lvl: any) => {
    const doc = open(buildPdfaPdf(part === 1 ? { headerVersion: '1.4', ...opts } : opts, part));
    const r = doc.ConvertToPdfA(lvl);
    return { doc, applied: r.applied.map((a) => a.rule), errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };

  it('removes ExtGState /TR at parts 1-3 as well as 4', () => {
    for (const [part, lvl] of [[1, '1b'], [2, '2b'], [3, '3b']] as const) {
      const r = conv({ trExtGState: true }, part, lvl);
      expect(r.applied).toContain('ExtGStateKeys');
      expect(r.errors).not.toContain('ExtGStateKeys');
    }
  });

  it('removes image /Alternates and form /OPI at parts 1-3', () => {
    const r = conv({ imageAlternates: true, formOpi: true }, 2, '2b');
    expect(r.errors).not.toContain('ImageKeys');
    expect(r.errors).not.toContain('FormXObjectOpi');
  });

  it('removes /HalftoneName at part 2 and leaves part 1 alone', () => {
    expect(conv({ halftoneName: true }, 2, '2b').applied).toContain('Halftone');
    // Part 1 has no halftone rule, so there is nothing to repair and nothing
    // to report - the pass must not "fix" what the standard permits.
    expect(conv({ halftoneName: true }, 1, '1b').applied).not.toContain('Halftone');
  });

  it('removes /DestOutputProfileRef from a PDF/A intent at parts 2-3', () => {
    const r = conv({ destOutputProfileRef: true }, 2, '2b');
    expect(r.applied).toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
  });

  it('LEAVES a GTS_PDFX intent alone at parts 2-3, where it is exempt', () => {
    const r = conv({ pdfxIntentProfileRef: true }, 2, '2b');
    expect(r.applied).not.toContain('OutputIntentKeys');
    expect(r.errors).not.toContain('OutputIntentKeys');
    // Asserted on the saved bytes rather than by walking the array: the key
    // must SURVIVE, and the surrounding /S tells which intent kept it.
    const saved = new TextDecoder('latin1').decode(r.doc.Save());
    expect(saved).toContain('/DestOutputProfileRef');
  });

  it('reports a bad /BitsPerComponent at parts 1-3 rather than re-encoding', () => {
    expect(conv({ badBitsPerComponent: true }, 2, '2b').errors).toContain('ImageKeys');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — the passes are still gated at part 4, so nothing is repaired at
parts 1–3 and the validator (already widened) reports.

- [ ] **Step 3: Implement**

Rename and ungate. In `graphicsKeysPass`, replace the part gate and scope each
key group:

```ts
/** ISO 19005-1 6.2.8 / -2/-3 6.2.5 / -4 6.2.5 (transfer functions and
 *  halftones), plus the image and form XObject keys. Renamed off the `pdfa4`
 *  prefix, which became a lie the moment it ran at part 2.
 *
 *  Invariant: the per-part scope comes from the SAME helpers the rules read. A
 *  pass that decided independently which parts it serves is how a converter
 *  comes to fix something the validator does not report, or leave something it
 *  does. */
const graphicsKeysPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  const prohibited = ctx.part === 4 ? ['TR', 'HTO'] : ['TR'];   // /HTO is PDF 2.0
  for (const { ref: object, dict } of extGStates(ctx)) {
    for (const k of prohibited) { /* …unchanged… */ }
    if (dict.get('TR2') !== undefined && nameOf(ctx, dict, 'TR2') !== 'Default') { /* …unchanged… */ }
    // The halftone rules start at part 2.
    if (ctx.part !== 1) {
      const ht = ctx.R(dict.get('HT'));
      if (isDict(ht) && ht.get('HalftoneName') !== undefined) { /* …unchanged… */ }
    }
  }
  // Image /Alternates + /OPI and form /OPI: every part.
  for (const [object, obj] of ctx.doc.objectEntries()) { /* …unchanged… */ }
  return actions;
};
```

In `outputIntentKeysPass`, honour the exemption and keep the surplus drop at
part 4:

```ts
const outputIntentKeysPass: Pass = (ctx) => {
  if (ctx.part === 1) return [];
  // …walk unchanged, except:
  //   if (oi.get('DestOutputProfileRef') !== undefined
  //       && !destProfileRefExempt(ctx.part, nameOf(ctx, oi, 'S'))) { …delete… }
  //   and the surplus-intent `continue` is guarded by `ctx.part === 4`.
};
```

Update the `PASSES` array to the new names and move both out of the part-4
comment block, leaving `pdfa4CatalogPass` where it is.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfa-backport.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(pjy7): graphicsKeysPass and outputIntentKeysPass repair at parts 1-3"
```

---

### Task 7: `annotKeysPass` and the `formActions` category

**Files:**
- Modify: `src/pdfaconvert.ts` (`ConvertCategory`, `pdfa4AnnotPass`, `PASSES`)
- Test: `test/pdfaconvert.test.ts`

**Interfaces:**
- Consumes: `widgetActionKeys` from `./pdfavalidate.js` (Task 4).
- Produces: `pdfa4AnnotPass` → **`annotKeysPass`**; `ConvertCategory` gains
  `'formActions'` (8 members).

- [ ] **Step 1: Write the failing test**

```ts
describe('ConvertToPdfA — widget actions and the formActions category (pjy7)', () => {
  const conv = (opts: any, part: 1 | 2 | 3 | 4, lvl: any, o?: any) => {
    const doc = open(buildPdfaPdf(part === 1 ? { headerVersion: '1.4', ...opts } : opts, part));
    const r = doc.ConvertToPdfA(lvl, o);
    return { doc, applied: r.applied.map((a) => a.rule),
      unresolved: r.unresolved.map((i) => i.rule),
      errors: doc.ValidatePdfA(lvl).Errors.map((e) => e.rule) };
  };
  const firstAnnot = (doc: Document): PdfDict => {
    const arr = doc.resolve(doc.Pages[0].Dict.get('Annots')) as PdfObject[];
    return doc.resolve(arr[0]) as PdfDict;
  };

  it('strips a Widget /A at parts 1-3 as well as 4', () => {
    for (const [part, lvl] of [[1, '1b'], [2, '2b'], [3, '3b']] as const) {
      const r = conv({ widgetWithAction: true }, part, lvl);
      expect(r.applied).toContain('WidgetAction');
      expect(r.errors).not.toContain('WidgetAction');
    }
  });

  it('strips a Widget /AA at parts 1-3 and leaves it at part 4', () => {
    const two = conv({ widgetWithAA: true }, 2, '2b');
    expect(two.applied).toContain('WidgetAction');
    expect(two.errors).not.toContain('WidgetAction');
    // Part 4 exempts a Widget's /AA, so the pass must not remove it there.
    const four = conv({ widgetWithAA: true }, 4, '4');
    expect(four.applied).not.toContain('WidgetAction');
    expect(firstAnnot(four.doc).get('AA')).toBeDefined();
  });

  it('preserve: [formActions] keeps the actions AND reports them unresolved', () => {
    // Both halves, since either alone passes with the category ignored.
    const r = conv({ widgetWithAction: true }, 2, '2b', { preserve: ['formActions'] });
    expect(r.applied).not.toContain('WidgetAction');
    expect(firstAnnot(r.doc).get('A')).toBeDefined();
    expect(r.unresolved).toContain('WidgetAction');
  });

  it('removes non-/N appearance keys at parts 1-3', () => {
    const r = conv({ apWithDown: true }, 2, '2b');
    expect(r.applied).toContain('AppearanceKeys');
    expect(r.errors).not.toContain('AppearanceKeys');
  });

  it('does not let formActions preserve the appearance prune', () => {
    // The category names ACTIONS; an /AP key is a different construct, and a
    // category that quietly widened would keep a defect the caller never asked
    // to keep.
    const r = conv({ apWithDown: true }, 2, '2b', { preserve: ['formActions'] });
    expect(r.applied).toContain('AppearanceKeys');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/pdfaconvert.test.ts`
Expected: FAIL — plus a typecheck error on `'formActions'`, which is not yet a
`ConvertCategory`.

- [ ] **Step 3: Implement**

```ts
export type ConvertCategory =
  | 'javascript' | 'multimedia' | 'embeddedFiles' | 'xfa' | 'optionalContent'
  | 'postScript' | 'info' | 'formActions';
```

```ts
/** ISO 19005-1 6.5.3-4 / -2/-3 6.3.3-2 / -4 6.3.3-1 (an appearance dictionary
 *  holds only /N), and the Widget action prohibitions.
 *
 *  Note the asymmetry between the two halves: the /AP prune is non-destructive
 *  normalisation — a /D or /R appearance is alternate ARTWORK for a state the
 *  document may not even reach — while stripping a Widget's /A and /AA deletes
 *  real behaviour: a push button's action, a field's keystroke and format
 *  scripts. That is why only the second is gated on a category. */
const annotKeysPass: Pass = (ctx) => {
  const actions: ConvertAction[] = [];
  const keys = ctx.preserve.has('formActions') ? [] : widgetActionKeys(ctx.part);
  for (const { ref: object, dict, page } of eachAnnotation(ctx)) {
    const ap = ctx.R(dict.get('AP'));
    if (isDict(ap)) {
      for (const k of [...ap.keys()]) {
        if (k === 'N') continue;
        ap.delete(k);
        actions.push({ rule: 'AppearanceKeys', action: `Removed appearance /${k}.`, object, page });
      }
    }
    if (nameOf(ctx, dict, 'Subtype') !== 'Widget') continue;
    for (const k of keys) {
      if (dict.get(k) === undefined) continue;
      dict.delete(k);
      actions.push({ rule: 'WidgetAction', action: `Removed /${k} from a Widget annotation.`, object, page });
    }
  }
  return actions;
};
```

Rename the entry in `PASSES` and move it out of the part-4 block.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/pdfaconvert.test.ts test/pdfa-backport.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/pdfaconvert.ts test/pdfaconvert.test.ts
git commit -m "feat(pjy7): annotKeysPass at parts 1-3, with widget actions behind preserve: ['formActions']"
```

---

### Task 8: End-to-end acceptance, the fence review, and the mutation sweep

**Files:**
- Test: `test/pdfaconvert.test.ts`
- Modify (only if a mutation or a moved case reveals a defect): either source file

**Interfaces:**
- Consumes: everything from Tasks 1–7. Produces the evidence the docs cite.

- [ ] **Step 1: Write the end-to-end cases**

```ts
describe('ConvertToPdfA — a messy document still converts clean at parts 1-3 (pjy7)', () => {
  // The premise of widening the converter alongside the validator: a document
  // carrying every newly-detected defect must still reach passed === true.
  const messy = {
    trExtGState: true, tr2ExtGState: true, halftoneName: true,
    imageAlternates: true, imageOpi: true, formOpi: true,
    destOutputProfileRef: true, apWithDown: true, widgetWithAction: true,
    widgetWithAA: true, needsRendering: true, needAppearances: true,
  };

  for (const [part, lvl] of [[2, '2b'], [3, '3b']] as const) {
    it(`converts to a passing ${lvl}`, () => {
      const doc = open(buildPdfaPdf(messy, part));
      const report = doc.ConvertToPdfA(lvl);
      expect(report.unresolved).toEqual([]);
      expect(report.passed).toBe(true);
      expect(open(doc.Save()).ValidatePdfA(lvl).Passed).toBe(true);
    });
  }

  it('converts to a passing 1b', () => {
    // Part 1 drops the halftone and /NeedsRendering members: neither is a
    // part-1 rule, so leaving them in would assert the converter repairs
    // something the standard permits.
    const { halftoneName, needsRendering, ...rest } = messy;
    const doc = open(buildPdfaPdf({ headerVersion: '1.4', ...rest }, 1));
    const report = doc.ConvertToPdfA('1b');
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('reports the part-1 16-bit image rather than re-encoding it', () => {
    // The one genuinely NEW failure this backport introduces: legal at 2/3/4,
    // illegal at 1, and not mechanically fixable.
    const doc = open(buildPdfaPdf({ headerVersion: '1.4', bpc16Image: true }, 1));
    expect(doc.ConvertToPdfA('1b').unresolved.map((i) => i.rule)).toContain('ImageKeys');
    const ok = open(buildPdfaPdf({ bpc16Image: true }, 2));
    expect(ok.ConvertToPdfA('2b').passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the full suite and review the fence**

```bash
npm run typecheck
npm test
```

Expected: green. **If any case in `test/pdfavalidate.test.ts` or
`test/pdfaconvert.test.ts` moved, do not touch it yet.** For each one, record in
the commit message: the fixture, which widened rule now fires, and whether the
fixture was always non-conformant (correct — update the expectation and say so)
or the backport reached too far (a defect — fix the rule).

- [ ] **Step 3: Run the mutation sweep**

For each mutation: apply, run
`npx vitest run test/pdfa-backport.test.ts test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts`,
record which cases redden, then revert.

**Commit the implementation BEFORE sweeping.** Reverting a mutation with
`git checkout -- src/` also discards an uncommitted fix, which silently turns
every later mutation into "anchor missing". (Measured twice in this repo's
recent history.)

1. `permittedBpc` returns `PERMITTED_BPC` for every part → the part-1 16-bit
   case must redden.
2. `widgetActionKeys` returns `['A', 'AA']` for every part → the part-4
   exemption case must redden.
3. `widgetActionKeys` returns `['A']` for every part → the parts-1–3 `/AA`
   cases must redden.
4. `destProfileRefExempt` returns `false` always → the `GTS_PDFX` case must
   redden.
5. `destProfileRefExempt` returns `true` for part 4 too → the part-4 half must
   redden.
6. `halftoneRule`'s gate back to `ctx.part !== 4` → the parts-2/3 cases redden.
7. `needsRenderingRule`'s gate back to `!== 4` → likewise.
8. `transparencyBlendingSpaceRule`'s gate back to `!== 4` → likewise.
9. `outputIntentKeysRule` drops the `ctx.part === 4` guard on the surplus count
   → the "part 4 alone" case reddens.
10. `partClause` always returns the part-4 string → the clause case reddens.
11. `graphicsKeysPass` keeps its `if (ctx.part !== 4) return []` → the
    conversion cases redden.
12. `annotKeysPass` ignores `preserve.has('formActions')` → the preserve case
    reddens.
13. `annotKeysPass` gates the `/AP` prune on `formActions` too → the
    "does not let formActions preserve the appearance prune" case reddens.

Any mutation that reddens nothing is recorded as uncovered in `CLAUDE.md`,
never quietly kept.

- [ ] **Step 4: Commit**

```bash
git add test/pdfaconvert.test.ts
git commit -m "test(pjy7): cross-part acceptance, the fence review, and the mutation sweep"
```

The body records the sweep one line per mutation, and the fence review one line
per moved case (or "no pre-existing case moved", which is the expected result).

---

### Task 9: Documentation and closing

**Files:**
- Modify: `README.md` (the PDF/A validation bullet ~:60 and the conversion
  bullet ~:61; the conversion limitation ~:2596)
- Modify: `CLAUDE.md` (the validators/remediation entry)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Fixed`)

**Interfaces:** consumes Task 8's measurements.

- [ ] **Step 1: `CHANGELOG.md`**

Under `### Fixed`, because this is a validator that was reporting too little:

```markdown
- **Nine structural checks now report at PDF/A parts 1-3, not only part 4.**
  `72nc.1` landed them gated at part 4, so a document violating ExtGState
  `/TR`/`/TR2`, image `/Alternates`/`/OPI`/`BitsPerComponent`, Form XObject
  `/OPI`, an appearance dictionary holding more than `/N`, a Widget action, a
  halftone, `/NeedsRendering`, a transparency blending space or
  `/DestOutputProfileRef` was reported at `'4'` and passed at `'2b'` — the
  validator was quietly more lenient about the older, stricter parts. Each rule
  now applies at exactly the parts veraPDF's PDFA-1B/2B/3B profiles carry it,
  and cites that standard's own clause number. Three divergences are real and
  are not smoothed over: a 16-bit image is legal at parts 2/3/4 and **illegal at
  part 1**, so a document that converts clean to `'2b'` can fail `'1b'`;
  `/DestOutputProfileRef` is exempt on a `GTS_PDFX` output intent at parts 2/3
  but not at part 4; and a Widget's `/AA` is prohibited at parts 1-3 while
  ISO 19005-4 explicitly exempts it. `ConvertToPdfA` repairs the same set at the
  same parts, so conversions that reported clean keep doing so — except for a
  prohibited halftone type and a bad `BitsPerComponent`, which are reported
  rather than repaired because fixing them would change how a page prints or
  need the image re-encoded. Stripping a Widget's `/A` and `/AA` deletes real
  form behaviour, so it is opt-out through the new `preserve: ['formActions']`
  category. (pjy7)
```

- [ ] **Step 2: `README.md`**

In the validation bullet, replace "for parts 1–3 at every conformance level"
with wording that no longer implies the structural checks are part-4-only, and
add one sentence naming the three divergences. In the conversion bullet, add
`formActions` to the `preserve` list. In the conversion limitation, note the
part-1 16-bit case as a defect conversion reports rather than fixes.

- [ ] **Step 3: `CLAUDE.md`**

Add to the validators/remediation entry, in this repo's invariant voice:

- **Invariant (`pjy7`):** a rule applies at exactly the parts whose veraPDF
  profile carries it, and cites THAT standard's clause through `partClause` —
  the same test is numbered 6.2.4 in 19005-1, 6.2.8 in -2/-3 and 6.2.7.1 in -4.
- **Invariant (`pjy7`), and it reads backwards:** parts 1-3 are STRICTER than
  part 4 on Widget actions. 19005-4 6.6.3-1 exempts a Widget's `/AA`; the older
  parts ban it. Widening part 4 to match reports a document ISO 19005-4 permits.
- **Invariant (`pjy7`):** `permittedBpc` excludes 16 at part 1 — PDF 1.4 had no
  16-bit images — so this is the one check that can fail a document at an
  EARLIER part than it passes at a later one.
- **Invariant (`pjy7`):** `destProfileRefExempt` — parts 2/3 permit
  `/DestOutputProfileRef` on a `GTS_PDFX` intent and part 4 does not.
- **Invariant (`pjy7`):** the converter passes read the SAME helpers the rules
  do. A pass deciding its own parts is how a converter comes to fix what the
  validator does not report.
- **Note (`pjy7`):** the passes are named `graphicsKeysPass`,
  `outputIntentKeysPass` and `annotKeysPass`; only `pdfa4CatalogPass` keeps the
  part in its name, because every rule it serves stays part-4-only.
- Plus one line per mutation from Task 8 that reddened nothing.

- [ ] **Step 4: Verify and commit**

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
npm run typecheck && npm test
git add README.md CLAUDE.md CHANGELOG.md
git commit -m "docs(pjy7): the per-part matrix, the three divergences, and the formActions category"
```

The module sweep must print nothing (this issue creates no module).

- [ ] **Step 5: Close and push**

```bash
bd close aspose-pdf-foss-for-ts-pjy7 --reason "…"
git pull --rebase && git push && git status -sb
```

The close reason records the matrix, the three divergences, the fence result and
the sweep. **Note `git pull --rebase` flattens a `--no-ff` merge commit** — if
this work lands on a branch, merge and push without an intervening rebase.

---

## Acceptance

- Each of the nine rules reports at every part its profile carries it and is
  silent at every part it does not, asserted as pairs in
  `test/pdfa-backport.test.ts`.
- The three divergences each have a case that fails if flattened in either
  direction (part-1 `BitsPerComponent`, the `GTS_PDFX` exemption, Widget `/AA`).
- A messy fixture converts to a passing `'1b'`, `'2b'` and `'3b'` with
  `unresolved` empty.
- `preserve: ['formActions']` keeps the actions AND reports `WidgetAction`.
- Every moved case in `test/pdfavalidate.test.ts` and `test/pdfaconvert.test.ts`
  is explained in a commit rather than blanket-updated.
- Every mutation in Task 8 reddens, or is recorded as uncovered.
- `npm run typecheck` and `npm test` green.
- README, `CLAUDE.md` and `CHANGELOG.md` record the matrix, the divergences, the
  new category and the unchanged circular-oracle caveat.
