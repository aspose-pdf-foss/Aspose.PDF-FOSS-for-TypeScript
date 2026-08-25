# PDF/UA Conversion / Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Document.ConvertToPdfUa(opts?)` that mechanically remediates the deterministic PDF/UA-1 defects in place, re-validates via `ValidatePdfUa`, and returns a `ConversionReport`.

**Architecture:** An ordered list of mutating *passes* (each `(ctx) => ConvertAction[]`) edits the live object model, then `validatePdfUa` runs and its `.Errors` become `unresolved`. Mirrors the existing `pdfaconvert.ts` engine. Human-authoring defects (alt text, structure, untagged content) get no pass and surface honestly in `unresolved`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- Live-mutation model: passes edit the live object map and call `doc.markModified()` (directly or via facade setters that already do). Never mutate inputs during Save.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- `PdfDict` is `Map<string, PdfObject>`; names without leading `/`. Booleans are JS `boolean`. Create a new dict with `new Map<string, PdfObject>()`.
- Run `npm run typecheck` and `npm test` before considering any task done; both must be green.
- Spec: [docs/superpowers/specs/2026-06-29-pdfua-conversion-design.md](../specs/2026-06-29-pdfua-conversion-design.md).

## File Structure

- `src/conversion.ts` — **new**. Owns `ConvertAction` and `ConversionReport` (moved out of `pdfaconvert.ts`). Depends only on `types.ts`, `page.ts`, `validation.ts`.
- `src/pdfaconvert.ts` — **modify**. Import `ConvertAction`/`ConversionReport` from `conversion.ts` and re-export them (keeps existing importers working). `ConvertOptions`/`ConvertCategory` stay here.
- `src/pdfuaconvert.ts` — **new**. The PDF/UA conversion engine: `PdfUaConvertOptions`, the passes, and `convertToPdfUa(doc, catalog, opts)`.
- `src/xmp.ts` — **modify**. Additive `pdfuaPart` read + build (namespace `http://www.aiim.org/pdfua/ns/id/`).
- `src/document.ts` — **modify**. Thin `ConvertToPdfUa()` facade wrapper.
- `src/index.ts` — **modify**. Export `ConvertToPdfUa`'s option type and re-point shared conversion types at `conversion.ts`.
- `test/pdfuaconvert.test.ts` — **new**. Per-pass + end-to-end tests, reusing `test/helpers/build-ua-pdf.ts` (already option-rich).
- `test/xmp.test.ts` — **modify**. `pdfuaid` round-trip cases.
- `README.md` — **modify**. Features bullet + Limitations note.

---

### Task 1: Extract shared conversion types into `conversion.ts`

Pure refactor: move `ConvertAction`/`ConversionReport` out of `pdfaconvert.ts` so PDF/UA can share them without depending on PDF/A. Verified by the existing suite + typecheck (no behavior change, so no new test).

**Files:**
- Create: `src/conversion.ts`
- Modify: `src/pdfaconvert.ts:21-35` (remove the two interface definitions; import + re-export instead)
- Modify: `src/index.ts:32`

**Interfaces:**
- Produces: `interface ConvertAction { rule: string; action: string; object?: PdfRef; page?: Page; }` and `interface ConversionReport { applied: ConvertAction[]; unresolved: ValidationIssue[]; passed: boolean; }` from `src/conversion.ts`.

- [ ] **Step 1: Create `src/conversion.ts`**

```ts
import type { PdfRef } from './types.js';
import type { Page } from './page.js';
import type { ValidationIssue } from './validation.js';

/** One remediation performed by a converter (PDF/A or PDF/UA). */
export interface ConvertAction {
  /** Validator rule id this addresses, e.g. 'OutputIntent' or 'NaturalLanguage'. */
  rule: string;
  /** What was done, human-readable. */
  action: string;
  object?: PdfRef;
  page?: Page;
}

/** The result of a conversion run: what was applied, what still fails, pass flag. */
export interface ConversionReport {
  applied: ConvertAction[];
  /** == the validator's Errors after the passes run. */
  unresolved: ValidationIssue[];
  passed: boolean;
}
```

- [ ] **Step 2: Replace the definitions in `pdfaconvert.ts` with an import + re-export**

Remove the `ConvertAction` and `ConversionReport` interface blocks at [src/pdfaconvert.ts:21-35](../../../src/pdfaconvert.ts) and add, near the other imports at the top of the file:

