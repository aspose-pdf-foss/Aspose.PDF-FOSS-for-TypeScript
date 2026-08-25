# PDF/UA Validation Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a curated, machine-checkable PDF/UA-1 validator exposed as `Document.ValidatePdfUa(): ValidationReport`, reporting structured per-issue results over the tagged-PDF read model.

**Architecture:** A new pure read-only rule engine (`src/structvalidate.ts`) runs an ordered list of rule functions over the structure tree, catalog, metadata, and (for one heuristic rule) the content walk, concatenating their issues into a `ValidationReport`. The `Document` facade wraps it. The content walk in `text.ts` gains additive artifact-scope tracking so the untagged-content rule can tell real content from artifacts.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest. Zero runtime dependencies (only `node:` built-ins).

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins; do not add npm runtime deps.
- **ESM + NodeNext** — every relative import specifier carries a `.js` extension (e.g. `import { StructElement } from './struct.js'`).
- **TDD** — write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Read-only** — the validator never mutates the document.
- **Quality gates before any close** — `npm run typecheck` and `npm test` must both be green.
- **Severity model** — `Passed` is true when there are zero `error`-severity issues; `warning`-severity issues never flip `Passed` to false.

---

## File Structure

- **Create** `src/structvalidate.ts` — `Severity`, `ValidationIssue`, `ValidationReport`, the `validatePdfUa(doc, catalog)` engine, and all rule functions + the tree pre-order walk helper.
- **Modify** `src/text.ts` — additive artifact-scope tracking; new `artifact?` field on `GlyphEvent`, new `mcid?`/`artifact?` fields on `ImageEvent`.
- **Modify** `src/document.ts` — add the `ValidatePdfUa()` facade method.
- **Modify** `src/index.ts` — export `ValidationReport`, `ValidationIssue`, `Severity`.
- **Create** `test/helpers/build-artifact-pdf.ts` — fixed one-page fixture with a tagged MCID run, an `/Artifact` run, and an untagged run.
- **Create** `test/helpers/build-ua-pdf.ts` — parameterized tagged-PDF builder (struct tree + catalog flags + tagged content runs) for rule-specific fixtures.
- **Create** `test/structvalidate.test.ts` — the validator test suite.
- **Modify** `test/text.test.ts` (or a new `test/artifact.test.ts` if cleaner) — the artifact-tracking test.
- **Modify** `README.md` — Features + Limitations.

---

## Task 1: Artifact-scope tracking in the content walk

**Files:**
- Modify: `src/text.ts` (`GlyphEvent`, `ImageEvent`, `walkScope`, `emitGlyphs`, `emitGlyphArray`, `emitImage`)
- Create: `test/helpers/build-artifact-pdf.ts`
- Test: `test/artifact.test.ts`

**Interfaces:**
- Consumes: existing `visitContent(doc, page, visitor)`, `ContentVisitor` (`glyph?`, `image?`), `GlyphEvent`, `ImageEvent`.
- Produces: `GlyphEvent.artifact?: boolean`; `ImageEvent.mcid?: number`; `ImageEvent.artifact?: boolean`. A glyph/image emitted inside any `/Artifact` marked-content scope has `artifact === true`; one inside an MCID scope has `mcid` set and `artifact` falsy.

- [ ] **Step 1: Write the failing test**

Create `test/helpers/build-artifact-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page tagged PDF with three text runs in the content stream:
 *  - MCID 0 ("Tagged") inside /P <</MCID 0>> BDC … EMC
 *  - "Header" inside /Artifact BDC … EMC
 *  - "Loose" with no marked-content wrapper (untagged real content)
 *  Struct tree: Document(8) > P(9) /Pg 3 /K 0. ParentTree key 0 -> [9]. */
export function buildArtifactPdf(): Uint8Array {
  const content =
    '/P <</MCID 0>> BDC\nBT /F1 12 Tf 50 350 Td (Tagged) Tj ET\nEMC\n' +
    '/Artifact BDC\nBT /F1 12 Tf 50 320 Td (Header) Tj ET\nEMC\n' +
    'BT /F1 12 Tf 50 290 Td (Loose) Tj ET\n';

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = `<< >>`;
  objects[7] = `<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 12 0 R >>`;
  objects[8] = `<< /Type /StructElem /S /Document /P 7 0 R /K [9 0 R] >>`;
  objects[9] = `<< /Type /StructElem /S /P /P 8 0 R /Pg 3 0 R /K 0 >>`;
  objects[12] = `<< /Nums [0 [9 0 R]] >>`;
  const maxObj = 12;

  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
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
      ? `0000000000 00000 f \n`
      : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

Create `test/artifact.test.ts`. The assertions that matter: a glyph in the MCID run has `mcid===0`; a glyph in the `/Artifact` run has `artifact===true` and `mcid===undefined`; a loose glyph has both undefined.

```ts
import { describe, it, expect } from 'vitest';
import { Document, visitContent } from '../src/index.js';
import type { GlyphEvent } from '../src/index.js';
import { buildArtifactPdf } from './helpers/build-artifact-pdf.js';

describe('content walk artifact tracking', () => {
  it('tags glyphs with mcid / artifact / loose provenance', () => {
    const doc = Document.Open(buildArtifactPdf());
    const runs: Record<string, { mcid?: number; artifact?: boolean }> = {};
    visitContent(doc, doc.Pages[0], {
      glyph: (e: GlyphEvent) => {
        const tag = e.mcid !== undefined ? `mcid${e.mcid}` : e.artifact ? 'artifact' : 'loose';
        runs[tag] ??= { mcid: e.mcid, artifact: e.artifact };
      },
    });
    expect(runs['mcid0']).toBeTruthy();
    expect(runs['artifact']).toEqual({ mcid: undefined, artifact: true });
    expect(runs['loose']).toEqual({ mcid: undefined, artifact: undefined });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/artifact.test.ts`
Expected: FAIL — `runs['artifact']` is `undefined` (no `artifact` field emitted yet), so `.toEqual({...})` fails.

- [ ] **Step 3: Add the event fields**

In `src/text.ts`, add to `GlyphEvent` (after the `mcid?: number;` field):

```ts
  /** True when this glyph was drawn inside an /Artifact marked-content scope. */
  artifact?: boolean;
```

Extend `ImageEvent` with the same provenance fields:

```ts
export interface ImageEvent {
  addr: ContentAddr;
  /** Device-space box of the unit square mapped through the CTM. */
  quad: [number, number, number, number];
  kind: 'xobject' | 'inline';
  /** The innermost active marked-content MCID, or undefined when untagged. */
  mcid?: number;
  /** True when drawn inside an /Artifact marked-content scope. */
  artifact?: boolean;
}
```

- [ ] **Step 4: Track artifact scope in `walkScope` and thread it into emitters**

In `walkScope`, alongside `const mcidStack` and `let activeMcid`, add:

```ts
  const artifactStack: boolean[] = [];
  let inArtifact = false;
```

Replace the `BMC`, `BDC`, and `EMC` cases with:

```ts
        case 'BMC':
          mcidStack.push(activeMcid); artifactStack.push(inArtifact);
          if (isArtifactTag(op.operands[0])) inArtifact = true;
          break;
        case 'BDC': {
          mcidStack.push(activeMcid); artifactStack.push(inArtifact);
          if (isArtifactTag(op.operands[0])) inArtifact = true;
          const m = mcidFromProps(ctx.doc, properties, op.operands[1]);
          if (m !== undefined) activeMcid = m;
          break;
        }
        case 'EMC':
          if (mcidStack.length) activeMcid = mcidStack.pop();
          if (artifactStack.length) inArtifact = artifactStack.pop()!;
          break;
```

Update the four glyph-emitting cases to pass `inArtifact`:

```ts
        case 'Tj': emitGlyphs(ctx, st, op.operands[0], curCtm, addr, 0, activeMcid, inArtifact); break;
        case 'TJ': emitGlyphArray(ctx, st, op.operands[0], curCtm, addr, activeMcid, inArtifact); break;
        case "'": lineMove(st, 0, -st.leading); emitGlyphs(ctx, st, op.operands[0], curCtm, addr, 0, activeMcid, inArtifact); break;
        case '"': {
          st.wordSp = num(op.operands[0]); st.charSp = num(op.operands[1]);
          lineMove(st, 0, -st.leading); emitGlyphs(ctx, st, op.operands[2], curCtm, addr, 0, activeMcid, inArtifact); break;
        }
```

Update the inline-image and XObject-image emit calls:

```ts
        case 'BI': if (op.inlineImage) emitImage(ctx, curCtm, addr, 'inline', activeMcid, inArtifact); break;
```

and in the `Do` case, the image branch:

```ts
          if (isImageXObject(ctx.doc, xo.dict)) { emitImage(ctx, curCtm, addr, 'xobject', activeMcid, inArtifact); break; }
```

Update the emitter signatures/bodies:

```ts
function emitGlyphs(ctx: Ctx, st: TextState, strObj: PdfObject, ctm: Matrix, addr: ContentAddr, elementIndex: number, mcid?: number, artifact?: boolean): void {
  if (!isString(strObj) || !st.font) return;
  for (const g of st.font.decodeGlyphs(strObj.bytes)) {
    const startTm = st.tm;
    const adv = (g.width * st.fontSize + st.charSp + (g.isWordSpace ? st.wordSp : 0)) * st.hscale;
    st.tm = mul(translate(adv, 0), st.tm);
    const startComb = mul(startTm, ctm);
    const [x, y] = apply(startComb, 0, st.rise);
    const [endX] = apply(mul(st.tm, ctm), 0, st.rise);
    const size = st.fontSize * vscale(startComb);
    const advance = st.fontSize !== 0
      ? g.width + (st.charSp + (g.isWordSpace ? st.wordSp : 0)) / st.fontSize
      : 0;
    ctx.visitor.glyph?.({
      addr, font: st.font, quad: [x, y, endX, y + size], text: g.text,
      fontSize: size, elementIndex, byteStart: g.byteStart, byteLen: g.byteLen, advance, mcid, artifact,
    });
  }
}

function emitGlyphArray(ctx: Ctx, st: TextState, arrObj: PdfObject, ctm: Matrix, addr: ContentAddr, mcid?: number, artifact?: boolean): void {
  if (!isArray(arrObj) || !st.font) return;
  arrObj.forEach((el, idx) => {
    if (isString(el)) emitGlyphs(ctx, st, el, ctm, addr, idx, mcid, artifact);
    else if (typeof el === 'number') {
      const shift = (-el / 1000) * st.fontSize * st.hscale;
      st.tm = mul(translate(shift, 0), st.tm);
    }
  });
}

function emitImage(ctx: Ctx, ctm: Matrix, addr: ContentAddr, kind: 'xobject' | 'inline', mcid?: number, artifact?: boolean): void {
  if (!ctx.visitor.image) return;
  ctx.visitor.image({ addr, quad: bboxOfUnitSquare(ctm), kind, mcid, artifact });
}
```

Add the helper near `mcidFromProps`:

```ts
/** True when a BMC/BDC tag operand is the /Artifact tag. */
function isArtifactTag(operand: PdfObject | undefined): boolean {
  return isName(operand) && operand.name === 'Artifact';
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/artifact.test.ts test/text.test.ts test/struct.test.ts`
Expected: PASS (existing text/struct tests unaffected — the new fields are additive and optional).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/text.ts test/helpers/build-artifact-pdf.ts test/artifact.test.ts
git commit -m "feat(text): track /Artifact scope in content walk (S5)"
```

---

## Task 2: Report types, engine skeleton, facade, and the Tagged rule

**Files:**
- Create: `src/structvalidate.ts`
- Modify: `src/document.ts` (add `ValidatePdfUa()`)
- Modify: `src/index.ts` (exports)
- Create: `test/helpers/build-ua-pdf.ts`
- Test: `test/structvalidate.test.ts`

**Interfaces:**
- Consumes: `Document` (`GetStructTree()`, `IsTagged`, `Lang`, `GetMetadata()`, `GetXmp()`, `resolve()`, private `catalog()`), `StructTreeRoot`, `StructElement`, `Page`, `PdfDict`, `isDict`.
- Produces:
  - `type Severity = 'error' | 'warning'`
  - `interface ValidationIssue { rule: string; severity: Severity; message: string; clause?: string; element?: StructElement; page?: Page }`
  - `class ValidationReport { constructor(issues: ValidationIssue[]); readonly Issues: ValidationIssue[]; get Errors(): ValidationIssue[]; get Warnings(): ValidationIssue[]; get Passed(): boolean }`
  - `function validatePdfUa(doc: Document, catalog: PdfDict): ValidationReport`
  - `Document.ValidatePdfUa(): ValidationReport`
  - Test builder `buildUaPdf(opts?: UaOptions): Uint8Array` with `UaOptions` / `UaNode` (below).

- [ ] **Step 1: Write the test fixture builder**

Create `test/helpers/build-ua-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

export interface UaNode {
  type: string;              // /S structure type
  alt?: string;              // /Alt
  actualText?: string;       // /ActualText
  lang?: string;             // /Lang
  mcid?: number;             // tagged content run owned by this element
  text?: string;             // glyph text for the mcid run (ASCII, no parens)
  roleMapTo?: string;        // register `type` -> this standard type in /RoleMap
  children?: UaNode[];
}

export interface UaOptions {
  tagged?: boolean;          // default true; false omits /StructTreeRoot + /MarkInfo
  marked?: boolean;          // default true; /MarkInfo /Marked value
  lang?: string | null;      // default 'en-US'; null omits catalog /Lang
  title?: string | null;     // default 'Test Document'; null omits /Info /Title
  displayDocTitle?: boolean; // default true; /ViewerPreferences /DisplayDocTitle
  suspects?: boolean;        // default false; /MarkInfo /Suspects true when set
  root?: UaNode[];           // default [{ Document > P mcid 0 }]
}

interface Flat { node: UaNode; num: number; parentRef: string; }

/** Assign object numbers (pre-order from `start`) to every node; collect refs. */
function flatten(nodes: UaNode[], parentRef: string, next: { n: number }, out: Flat[]): string[] {
  const refs: string[] = [];
  for (const node of nodes) {
    const num = next.n++;
    refs.push(`${num} 0 R`);
    out.push({ node, num, parentRef });
    if (node.children) flatten(node.children, `${num} 0 R`, next, out);
  }
  return refs;
}

export function buildUaPdf(opts: UaOptions = {}): Uint8Array {
  const tagged = opts.tagged ?? true;
  const marked = opts.marked ?? true;
  const lang = opts.lang === undefined ? 'en-US' : opts.lang;
  const title = opts.title === undefined ? 'Test Document' : opts.title;
  const displayDocTitle = opts.displayDocTitle ?? true;
  const suspects = opts.suspects ?? false;
  const root: UaNode[] = opts.root ?? [{ type: 'Document', children: [{ type: 'P', mcid: 0, text: 'Body' }] }];

  // Fixed objects 1..8; struct elems start at 9.
  const STRUCT_ROOT = 7, PARENT_TREE = 8;
  const flat: Flat[] = [];
  const topRefs = flatten(root, `${STRUCT_ROOT} 0 R`, { n: 9 }, flat);

  // Content runs + ParentTree, keyed by mcid.
  const byMcid: Record<number, string> = {};
  const runs: string[] = [];
  for (const f of flat) {
    const { node, num } = f;
    if (node.mcid !== undefined) {
      byMcid[node.mcid] = `${num} 0 R`;
      const y = 350 - 30 * node.mcid;
      runs[node.mcid] = `/${node.type} <</MCID ${node.mcid}>> BDC\nBT /F1 12 Tf 50 ${y} Td (${node.text ?? 'X'}) Tj ET\nEMC\n`;
    }
  }
  const content = runs.filter((s) => s !== undefined).join('');

  // RoleMap from any node.roleMapTo.
  const roleEntries = flat
    .filter((f) => f.node.roleMapTo)
    .map((f) => `/${f.node.type} /${f.node.roleMapTo}`)
    .join(' ');

  // ParentTree Nums: page key 0 -> array indexed by mcid.
  const maxMcid = Object.keys(byMcid).map(Number).reduce((a, b) => Math.max(a, b), -1);
  const ptArray = maxMcid < 0 ? '[]'
    : '[' + Array.from({ length: maxMcid + 1 }, (_, i) => byMcid[i] ?? 'null').join(' ') + ']';

  const objects: string[] = [];
  const markInfoParts: string[] = [];
  if (tagged) markInfoParts.push(`/Marked ${marked}`);
  if (suspects) markInfoParts.push(`/Suspects true`);
  const catParts = [`/Type /Catalog`, `/Pages 2 0 R`];
  if (tagged) catParts.push(`/StructTreeRoot ${STRUCT_ROOT} 0 R`);
  if (markInfoParts.length) catParts.push(`/MarkInfo << ${markInfoParts.join(' ')} >>`);
  if (lang !== null) catParts.push(`/Lang (${lang})`);
  if (displayDocTitle) catParts.push(`/ViewerPreferences << /DisplayDocTitle true >>`);

  objects[1] = `<< ${catParts.join(' ')} >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /StructParents 0 >>`;
  objects[4] = `<< /Length ${byteLen(content)} >>\nstream\n${content}endstream`;
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[6] = title === null ? `<< >>` : `<< /Title (${title}) >>`;
  if (tagged) {
    objects[STRUCT_ROOT] = `<< /Type /StructTreeRoot /K [${topRefs.join(' ')}] /ParentTree ${PARENT_TREE} 0 R`
      + (roleEntries ? ` /RoleMap << ${roleEntries} >>` : '') + ` >>`;
    objects[PARENT_TREE] = `<< /Nums [0 ${ptArray}] >>`;
    for (const f of flat) {
      const { node, num, parentRef } = f;
      // /K = own mcid (if any) followed by child element refs (from the flat list).
      const kids: string[] = [];
      if (node.mcid !== undefined) kids.push(`${node.mcid}`);
      for (const fr of flat) if (fr.parentRef === `${num} 0 R`) kids.push(`${fr.num} 0 R`);
      const parts = [`/Type /StructElem`, `/S /${node.type}`, `/P ${parentRef}`];
      if (node.mcid !== undefined) parts.push(`/Pg 3 0 R`);
      parts.push(`/K [${kids.join(' ')}]`);
      if (node.alt !== undefined) parts.push(`/Alt (${node.alt})`);
      if (node.actualText !== undefined) parts.push(`/ActualText (${node.actualText})`);
      if (node.lang !== undefined) parts.push(`/Lang (${node.lang})`);
      objects[num] = `<< ${parts.join(' ')} >>`;
    }
  }

  const maxObj = objects.reduce((m, _, i) => (objects[i] !== undefined ? i : m), 0);
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
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
      ? `0000000000 00000 f \n`
      : `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/structvalidate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildUaPdf } from './helpers/build-ua-pdf.js';

describe('ValidatePdfUa — report basics', () => {
  it('a well-formed tagged document passes with no errors', () => {
    const report = Document.Open(buildUaPdf()).ValidatePdfUa();
    expect(report.Errors).toEqual([]);
    expect(report.Passed).toBe(true);
  });

  it('an untagged document fails with a single Tagged error', () => {
    const report = Document.Open(buildUaPdf({ tagged: false })).ValidatePdfUa();
    expect(report.Passed).toBe(false);
    expect(report.Issues.map((i) => i.rule)).toEqual(['Tagged']);
    expect(report.Issues[0].severity).toBe('error');
  });

  it('flags Marked=false as a Tagged error but still runs other rules', () => {
    const report = Document.Open(buildUaPdf({ marked: false })).ValidatePdfUa();
    expect(report.Issues.some((i) => i.rule === 'Tagged')).toBe(true);
    expect(report.Passed).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/structvalidate.test.ts`
Expected: FAIL — `Document.ValidatePdfUa` is not a function.

- [ ] **Step 4: Create the engine and report types**

Create `src/structvalidate.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { PdfDict, PdfObject, isDict, isName } from './types.js';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  /** Stable rule id, e.g. 'FigureAlt'. */
  rule: string;
  severity: Severity;
  /** Human-readable description. */
  message: string;
  /** ISO 14289-1 / Matterhorn reference. */
  clause?: string;
  /** Offending structure element, when applicable. */
  element?: StructElement;
  /** Offending page, when applicable. */
  page?: Page;
}

/** The result of a PDF/UA validation pass. */
export class ValidationReport {
  constructor(readonly Issues: ValidationIssue[]) {}
  get Errors(): ValidationIssue[] { return this.Issues.filter((i) => i.severity === 'error'); }
  get Warnings(): ValidationIssue[] { return this.Issues.filter((i) => i.severity === 'warning'); }
  /** True when there are no error-severity issues (warnings are allowed). */
  get Passed(): boolean { return this.Errors.length === 0; }
}

/** Run the curated PDF/UA rule set over `doc`. `catalog` is the document catalog
 *  dict (the facade supplies it so catalog-only rules need no public accessor). */
export function validatePdfUa(doc: Document, catalog: PdfDict): ValidationReport {
  const tree = doc.GetStructTree();
  if (!tree) {
    return new ValidationReport([{
      rule: 'Tagged', severity: 'error', clause: 'ISO 14289-1 §7.1',
      message: 'Document is not tagged: no /StructTreeRoot in the catalog.',
    }]);
  }
  const issues: ValidationIssue[] = [];
  if (!doc.IsTagged) {
    issues.push({
      rule: 'Tagged', severity: 'error', clause: 'ISO 14289-1 §7.1',
      message: 'Catalog /MarkInfo /Marked is not true.',
    });
  }
  return new ValidationReport(issues);
}
```

- [ ] **Step 5: Add the facade method**

In `src/document.ts`, add the import near the other module imports (e.g. by `import { StructTreeRoot } from './struct.js';`):

```ts
import { validatePdfUa, ValidationReport } from './structvalidate.js';
```

Add the method on `class Document`, next to `GetStructTree()`:

```ts
  /** Validate the document against a curated, machine-checkable subset of
   *  PDF/UA-1 (ISO 14289-1) rules. Read-only; never mutates. */
  ValidatePdfUa(): ValidationReport {
    return validatePdfUa(this, this.catalog());
  }
```

- [ ] **Step 6: Export the public types**

In `src/index.ts`, add:

```ts
export { ValidationReport } from './structvalidate.js';
export type { ValidationIssue, Severity } from './structvalidate.js';
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run test/structvalidate.test.ts && npm run typecheck`
Expected: all three tests PASS; no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/structvalidate.ts src/document.ts src/index.ts test/helpers/build-ua-pdf.ts test/structvalidate.test.ts
git commit -m "feat(struct): PDF/UA validator skeleton + Tagged rule (S5)"
```

---

## Task 3: Document-level rules — DocumentTitle, DisplayDocTitle, Suspects

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/structvalidate.test.ts`

**Interfaces:**
- Consumes: `doc.GetMetadata().title`, `doc.GetXmp().title`, `catalog` dict (`ViewerPreferences`, `MarkInfo`), `doc.resolve`.
- Produces: appends `DocumentTitle` (error), `DisplayDocTitle` (error), `Suspects` (warning) issues to the report.

- [ ] **Step 1: Write the failing tests**

Append to `test/structvalidate.test.ts`:

```ts
describe('ValidatePdfUa — document-level rules', () => {
  const rules = (opts: Parameters<typeof buildUaPdf>[0]) =>
    Document.Open(buildUaPdf(opts)).ValidatePdfUa().Issues.map((i) => i.rule);

  it('requires a document title', () => {
    expect(rules({ title: null })).toContain('DocumentTitle');
    expect(rules({})).not.toContain('DocumentTitle');
  });

  it('requires /ViewerPreferences /DisplayDocTitle true', () => {
    expect(rules({ displayDocTitle: false })).toContain('DisplayDocTitle');
    expect(rules({})).not.toContain('DisplayDocTitle');
  });

  it('warns when /MarkInfo /Suspects is true', () => {
    const report = Document.Open(buildUaPdf({ suspects: true })).ValidatePdfUa();
    const suspect = report.Issues.find((i) => i.rule === 'Suspects');
    expect(suspect?.severity).toBe('warning');
    expect(report.Passed).toBe(true); // warning does not fail
    expect(rules({})).not.toContain('Suspects');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/structvalidate.test.ts -t "document-level"`
Expected: FAIL — none of the three rules are emitted yet.

- [ ] **Step 3: Implement the rules**

In `src/structvalidate.ts`, replace the body of `validatePdfUa` after the `!doc.IsTagged` block (before `return`) with these checks:

```ts
  // DocumentTitle — Info /Title or XMP dc:title must be non-empty.
  const title = doc.GetMetadata().title ?? doc.GetXmp().title;
  if (!title || title.trim() === '') {
    issues.push({
      rule: 'DocumentTitle', severity: 'error', clause: 'ISO 14289-1 §7.1 (Matterhorn 06-003)',
      message: 'Document has no title (/Info /Title and XMP dc:title are both empty).',
    });
  }

  // DisplayDocTitle — /ViewerPreferences /DisplayDocTitle must be true.
  const vp = doc.resolve(catalog.get('ViewerPreferences'));
  const ddt = isDict(vp) ? doc.resolve(vp.get('DisplayDocTitle')) : undefined;
  if (ddt !== true) {
    issues.push({
      rule: 'DisplayDocTitle', severity: 'error', clause: 'ISO 14289-1 §7.1 (Matterhorn 07-001)',
      message: 'Catalog /ViewerPreferences /DisplayDocTitle is not true.',
    });
  }

  // Suspects — /MarkInfo /Suspects must not be true (warning).
  const mi = doc.resolve(catalog.get('MarkInfo'));
  if (isDict(mi) && doc.resolve(mi.get('Suspects')) === true) {
    issues.push({
      rule: 'Suspects', severity: 'warning', clause: 'Matterhorn 01-005',
      message: 'Catalog /MarkInfo /Suspects is true: tagging may be unreliable.',
    });
  }
```

(The `PdfObject` import is already present; keep it. No new imports needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/structvalidate.test.ts`
Expected: PASS (including the Task 2 basics — the clean doc still has zero errors).

- [ ] **Step 5: Commit**

```bash
git add src/structvalidate.ts test/structvalidate.test.ts
git commit -m "feat(struct): PDF/UA DocumentTitle/DisplayDocTitle/Suspects rules (S5)"
```

---

## Task 4: Tree pre-order walk + StandardType, IllustrationAlt, NaturalLanguage

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/structvalidate.test.ts`

**Interfaces:**
- Consumes: `StructTreeRoot.Children`, `StructElement` (`Children`, `StandardType`, `IsStandardType`, `Alt`, `ActualText`, `EffectiveLang`, `ContentItems`).
- Produces: an internal `walkTree(tree)` → `WalkedNode[]` (pre-order), where `interface WalkedNode { element: StructElement; parentType: string | null }`; appends `StandardType` (error), `IllustrationAlt` (error), `NaturalLanguage` (error) issues.

- [ ] **Step 1: Write the failing tests**

Append to `test/structvalidate.test.ts`:

```ts
describe('ValidatePdfUa — element rules', () => {
  const rulesFor = (root: import('./helpers/build-ua-pdf.js').UaNode[], extra = {}) =>
    Document.Open(buildUaPdf({ root, ...extra })).ValidatePdfUa().Issues.map((i) => i.rule);

  it('flags a non-standard, unmapped structure type', () => {
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'Frobnicate', mcid: 0, text: 'x' }] }]);
    expect(rules).toContain('StandardType');
  });

  it('accepts a custom type mapped through /RoleMap', () => {
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'MyPara', roleMapTo: 'P', mcid: 0, text: 'x' }] }]);
    expect(rules).not.toContain('StandardType');
  });

  it('requires Alt or ActualText on Figure/Formula/Form', () => {
    const missing = rulesFor([{ type: 'Document', children: [{ type: 'Figure' }] }]);
    expect(missing).toContain('IllustrationAlt');
    const withAlt = rulesFor([{ type: 'Document', children: [{ type: 'Figure', alt: 'A chart' }] }]);
    expect(withAlt).not.toContain('IllustrationAlt');
  });

  it('requires a resolvable language for text-bearing elements', () => {
    // catalog /Lang removed and element has no /Lang -> EffectiveLang undefined.
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'P', mcid: 0, text: 'x' }] }], { lang: null });
    expect(rules).toContain('NaturalLanguage');
    // element-level /Lang satisfies it even without catalog /Lang.
    const ok = rulesFor([{ type: 'Document', children: [{ type: 'P', mcid: 0, text: 'x', lang: 'en' }] }], { lang: null });
    expect(ok).not.toContain('NaturalLanguage');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/structvalidate.test.ts -t "element rules"`
Expected: FAIL — these rules are not implemented.

- [ ] **Step 3: Add the walk helper and rules**

In `src/structvalidate.ts`, add the import for `StructTreeRoot`/`StructElement` types (already imported as types). Add the walk helper near the bottom of the file:

```ts
interface WalkedNode { element: StructElement; parentType: string | null; }