```ts
import type { ConvertAction, ConversionReport } from './conversion.js';
export type { ConvertAction, ConversionReport } from './conversion.js';
```

Leave `ConvertCategory`, `ConvertOptions`, `Cctx`, and everything else in `pdfaconvert.ts` unchanged. (The existing `import { ... ValidationIssue } from './validation.js'` line stays — `Cctx`/passes may still reference it.)

- [ ] **Step 3: Point `index.ts` at the new module**

At [src/index.ts:32](../../../src/index.ts), change:

```ts
export type { ConvertOptions, ConvertAction, ConversionReport, ConvertCategory } from './pdfaconvert.js';
```

to:

```ts
export type { ConvertOptions, ConvertCategory } from './pdfaconvert.js';
export type { ConvertAction, ConversionReport } from './conversion.js';
```

- [ ] **Step 4: Typecheck + full suite (the refactor's test)**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (988+ before this feature). No behavior changed.

- [ ] **Step 5: Commit**

```bash
git add src/conversion.ts src/pdfaconvert.ts src/index.ts
git commit -m "refactor: extract ConvertAction/ConversionReport into conversion.ts"
```

---

### Task 2: `pdfuaid` read + build in `xmp.ts`

**Files:**
- Modify: `src/xmp.ts` (`XmpMetadata` interface ~line 15; `readXmp` ~line 115; `buildXmp` ~line 160)
- Test: `test/xmp.test.ts`

**Interfaces:**
- Produces: `XmpMetadata.pdfuaPart?: number`; `buildXmp` emits a `pdfuaid:part` description; `readXmp` parses it.

- [ ] **Step 1: Write the failing test**

Add to `test/xmp.test.ts`:

```ts
import { buildXmp, readXmp } from '../src/xmp.js';

describe('xmp pdfuaid', () => {
  it('builds and reads back pdfuaid:part', () => {
    const xml = buildXmp({ title: 'Doc', pdfuaPart: 1 });
    expect(xml).toContain('xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"');
    expect(xml).toContain('pdfuaid:part="1"');
    const back = readXmp(new TextEncoder().encode(xml));
    expect(back.pdfuaPart).toBe(1);
  });
});
```

(If `test/xmp.test.ts` already imports `buildXmp`/`readXmp` and has a `describe`, just add the `it` block; don't duplicate imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xmp.test.ts -t pdfuaid`
Expected: FAIL — `pdfuaPart` is `undefined` / `pdfuaid:part` not present.

- [ ] **Step 3: Add the field to `XmpMetadata`**

In the `XmpMetadata` interface in `src/xmp.ts`, after the `pdfaConformance?` line (~line 16), add:

```ts
  pdfuaPart?: number;             // pdfuaid:part (PDF/UA identification)
```

- [ ] **Step 4: Parse it in `readXmp`**

In `readXmp`, after the `pdfaConformance` block (~line 120), add:

```ts
  const uaPart = /pdfuaid:part\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfuaid:part>\s*([^<]+?)\s*<\/pdfuaid:part>/.exec(raw);
  if (uaPart) meta.pdfuaPart = Number(uaPart[1].trim());
```

- [ ] **Step 5: Emit it in `buildXmp`**

In `buildXmp`, after the `pdfaDesc` const (~line 165), add:

```ts
  const pdfuaDesc = meta.pdfuaPart !== undefined
    ? `\n  <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"`
      + ` pdfuaid:part="${meta.pdfuaPart}"/>`
    : '';
```

and change the return template's `</rdf:Description>${pdfaDesc}` line (~line 172) to:

```ts
  </rdf:Description>${pdfaDesc}${pdfuaDesc}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/xmp.test.ts -t pdfuaid`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/xmp.ts test/xmp.test.ts
git commit -m "feat(xmp): pdfuaid:part build + read support"
```

---

### Task 3: `pdfuaconvert.ts` harness + `identificationPass` + facade

Stand up the engine with one pass (identification), the facade method, and the index export. Establishes `convertToPdfUa` / `PdfUaConvertOptions` for later tasks.

**Files:**
- Create: `src/pdfuaconvert.ts`
- Modify: `src/document.ts` (add `ConvertToPdfUa` after `ConvertToPdfA` ~line 476; add import)
- Modify: `src/index.ts`
- Test: `test/pdfuaconvert.test.ts`

**Interfaces:**
- Consumes: `ConvertAction`/`ConversionReport` from `conversion.ts` (Task 1); `validatePdfUa(doc, catalog)` from `structvalidate.ts`; `XmpMetadata.pdfuaPart` (Task 2).
- Produces: `interface PdfUaConvertOptions { lang?: string; title?: string; roleMap?: Record<string, string>; }`; `function convertToPdfUa(doc: Document, catalog: PdfDict, opts?: PdfUaConvertOptions): ConversionReport`; `Document.ConvertToPdfUa(opts?: PdfUaConvertOptions): ConversionReport`; internal `type Uctx` and `type Pass`.

- [ ] **Step 1: Write the failing test**

Create `test/pdfuaconvert.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildUaPdf } from './helpers/build-ua-pdf.js';

const open = (b: Uint8Array) => Document.Open(b);

describe('ConvertToPdfUa — identification', () => {
  it('writes pdfuaid:part 1 and reports the action', () => {
    const doc = open(buildUaPdf());
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).toContain('PdfuaIdentification');
    expect(doc.GetXmp().pdfuaPart).toBe(1);
  });
  it('round-trips pdfuaid through Save/Open', () => {
    const doc = open(buildUaPdf());
    doc.ConvertToPdfUa();
    expect(open(doc.Save()).GetXmp().pdfuaPart).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pdfuaconvert.test.ts`
Expected: FAIL — `doc.ConvertToPdfUa is not a function`.

- [ ] **Step 3: Create `src/pdfuaconvert.ts`**

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject } from './types.js';
import { validatePdfUa } from './structvalidate.js';
import type { ConvertAction, ConversionReport } from './conversion.js';

export interface PdfUaConvertOptions {
  /** Catalog /Lang (e.g. 'en-US'); resolves NaturalLanguage. Never fabricated. */
  lang?: string;
  /** Fallback /Info /Title, used only when no title is already present. */
  title?: string;
  /** Custom-role -> standard-type mappings added to /StructTreeRoot /RoleMap. */
  roleMap?: Record<string, string>;
}

interface Uctx {
  doc: Document;
  catalog: PdfDict;
  opts: PdfUaConvertOptions;
  R(o: PdfObject | undefined): PdfObject;
}

type Pass = (ctx: Uctx) => ConvertAction[];

/** Write the required PDF/UA-1 identification metadata (pdfuaid:part 1). */
const identificationPass: Pass = (ctx) => {
  ctx.doc.SetXmp({ pdfuaPart: 1 });
  return [{ rule: 'PdfuaIdentification', action: 'Wrote pdfuaid:part 1 XMP identification.' }];
};

const PASSES: Pass[] = [identificationPass];

/** Remediate `doc` toward PDF/UA-1, then re-validate. The facade supplies the
 *  catalog (mirrors validatePdfUa). Mutates the live model in place. */
export function convertToPdfUa(
  doc: Document, catalog: PdfDict, opts: PdfUaConvertOptions = {},
): ConversionReport {
  const ctx: Uctx = { doc, catalog, opts, R: (o) => doc.resolve(o) };
  const applied: ConvertAction[] = [];
  for (const pass of PASSES) applied.push(...pass(ctx));
  const unresolved = validatePdfUa(doc, catalog).Errors;
  return { applied, unresolved, passed: unresolved.length === 0 };
}
```

- [ ] **Step 4: Add the facade method in `document.ts`**

Add the import near the other conversion imports (where `convertToPdfA` is imported):

```ts
import { convertToPdfUa, type PdfUaConvertOptions } from './pdfuaconvert.js';
```

After `ConvertToPdfA` (~line 476), add:

```ts
  /** Remediate the document toward PDF/UA-1 (mechanical fixes only), then
   *  re-validate. Mutates the live model in place; defects requiring human
   *  authoring (alt text, structure, untagged content) are reported, not fixed. */
  ConvertToPdfUa(opts?: PdfUaConvertOptions): ConversionReport {
    this.markModified();
    return convertToPdfUa(this, this.catalog(), opts);
  }
```

(`ConversionReport` is already imported in `document.ts` for `ConvertToPdfA`; if it was imported from `./pdfaconvert.js`, leave it — the re-export from Task 1 keeps it valid.)

- [ ] **Step 5: Export from `index.ts`**

Add:

```ts
export type { PdfUaConvertOptions } from './pdfuaconvert.js';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/pdfuaconvert.test.ts`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
git add src/pdfuaconvert.ts src/document.ts src/index.ts test/pdfuaconvert.test.ts
git commit -m "feat(pdfua): ConvertToPdfUa harness + identification pass"
```

---

### Task 4: `markedPass` + `langPass`

**Files:**
- Modify: `src/pdfuaconvert.ts`
- Test: `test/pdfuaconvert.test.ts`

**Interfaces:**
- Consumes: `Uctx`, `Pass`, `PASSES` (Task 3); `doc.GetStructTree()`, `doc.Lang` getter/setter from `document.ts`.
- Produces: passes resolving `Tagged` (Marked half) and `NaturalLanguage`.

- [ ] **Step 1: Write the failing tests**

Add to `test/pdfuaconvert.test.ts`:

```ts
describe('ConvertToPdfUa — marked + lang', () => {
  const after = (b: Uint8Array, opts?: any) => {
    const d = open(b); d.ConvertToPdfUa(opts); return d.ValidatePdfUa().Errors.map((e) => e.rule);
  };
  it('sets /MarkInfo /Marked true', () => {
    const doc = open(buildUaPdf({ marked: false }));
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).toContain('Tagged');
    expect(doc.ValidatePdfUa().Errors.map((e) => e.rule)).not.toContain('Tagged');
  });
  it('does not fabricate tagging for an untagged doc', () => {
    const doc = open(buildUaPdf({ tagged: false }));
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).not.toContain('Tagged');
    expect(doc.ValidatePdfUa().Errors.map((e) => e.rule)).toContain('Tagged');
  });
  it('sets catalog /Lang from opts.lang', () => {
    expect(after(buildUaPdf({ lang: null }), { lang: 'en-US' })).not.toContain('NaturalLanguage');
  });
  it('leaves NaturalLanguage unresolved when no lang supplied and none present', () => {
    expect(after(buildUaPdf({ lang: null }))).toContain('NaturalLanguage');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pdfuaconvert.test.ts -t "marked + lang"`
Expected: FAIL — `Tagged`/`NaturalLanguage` still present after conversion; no `Tagged` action.

- [ ] **Step 3: Implement the two passes**

In `src/pdfuaconvert.ts`, add `isDict` to the `types.js` import:

```ts
import { PdfDict, PdfObject, isDict } from './types.js';
```

Add the passes above `const PASSES`:

```ts
/** Mark a tagged document as such: /MarkInfo /Marked true. No struct tree ->
 *  no-op (Tagged stays unresolved; tagging is never fabricated). */
const markedPass: Pass = (ctx) => {
  if (ctx.doc.GetStructTree() === null) return [];
  let mi = ctx.R(ctx.catalog.get('MarkInfo'));
  if (!isDict(mi)) { mi = new Map<string, PdfObject>(); ctx.catalog.set('MarkInfo', mi); }
  if ((mi as PdfDict).get('Marked') === true) return [];
  (mi as PdfDict).set('Marked', true);
  ctx.doc.markModified();
  return [{ rule: 'Tagged', action: 'Set catalog /MarkInfo /Marked true.' }];
};

/** Set the catalog /Lang from opts.lang, resolving NaturalLanguage document-wide.
 *  Omitted lang -> no-op; a language is never invented. */
const langPass: Pass = (ctx) => {
  const lang = ctx.opts.lang;
  if (lang === undefined || ctx.doc.Lang === lang) return [];
  ctx.doc.Lang = lang; // setter writes catalog /Lang + markModified
  return [{ rule: 'NaturalLanguage', action: `Set catalog /Lang to '${lang}'.` }];
};
```

- [ ] **Step 4: Register the passes (order matters)**

Change `PASSES` to:

```ts
const PASSES: Pass[] = [markedPass, langPass, identificationPass];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/pdfuaconvert.test.ts`
Expected: PASS (all cases so far).

- [ ] **Step 6: Commit**

```bash
git add src/pdfuaconvert.ts test/pdfuaconvert.test.ts
git commit -m "feat(pdfua): marked + lang conversion passes"
```

---

### Task 5: `titlePass` + `displayDocTitlePass`

**Files:**
- Modify: `src/pdfuaconvert.ts`
- Test: `test/pdfuaconvert.test.ts`

**Interfaces:**
- Consumes: `doc.GetMetadata()`, `doc.GetXmp()`, `doc.SetMetadata()` from `document.ts`.
- Produces: passes resolving `DocumentTitle` and `DisplayDocTitle`.

- [ ] **Step 1: Write the failing tests**

Add to `test/pdfuaconvert.test.ts`:

```ts
describe('ConvertToPdfUa — title + DisplayDocTitle', () => {
  const after = (b: Uint8Array, opts?: any) => {
    const d = open(b); d.ConvertToPdfUa(opts); return d.ValidatePdfUa().Errors.map((e) => e.rule);
  };
  it('sets a missing title from opts.title', () => {
    expect(after(buildUaPdf({ title: null }), { title: 'My Doc' })).not.toContain('DocumentTitle');
  });
  it('leaves DocumentTitle unresolved when no title is available', () => {
    expect(after(buildUaPdf({ title: null }))).toContain('DocumentTitle');
  });
  it('keeps an existing title (no opts.title needed)', () => {
    expect(after(buildUaPdf({ title: 'Present' }))).not.toContain('DocumentTitle');
  });
  it('sets /ViewerPreferences /DisplayDocTitle true', () => {
    expect(after(buildUaPdf({ displayDocTitle: false }))).not.toContain('DisplayDocTitle');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pdfuaconvert.test.ts -t "title + DisplayDocTitle"`
Expected: FAIL — `DocumentTitle` / `DisplayDocTitle` still present.

- [ ] **Step 3: Implement the two passes**

In `src/pdfuaconvert.ts`, add the passes above `const PASSES`:

```ts
/** Ensure a document title. Keep any non-empty /Info /Title or XMP dc:title;
 *  else set /Info /Title from opts.title. No title available -> no-op. */
const titlePass: Pass = (ctx) => {
  const has = (s?: string) => s !== undefined && s.trim() !== '';
  if (has(ctx.doc.GetMetadata().title) || has(ctx.doc.GetXmp().title)) return [];
  const t = ctx.opts.title;
  if (t === undefined) return [];
  ctx.doc.SetMetadata({ title: t });
  return [{ rule: 'DocumentTitle', action: `Set /Info /Title to '${t}'.` }];
};

/** Set catalog /ViewerPreferences /DisplayDocTitle true (creating the dict). */
const displayDocTitlePass: Pass = (ctx) => {
  let vp = ctx.R(ctx.catalog.get('ViewerPreferences'));
  if (!isDict(vp)) { vp = new Map<string, PdfObject>(); ctx.catalog.set('ViewerPreferences', vp); }
  if ((vp as PdfDict).get('DisplayDocTitle') === true) return [];
  (vp as PdfDict).set('DisplayDocTitle', true);
  ctx.doc.markModified();
  return [{ rule: 'DisplayDocTitle', action: 'Set /ViewerPreferences /DisplayDocTitle true.' }];
};
```

- [ ] **Step 4: Register the passes**

Change `PASSES` to:

```ts
const PASSES: Pass[] = [markedPass, titlePass, displayDocTitlePass, langPass, identificationPass];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/pdfuaconvert.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pdfuaconvert.ts test/pdfuaconvert.test.ts
git commit -m "feat(pdfua): title + DisplayDocTitle conversion passes"
```

---

### Task 6: `roleMapPass` + `suspectsPass`

**Files:**
- Modify: `src/pdfuaconvert.ts`
- Test: `test/pdfuaconvert.test.ts`

**Interfaces:**
- Consumes: `doc.GetStructTree()` → `StructTreeRoot` with `.Children`, `.ResolveRole(role)`, `.RegisterRole(custom, standard)`; `StructElement.Type` / `.Children`; `STANDARD_STRUCTURE_TYPES` from `struct.ts`.
- Produces: passes resolving `StandardType` and clearing the `Suspects` warning.

- [ ] **Step 1: Write the failing tests**

Add to `test/pdfuaconvert.test.ts`:

```ts
describe('ConvertToPdfUa — roleMap + suspects', () => {
  // A custom-role node that is NOT mapped in the fixture's /RoleMap.
  const customRoot = [{ type: 'Document', children: [{ type: 'MyHeading', mcid: 0, text: 'H' }] }];
  const after = (b: Uint8Array, opts?: any) => {
    const d = open(b); d.ConvertToPdfUa(opts); return d.ValidatePdfUa().Errors.map((e) => e.rule);
  };
  it('maps an unmapped custom role via opts.roleMap', () => {
    const errs = after(buildUaPdf({ root: customRoot }), { roleMap: { MyHeading: 'H1' } });
    expect(errs).not.toContain('StandardType');
  });
  it('skips a mapping whose target is non-standard (role stays unresolved)', () => {
    const errs = after(buildUaPdf({ root: customRoot }), { roleMap: { MyHeading: 'NotAType' } });
    expect(errs).toContain('StandardType');
  });
  it('clears /MarkInfo /Suspects', () => {
    const doc = open(buildUaPdf({ suspects: true }));
    const report = doc.ConvertToPdfUa();
    expect(report.applied.map((a) => a.rule)).toContain('Suspects');
    expect(doc.ValidatePdfUa().Warnings.map((w) => w.rule)).not.toContain('Suspects');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pdfuaconvert.test.ts -t "roleMap + suspects"`
Expected: FAIL — `StandardType` still present; `Suspects` warning still present; no `Suspects` action.

- [ ] **Step 3: Implement the two passes**

In `src/pdfuaconvert.ts`, extend the `struct.js` usage by adding an import:

```ts
import { STANDARD_STRUCTURE_TYPES } from './struct.js';
import type { StructElement } from './struct.js';
```

Add the passes above `const PASSES`:

```ts
/** Add opts.roleMap entries to /StructTreeRoot /RoleMap, but only for custom
 *  roles actually used in the tree, not already resolvable, whose target is a
 *  standard type. Never adds dead or non-standard mappings. */
const roleMapPass: Pass = (ctx) => {
  const map = ctx.opts.roleMap;
  const tree = ctx.doc.GetStructTree();
  if (!map || tree === null) return [];
  const used = new Set<string>();
  const walk = (els: StructElement[]): void => {
    for (const e of els) { used.add(e.Type); walk(e.Children); }
  };
  walk(tree.Children);
  const actions: ConvertAction[] = [];
  for (const [custom, standard] of Object.entries(map)) {
    if (!used.has(custom)) continue;                                  // dead entry
    if (STANDARD_STRUCTURE_TYPES.has(tree.ResolveRole(custom))) continue; // already ok
    if (!STANDARD_STRUCTURE_TYPES.has(standard)) continue;           // target not standard
    tree.RegisterRole(custom, standard);
    actions.push({ rule: 'StandardType', action: `Mapped /RoleMap '${custom}' -> '${standard}'.` });
  }
  return actions;
};

/** Clear /MarkInfo /Suspects when true (silences the Suspects warning). */
const suspectsPass: Pass = (ctx) => {
  const mi = ctx.R(ctx.catalog.get('MarkInfo'));
  if (!isDict(mi) || mi.get('Suspects') !== true) return [];
  mi.set('Suspects', false);
  ctx.doc.markModified();
  return [{ rule: 'Suspects', action: 'Cleared catalog /MarkInfo /Suspects.' }];
};
```

- [ ] **Step 4: Register the passes (final order)**

Change `PASSES` to:

```ts
const PASSES: Pass[] = [
  markedPass, titlePass, displayDocTitlePass, langPass, roleMapPass, suspectsPass, identificationPass,
];
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/pdfuaconvert.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pdfuaconvert.ts test/pdfuaconvert.test.ts
git commit -m "feat(pdfua): roleMap + suspects conversion passes"
```

---

### Task 7: End-to-end report behavior + round-trip + README

Verify the honest-report contract (mechanical fixes applied; human-authoring defects stay unresolved) and persistence across Save/Open, then document the feature.

**Files:**
- Test: `test/pdfuaconvert.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 3–6.

- [ ] **Step 1: Write the failing tests**

Add to `test/pdfuaconvert.test.ts`:

```ts
describe('ConvertToPdfUa — end to end', () => {
  // All-mechanical defects fixable with matching opts.
  const fixable = () => buildUaPdf({
    marked: false, lang: null, title: null, displayDocTitle: false, suspects: true,
    root: [{ type: 'Document', children: [{ type: 'MyHeading', mcid: 0, text: 'H' }] }],
  });
  it('reaches passed=true once every mechanical defect is fixed', () => {
    const doc = open(fixable());
    const report = doc.ConvertToPdfUa({ lang: 'en-US', title: 'Doc', roleMap: { MyHeading: 'H1' } });
    expect(report.passed).toBe(true);
    expect(report.unresolved).toHaveLength(0);
  });
  it('leaves human-authoring defects unresolved but still applies mechanical fixes', () => {
    // A Figure with no /Alt cannot be auto-fixed.
    const doc = open(buildUaPdf({
      marked: false,
      root: [{ type: 'Document', children: [{ type: 'Figure', mcid: 0, text: 'x' }] }],
    }));
    const report = doc.ConvertToPdfUa();
    expect(report.passed).toBe(false);
    expect(report.unresolved.map((e) => e.rule)).toContain('IllustrationAlt');
    expect(report.applied.map((a) => a.rule)).toContain('Tagged'); // mechanical fix still done
  });
  it('persists all fixes across Save/Open', () => {
    const doc = open(fixable());
    doc.ConvertToPdfUa({ lang: 'en-US', title: 'Doc', roleMap: { MyHeading: 'H1' } });
    const r = open(doc.Save());
    expect(r.Lang).toBe('en-US');
    expect(r.ValidatePdfUa().Passed).toBe(true);
    expect(r.GetXmp().pdfuaPart).toBe(1);
  });
});
```

Note: `ValidationReport` exposes `Passed`/`Errors`/`Warnings`/`Issues` (capital initials) — see [src/validation.ts](../../../src/validation.ts).

- [ ] **Step 2: Run tests to verify they fail/pass**

Run: `npx vitest run test/pdfuaconvert.test.ts -t "end to end"`
Expected: these should largely PASS already (passes implemented in Tasks 3–6). Treat any genuine failure as a real bug and debug before continuing.

- [ ] **Step 3: Run the full PDF/UA test file**

Run: `npx vitest run test/pdfuaconvert.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 4: Update README**

In `README.md` "Features", add a bullet near the PDF/A and PDF/UA validation entries:

```markdown
- **PDF/UA remediation** — `doc.ConvertToPdfUa(opts?)` mechanically fixes the
  deterministic PDF/UA-1 defects (catalog `/Lang`, `DisplayDocTitle`, `/Marked`,
  document title, `/RoleMap` entries, clears `/Suspects`, writes `pdfuaid`
  identification) and re-validates, returning a `ConversionReport`.
```

In "Limitations", add:

```markdown
- PDF/UA conversion is mechanical only. Alt text, reading order, heading/table/
  list structure, and tagging of untagged content require human authoring — they
  are reported in `ConversionReport.unresolved`, never synthesized.
```

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire suite green.

- [ ] **Step 6: Commit**

```bash
git add test/pdfuaconvert.test.ts README.md
git commit -m "test(pdfua): end-to-end report + round-trip; docs: PDF/UA conversion"
```

---

## Self-Review

**Spec coverage:**
- `ConvertToPdfUa(opts?)` facade + `PdfUaConvertOptions` (lang/title/roleMap) → Task 3 (+4–6 options).
- Shared `conversion.ts` extraction → Task 1.
- Passes: markedPass (Task 4), titlePass + displayDocTitlePass (Task 5), langPass (Task 4), roleMapPass + suspectsPass (Task 6), identificationPass (Task 3). All seven spec passes covered.
- `pdfuaid` XMP read/build → Task 2.
- Re-validation → `unresolved`/`passed` in Task 3 harness; honest-report contract → Task 7.
- Module boundaries (conversion.ts deps; pdfuaconvert deps; index exports) → Tasks 1, 3.
- Tests: per-pass (Tasks 4–6), round-trip + untagged + non-standard-target + end-to-end (Tasks 4, 6, 7).
- README Features + Limitations → Task 7.

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output.

**Type consistency:** `Uctx`/`Pass`/`PASSES`/`convertToPdfUa`/`PdfUaConvertOptions` consistent across Tasks 3–7. `ConvertAction`/`ConversionReport` from `conversion.ts` (Task 1) consumed everywhere. `StructTreeRoot.RegisterRole`/`ResolveRole`/`Children` and `StructElement.Type`/`Children` match `struct.ts`. `XmpMetadata.pdfuaPart` (Task 2) consumed by `identificationPass` (Task 3) and asserted in Tasks 3/7.