/** Depth-first pre-order over the structure tree. */
function walkTree(tree: StructTreeRoot): WalkedNode[] {
  const out: WalkedNode[] = [];
  const visit = (el: StructElement, parentType: string | null): void => {
    out.push({ element: el, parentType });
    for (const child of el.Children) visit(child, el.StandardType);
  };
  for (const top of tree.Children) visit(top, null);
  return out;
}

/** True when an element directly owns marked content (contributes glyphs). */
function isTextBearing(el: StructElement): boolean {
  return el.ContentItems.some((c) => c.kind === 'mcid');
}

const ILLUSTRATION = new Set(['Figure', 'Formula', 'Form']);
```

In `validatePdfUa`, before `return new ValidationReport(issues);`, add the tree walk and the three rules:

```ts
  const nodes = walkTree(tree);
  for (const { element } of nodes) {
    if (!element.IsStandardType) {
      issues.push({
        rule: 'StandardType', severity: 'error', clause: 'Matterhorn 02-001', element,
        message: `Structure type '${element.Type}' is not a standard type and is not mapped via /RoleMap.`,
      });
    }
    if (ILLUSTRATION.has(element.StandardType)) {
      const alt = element.Alt; const actual = element.ActualText;
      if (!(alt && alt.trim()) && !(actual && actual.trim())) {
        issues.push({
          rule: 'IllustrationAlt', severity: 'error', clause: 'ISO 14289-1 §7.3 (Matterhorn 13-004)', element,
          message: `${element.StandardType} element has no /Alt or /ActualText.`,
        });
      }
    }
    if (isTextBearing(element) && element.EffectiveLang === undefined) {
      issues.push({
        rule: 'NaturalLanguage', severity: 'error', clause: 'ISO 14289-1 §7.2 (Matterhorn 11-001)', element,
        message: 'Text-bearing element has no resolvable natural language (/Lang).',
      });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/structvalidate.test.ts`
Expected: PASS (the default clean fixture still has zero errors — `Document > P` is standard, not an illustration, and catalog `/Lang` resolves).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/structvalidate.ts test/structvalidate.test.ts
git commit -m "feat(struct): PDF/UA StandardType/IllustrationAlt/NaturalLanguage rules (S5)"
```

---

## Task 5: HeadingNesting rule

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/structvalidate.test.ts`

**Interfaces:**
- Consumes: the `WalkedNode[]` pre-order list from Task 4; `element.StandardType`.
- Produces: appends `HeadingNesting` (error) issues for numbered headings (`H1`–`H6`) that skip a level when descending.

- [ ] **Step 1: Write the failing test**

Append to `test/structvalidate.test.ts`:

```ts
describe('ValidatePdfUa — heading nesting', () => {
  const rulesFor = (root: import('./helpers/build-ua-pdf.js').UaNode[]) =>
    Document.Open(buildUaPdf({ root })).ValidatePdfUa().Issues.map((i) => i.rule);

  it('flags a skipped heading level (H1 then H3)', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'H1', mcid: 0, text: 'a' },
      { type: 'H3', mcid: 1, text: 'b' },
    ] }]);
    expect(rules).toContain('HeadingNesting');
  });

  it('accepts consecutive levels and going back up', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'H1', mcid: 0, text: 'a' },
      { type: 'H2', mcid: 1, text: 'b' },
      { type: 'H1', mcid: 2, text: 'c' },
    ] }]);
    expect(rules).not.toContain('HeadingNesting');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/structvalidate.test.ts -t "heading nesting"`
Expected: FAIL — `HeadingNesting` not emitted.

- [ ] **Step 3: Implement the rule**

In `src/structvalidate.ts`, add a helper near `ILLUSTRATION`:

```ts
/** Heading level 1..6 for /H1../H6, else 0. */
function headingLevel(standardType: string): number {
  const m = /^H([1-6])$/.exec(standardType);
  return m ? Number(m[1]) : 0;
}
```

Add the rule after the per-node loop (still inside `validatePdfUa`, before the `return`):

```ts
  // HeadingNesting — numbered headings must not skip a level descending.
  let prevLevel = 0;
  for (const { element } of nodes) {
    const level = headingLevel(element.StandardType);
    if (level === 0) continue;
    if (level > prevLevel + 1) {
      issues.push({
        rule: 'HeadingNesting', severity: 'error', clause: 'Matterhorn 14-002', element,
        message: `Heading ${element.StandardType} skips a level (previous numbered heading was H${prevLevel || 0}).`,
      });
    }
    prevLevel = level;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/structvalidate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/structvalidate.ts test/structvalidate.test.ts
git commit -m "feat(struct): PDF/UA HeadingNesting rule (S5)"
```

---

## Task 6: TableStructure and ListStructure rules

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/structvalidate.test.ts`

**Interfaces:**
- Consumes: the `WalkedNode[]` list (`element.StandardType`, `parentType`).
- Produces: appends `TableStructure` (error) and `ListStructure` (error) issues for misplaced table/list elements.

- [ ] **Step 1: Write the failing tests**

Append to `test/structvalidate.test.ts`:

```ts
describe('ValidatePdfUa — table/list nesting', () => {
  const rulesFor = (root: import('./helpers/build-ua-pdf.js').UaNode[]) =>
    Document.Open(buildUaPdf({ root })).ValidatePdfUa().Issues.map((i) => i.rule);

  it('flags a TD outside a TR', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'Table', children: [{ type: 'TD', mcid: 0, text: 'x' }] },
    ] }]);
    expect(rules).toContain('TableStructure');
  });

  it('accepts Table > TR > TD', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'Table', children: [{ type: 'TR', children: [{ type: 'TD', mcid: 0, text: 'x' }] }] },
    ] }]);
    expect(rules).not.toContain('TableStructure');
  });

  it('flags an LI outside an L', () => {
    const rules = rulesFor([{ type: 'Document', children: [{ type: 'LI', mcid: 0, text: 'x' }] }]);
    expect(rules).toContain('ListStructure');
  });

  it('accepts L > LI > LBody', () => {
    const rules = rulesFor([{ type: 'Document', children: [
      { type: 'L', children: [{ type: 'LI', children: [{ type: 'LBody', mcid: 0, text: 'x' }] }] },
    ] }]);
    expect(rules).not.toContain('ListStructure');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/structvalidate.test.ts -t "table/list nesting"`
Expected: FAIL.

- [ ] **Step 3: Implement the rules**

In `src/structvalidate.ts`, add constants near `ILLUSTRATION`:

```ts
const TR_PARENTS = new Set(['Table', 'THead', 'TBody', 'TFoot']);
```

Add the rules inside the per-node loop in `validatePdfUa` (extend the existing `for (const { element } of nodes)` loop to also destructure `parentType`):

Change the loop header to:

```ts
  for (const { element, parentType } of nodes) {
```

and add, inside that loop after the `NaturalLanguage` check:

```ts
    const st = element.StandardType;
    if (st === 'TR' && !(parentType !== null && TR_PARENTS.has(parentType))) {
      issues.push({
        rule: 'TableStructure', severity: 'error', clause: 'Matterhorn checkpoint 09 (tables)', element,
        message: `TR must be a child of Table/THead/TBody/TFoot, not '${parentType ?? 'root'}'.`,
      });
    }
    if ((st === 'TH' || st === 'TD') && parentType !== 'TR') {
      issues.push({
        rule: 'TableStructure', severity: 'error', clause: 'Matterhorn checkpoint 09 (tables)', element,
        message: `${st} must be a child of TR, not '${parentType ?? 'root'}'.`,
      });
    }
    if (st === 'LI' && parentType !== 'L') {
      issues.push({
        rule: 'ListStructure', severity: 'error', clause: 'Matterhorn checkpoint 10 (lists)', element,
        message: `LI must be a child of L, not '${parentType ?? 'root'}'.`,
      });
    }
    if ((st === 'Lbl' || st === 'LBody') && parentType !== 'LI') {
      issues.push({
        rule: 'ListStructure', severity: 'error', clause: 'Matterhorn checkpoint 10 (lists)', element,
        message: `${st} must be a child of LI, not '${parentType ?? 'root'}'.`,
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/structvalidate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/structvalidate.ts test/structvalidate.test.ts
git commit -m "feat(struct): PDF/UA TableStructure/ListStructure rules (S5)"
```

---

## Task 7: UntaggedContent rule (content walk, warning)

**Files:**
- Modify: `src/structvalidate.ts`
- Test: `test/structvalidate.test.ts`

**Interfaces:**
- Consumes: `visitContent(doc, page, visitor)` from `text.ts` (now emitting `artifact` on glyphs/images and `mcid`/`artifact` on images); `doc.Pages`; the artifact fixture `buildArtifactPdf` from Task 1.
- Produces: appends one `UntaggedContent` (warning) issue per page that bears non-artifact, non-MCID glyphs or images.

- [ ] **Step 1: Write the failing tests**

Append to `test/structvalidate.test.ts` (add the import at the top of the file):

```ts
import { buildArtifactPdf } from './helpers/build-artifact-pdf.js';
```

A page handle from a second `Open` is a different object, so assert `issue.page` against the same document's `Pages[0]`:

```ts
describe('ValidatePdfUa — untagged content', () => {
  it('warns (does not error) on a page with loose untagged glyphs', () => {
    const doc = Document.Open(buildArtifactPdf());
    const report = doc.ValidatePdfUa();
    const issue = report.Issues.find((i) => i.rule === 'UntaggedContent');
    expect(issue).toBeTruthy();
    expect(issue!.severity).toBe('warning');
    expect(issue!.page).toBe(doc.Pages[0]);
    expect(report.Passed).toBe(true); // warning only
  });

  it('does not flag a fully-tagged page', () => {
    const report = Document.Open(buildUaPdf()).ValidatePdfUa();
    expect(report.Issues.map((i) => i.rule)).not.toContain('UntaggedContent');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/structvalidate.test.ts -t "untagged content"`
Expected: FAIL — `UntaggedContent` not emitted.

- [ ] **Step 3: Implement the rule**

In `src/structvalidate.ts`, add the import for the content walk:

```ts
import { visitContent } from './text.js';
```

Add the rule after the per-node loop and heading loop in `validatePdfUa` (before `return`):

```ts
  // UntaggedContent — page content that is neither tagged (mcid) nor artifacted.
  for (const page of doc.Pages) {
    let untagged = false;
    visitContent(doc, page, {
      glyph: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
      image: (e) => { if (e.mcid === undefined && !e.artifact) untagged = true; },
    });
    if (untagged) {
      issues.push({
        rule: 'UntaggedContent', severity: 'warning', clause: 'Matterhorn 01-006', page,
        message: 'Page has visible content (text or image) that is neither tagged nor marked as an artifact.',
      });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/structvalidate.test.ts`
Expected: PASS. (`buildArtifactPdf` has a loose "Loose" run → one warning, `Passed` stays true; `buildUaPdf` clean fixture has only the MCID run → no warning.)

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/structvalidate.ts test/structvalidate.test.ts
git commit -m "feat(struct): PDF/UA UntaggedContent rule (S5)"
```

---

## Task 8: Docs, full-suite gate, and issue close

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the complete validator from Tasks 1–7.
- Produces: user-facing docs; verified green build.

- [ ] **Step 1: Update README Features**

In `README.md`, under the tagged-PDF / accessibility Features area, add a bullet:

```markdown
- **PDF/UA validation** — `doc.ValidatePdfUa()` checks a curated, machine-checkable
  subset of PDF/UA-1 (ISO 14289-1): tagging present, document title and
  `DisplayDocTitle`, illustration alt text, standard/role-mapped types, heading
  nesting, table/list structure, natural-language specification, and (heuristic,
  warning-only) untagged page content. Returns a `ValidationReport`
  (`Issues`, `Errors`, `Warnings`, `Passed`).
```

- [ ] **Step 2: Update README Limitations**

Add under Limitations:

```markdown
- PDF/UA validation is a curated subset: it does not check reading-order
  correctness, table header/`Headers` association, link-text adequacy, or
  path-painting (vector) content, and performs no rendering-based checks. The
  untagged-content check is heuristic (warning severity).
```

- [ ] **Step 3: Run the full quality gate**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; entire vitest suite green (all files, not just `structvalidate`).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: PDF/UA validation API (S5)"
```

- [ ] **Step 5: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-pjx.5
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review Notes

- **Spec coverage:** every rule in the spec's three tables maps to a task — Tagged/DocumentTitle/DisplayDocTitle/Suspects (Tasks 2–3); StandardType/IllustrationAlt/NaturalLanguage (Task 4); HeadingNesting (Task 5); TableStructure/ListStructure (Task 6); UntaggedContent (Task 7). The additive `text.ts` change is Task 1. Public API (`ValidatePdfUa`, `ValidationReport`, `ValidationIssue`, `Severity`) is in Task 2; `index.ts` exports in Task 2; README in Task 8.
- **Type consistency:** `ValidationIssue` shape, `validatePdfUa(doc, catalog)` signature, `WalkedNode { element, parentType }`, `buildUaPdf(opts)`/`UaNode`/`UaOptions`, and `buildArtifactPdf()` are used identically across tasks.
- **Severity model:** `UntaggedContent` and `Suspects` are warnings (tests assert `Passed` stays true); all others are errors.
- **Placeholder scan:** no TBD/TODO/"handle edge cases" steps; every code step shows complete code; no throwaway scaffolding remains in the steps.
