# PDF/UA-2: annotation and form rules (`q7hc.4.2`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ISO 14289-2 clauses 8.9 and 8.10 — 25 new PDF/UA-2 rules over
annotations, widgets and forms — with part 1 byte-identical and one rule
deliberately deferred to `q7hc.4.6`.

**Architecture:** The shared rule vocabulary moves to a new near-leaf
`uarule.ts` so a new rules module can cite clauses without closing an import
cycle. `uaannot.ts` then holds all 25 rules over ONE per-annotation record
computed once per annotation. `richtext.ts` gains a `verbatim` mode rather than
a twin, because two rules must compare rich text the way the anchor does.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-15-pdfua2-annotations-forms-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only.
- **ESM + NodeNext.** Every relative import specifier carries `.js`.
- **`npm run typecheck` and `npm test` green before any task is done.** Target
  one file with `npx vitest run test/<name>.test.ts`.
- **Part 1 is byte-identical.** These four must pass **UNEDITED**:
  `test/pdfua-part1-identity.test.ts`, `test/pdfua2-validate.test.ts`,
  `test/pdfuaconvert.test.ts`, `test/markdown-pdfua.test.ts`. If one needs
  editing, stop — the change is wrong.
- **`richTextToPlain`'s default must not move.** `test/richtext.test.ts` and
  `test/annot-search.test.ts` must pass **UNEDITED**.
- **Every new rule opens `if (ctx.part !== 2) return [];`** and is APPENDED to
  `RULES`, never inserted.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change,**
  under `## [Unreleased]`, citing `q7hc.4.2` at the end.
- **A new `src/*.ts` module earns a CLAUDE.md Source-list entry when it lands.**
  The sweep must print nothing — run it through node, not shell globbing:
  ```bash
  node -e "
  const fs=require('fs');const md=fs.readFileSync('CLAUDE.md','utf8');
  const m=fs.readdirSync('src').filter(f=>f.endsWith('.ts'))
    .filter(b=>!md.includes('**'+b+'**') && !md.includes('\`'+b+'\`'));
  console.log(m.length===0?'sweep clean':'MISSING: '+m.join(', '));"
  ```
- **The anchor is a TRANSCRIPTION, not a runnable oracle.** Every transcribed
  constant cites its source, fetched 2026-09-15:
  - `veraPDF/veraPDF-validation-profiles@integration`, `PDF_UA/2/8.9 …`, `8.10 …`
  - `veraPDF/veraPDF-validation@integration`,
    `validation-model/src/main/java/org/verapdf/gf/model/impl/pd/GFPDAnnot.java`,
    `annotations/GFPDWidgetAnnot.java`, `annotations/GFPDMarkupAnnot.java`,
    `annotations/GFPDFileAttachmentAnnot.java`, `gfse/GFSEForm.java`,
    `tools/DictionaryKeysHelper.java`

  **Never write one of these from memory.**

## Three corrections to the spec, made here

The spec was written before the implementation was read. All three are name or
behaviour facts, not design changes:

1. **The function is `richTextToPlain`, not `reduceRichText`.** `richtext.ts`
   exports exactly one function and that is its name.
2. **`readRichTextMarkup` / `readRichTextValue` live in `formfield.ts`,** not
   `richtext.ts`. CLAUDE.md's `richtext.ts` entry places them in that module and
   is wrong; the entry is corrected in Task 7.
3. **The option is `verbatim`, not `separateBlocks`.** veraPDF's reduction
   differs in THREE ways, not one — no block separators, no whitespace
   collapsing, and no trim — so a name about blocks alone would be a lie. A
   block boundary also yields `\n` in our default, not a space.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/uarule.ts` | The shared rule vocabulary: `PdfUaPart`, `UaCtx`, `Rule`, `uaClause`. Near-leaf — `Document`/`StructElement`/`StructTreeRoot` as TYPES only. |
| **Modify** `src/structvalidate.ts` | Imports the vocabulary from `uarule.ts` and re-exports `PdfUaPart`; appends `ANNOT_RULES`. |
| **Modify** `src/richtext.ts` | `richTextToPlain(markup, opts?)` gains `verbatim`. |
| **Create** `src/uaannot.ts` | The 25 rules of 8.9 and 8.10, over one per-annotation record. |
| **Create** `test/uarule.test.ts` | That the extraction moved nothing — `uaClause`'s two arms. |
| **Create** `test/pdfua2-annot.test.ts` | Each of the 25 rules as a cross-part PAIR. |
| **Create** `test/helpers/build-annot-pdf.ts` | A tagged page carrying annotations, shared by the 22 per-annotation rules. |
| **Modify** `test/richtext.test.ts` | The `verbatim` mode; existing cases are the fence. |
| **Modify** `CLAUDE.md`, `README.md`, `CHANGELOG.md` | Source entries, the 39-of-91 correction, API text, Unreleased entry. |

---

### Task 1: `uarule.ts` — extract the shared vocabulary

A pure refactor. No rule changes, no behaviour change.

**Files:**
- Create: `src/uarule.ts`
- Modify: `src/structvalidate.ts`
- Test: `test/uarule.test.ts`

**Interfaces:**
- Consumes: `Document`, `StructElement`, `StructTreeRoot`, `PdfDict` — as TYPES.
- Produces:
  ```ts
  export type PdfUaPart = 1 | 2;
  export interface WalkedNode {
    element: StructElement; parentType: string | null; parent: StructElement | null;
  }
  export interface UaCtx {
    doc: Document; catalog: PdfDict; part: PdfUaPart;
    tree: StructTreeRoot; nodes: WalkedNode[];
  }
  export type Rule = (ctx: UaCtx) => ValidationIssue[];
  export function uaClause(part: PdfUaPart, cl: { 1?: string; 2?: string }): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/uarule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { uaClause } from '../src/uarule.js';

describe('uaClause', () => {
  it('cites the clause number of the part being validated', () => {
    // The same test is numbered differently in the two standards, so a widened
    // rule that keeps citing one part reports the right defect against the
    // wrong document — pdfavalidate.ts's `partClause` rule, for its reason.
    expect(uaClause(1, { 1: '7.1', 2: '8.2.1' })).toBe('ISO 14289-1 §7.1');
    expect(uaClause(2, { 1: '7.1', 2: '8.2.1' })).toBe('ISO 14289-2 §8.2.1');
  });

  it('renders a part that states no clause as undefined rather than throwing', () => {
    // Every part-2-only rule passes `{ 2: ... }` alone, so the part-1 arm is
    // routinely absent. It must not throw — a validator that throws on a rule
    // it cannot cite takes down the whole report.
    expect(uaClause(1, { 2: '8.9.2.2' })).toBe('ISO 14289-1 §undefined');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/uarule.test.ts`
Expected: FAIL — `Cannot find module '../src/uarule.js'`

- [ ] **Step 3: Create `src/uarule.ts`**

```ts
/** The vocabulary every PDF/UA rule shares: which part is being validated, the
 *  context a rule reads, the rule signature itself, and how a rule cites its
 *  clause.
 *
 *  **Invariant, and it is FORCED rather than tidy.** This lived in
 *  `structvalidate.ts` until `q7hc.4.2`, which added a second rules module
 *  (`uaannot.ts`) for clauses 8.9 and 8.10. `structvalidate.ts` must import
 *  that module's rules BY VALUE to append them to `RULES`, and that module must
 *  import `uaClause` BY VALUE to cite its clauses — which is a 2-cycle, and
 *  `test/import-cycles.test.ts` asserts the exact set of those. Extracting the
 *  shared vocabulary to a leaf both import is the move `structtype.ts` and
 *  `numbertree.ts` each already made, for exactly this reason.
 *
 *  **Invariant:** a near-LEAF. `Document`, `StructElement`, `StructTreeRoot`
 *  and `PdfDict` arrive as TYPES only, so it closes no edge at all. @internal */
import type { Document } from './document.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import type { PdfDict } from './types.js';
import type { ValidationIssue } from './validation.js';

/** Which part of ISO 14289 to validate against: 1 (PDF/UA-1) or 2 (PDF/UA-2,
 *  the PDF 2.0 sibling). */
export type PdfUaPart = 1 | 2;

export interface WalkedNode {
  element: StructElement;
  parentType: string | null;
  /** The parent ELEMENT, not just its type — the MathML rule needs the parent's
   *  NAMESPACE, which a type string cannot supply. */
  parent: StructElement | null;
}

/** PDF/UA run context: the document, its catalog, the target part, and the tree
 *  walk every structure rule shares. */
export interface UaCtx {
  doc: Document;
  catalog: PdfDict;
  part: PdfUaPart;
  tree: StructTreeRoot;
  nodes: WalkedNode[];
}

export type Rule = (ctx: UaCtx) => ValidationIssue[];

/** The ISO clause to cite for this part. Each rule states its own numbers,
 *  because the same test is numbered differently in the two standards —
 *  `partClause`'s rule in pdfavalidate.ts, for pdfavalidate.ts's reason. */
export function uaClause(part: PdfUaPart, cl: { 1?: string; 2?: string }): string {
  return `ISO 14289-${part} §${part === 1 ? cl[1] : cl[2]}`;
}
```

- [ ] **Step 4: Point `structvalidate.ts` at it**

In `src/structvalidate.ts`, DELETE the local `PdfUaPart` type, the
`WalkedNode` interface, the `UaCtx` interface, the `Rule` type and the
`uaClause` function, and add the import beside the existing ones:

```ts
import {
  uaClause, type PdfUaPart, type Rule, type UaCtx, type WalkedNode,
} from './uarule.js';
```

Then re-export the public name, beside the existing `ValidationReport`
re-export, so every current import path keeps working:

```ts
// Re-export so existing importers of these from structvalidate keep working.
export { ValidationReport, uaClause };
export type { ValidationIssue, Severity, PdfUaPart, UaCtx, Rule };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/uarule.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Prove the refactor moved NOTHING**

Run: `npx vitest run test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfua2-structure.test.ts test/pdfuaconvert.test.ts test/markdown-pdfua.test.ts`
Expected: PASS, all five, **unedited**. This is the whole gate for this task —
an extraction that changes an answer is a failed extraction.

Then confirm no cycle was closed:

Run: `npx vitest run test/import-cycles.test.ts`
Expected: PASS, the same 15 pairs.

- [ ] **Step 7: Add the CLAUDE.md entry**

In `CLAUDE.md`, immediately BEFORE the `structvalidate.ts` validators bullet,
insert:

```markdown
- **uarule.ts** — the vocabulary every PDF/UA rule shares (`q7hc.4.2`):
  `PdfUaPart`, `UaCtx`, `Rule` and `uaClause`.
  **Invariant, and it is FORCED rather than tidy:** it lived in
  `structvalidate.ts` until a SECOND rules module (`uaannot.ts`, clauses 8.9
  and 8.10) arrived. `structvalidate.ts` imports that module's rules BY VALUE
  to append them to `RULES`, and that module imports `uaClause` BY VALUE to
  cite its clauses — a 2-cycle, which `test/import-cycles.test.ts` fences as a
  red build. Extracting the shared vocabulary to a leaf both import is the move
  `structtype.ts` and `numbertree.ts` each already made, for the same reason.
  **Invariant:** a near-LEAF — `Document`, `StructElement`, `StructTreeRoot`,
  `PdfDict` and `ValidationIssue` arrive as TYPES only, so it closes no edge.
  `structvalidate.ts` re-exports `PdfUaPart` and `uaClause`, so no existing
  import path moved.
```

- [ ] **Step 8: Typecheck, sweep, commit**

```bash
npm run typecheck
node -e "const fs=require('fs');const md=fs.readFileSync('CLAUDE.md','utf8');const m=fs.readdirSync('src').filter(f=>f.endsWith('.ts')).filter(b=>!md.includes('**'+b+'**')&&!md.includes('\`'+b+'\`'));console.log(m.length===0?'sweep clean':'MISSING: '+m.join(', '));"
npm test
git add src/uarule.ts src/structvalidate.ts test/uarule.test.ts CLAUDE.md
git commit -m "refactor(q7hc.4.2): extract the shared PDF/UA rule vocabulary

A second rules module needs uaClause by value while structvalidate needs
its rules by value — a 2-cycle. The leaf both import is the move
structtype.ts and numbertree.ts each already made.

Pure extraction: the five UA test files pass unedited."
```

---

### Task 2: `richTextToPlain` gains a `verbatim` mode

**Files:**
- Modify: `src/richtext.ts`
- Test: `test/richtext.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RichTextOptions {
    /** Concatenate every text node exactly as it appears. */
    verbatim?: boolean;
  }
  export function richTextToPlain(
    markup: string, opts?: RichTextOptions): string | undefined;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/richtext.test.ts`:

```ts
describe('richTextToPlain — verbatim mode', () => {
  it('concatenates text nodes with no block break, no collapse and no trim', () => {
    // veraPDF's DictionaryKeysHelper.getAllNodeText appends every text node's
    // value and nothing else. Three differences from the default, not one.
    expect(richTextToPlain('<p>a</p><p>b</p>', { verbatim: true })).toBe('ab');
    expect(richTextToPlain('<p>a  b</p>', { verbatim: true })).toBe('a  b');
    expect(richTextToPlain('<p> a </p>', { verbatim: true })).toBe(' a ');
  });

  it('keeps the whitespace BETWEEN tags, which is a text node too', () => {
    expect(richTextToPlain('<body><p>a</p>\n<p>b</p></body>', { verbatim: true }))
      .toBe('a\nb');
  });

  it('still returns undefined for markup that will not parse', () => {
    expect(richTextToPlain('<p>unclosed', { verbatim: true })).toBeUndefined();
  });

  it('leaves the DEFAULT untouched', () => {
    // The fence for every existing caller. A block boundary is a NEWLINE in the
    // default, not a space — and whitespace collapses and the result is
    // trimmed, all three of which verbatim mode declines.
    expect(richTextToPlain('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(richTextToPlain('<p>a  b</p>')).toBe('a b');
    expect(richTextToPlain('<p> a </p>')).toBe('a');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/richtext.test.ts`
Expected: FAIL — the verbatim cases return the collapsed form.

- [ ] **Step 3: Write the implementation**

In `src/richtext.ts`, replace `walk` and `richTextToPlain`:

```ts
/** How to reduce the fragment.
 *
 *  **The two modes answer DIFFERENT QUESTIONS, which is why this is an option
 *  and not a second module.** The default answers "is this text present" — a
 *  SEARCH, where running two blocks together invents a phrase that never
 *  appeared, which is what `BLOCK` exists to prevent. `verbatim` answers "are
 *  these two the same text" — an EQUIVALENCE, where the only answer that
 *  matters is the one ISO 14289-2's validator gives, and that validator
 *  (veraPDF's `DictionaryKeysHelper.getAllNodeText`) concatenates every text
 *  node and does nothing else. A second module would be two tag walkers that
 *  drift; a second question is a parameter. */
export interface RichTextOptions {
  /** Concatenate every text node exactly as it appears: no block breaks, no
   *  whitespace collapsing, no trim. Used ONLY by the ISO 14289-2 8.9.2.3-2 and
   *  8.10.3.3-1 rules, which must agree with the anchor cell for cell. */
  verbatim?: boolean;
}

function walk(node: XmlNode, out: string[], verbatim: boolean): void {
  for (const n of node.nodes) {
    if (typeof n === 'string') { out.push(n); continue; }
    const block = !verbatim && BLOCK.has(n.name.toLowerCase());
    if (block) out.push(SEP);
    walk(n, out, verbatim);
    if (block) out.push(SEP);
  }
}
```

and, in `richTextToPlain`, take the options and branch at the end:

```ts
export function richTextToPlain(
  markup: string, opts: RichTextOptions = {},
): string | undefined {
  // parseXml returns ONE root, and a fragment legitimately has several — a bare
  // `<p>a</p><p>b</p>` would otherwise yield only the first, dropping content
  // silently, which is worse than reporting nothing. The wrapper also lets the
  // fragment keep its own XML declaration: `skipMisc` runs inside the child
  // loop, so a declaration among children is tolerated.
  let root: XmlNode;
  try {
    root = parseXml(new TextEncoder().encode(`<pdf4ts-rich>${markup}</pdf4ts-rich>`));
  } catch {
    return undefined;
  }

  const verbatim = opts.verbatim === true;
  const out: string[] = [];
  walk(root, out, verbatim);
  const joined = out.join('');
  if (verbatim) return joined;
  return joined
    // XHTML collapses whitespace: the newlines and indentation between tags are
    // layout, not content.
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    // Then every run of block boundaries, with any spaces around it, is ONE break.
    .replace(/ ?\u0000[\u0000 ]*/g, '\n')
    .trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/richtext.test.ts`
Expected: PASS. Every PRE-EXISTING case in that file must still pass unedited —
they are the fence that the default did not move.

- [ ] **Step 5: Confirm the other caller did not move**

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS, unedited.

- [ ] **Step 6: Update the CLAUDE.md entry and commit**

In `CLAUDE.md`'s `richtext.ts` entry, append:

```markdown
  **Invariant (`q7hc.4.2`), and the two modes answer DIFFERENT QUESTIONS:**
  `richTextToPlain(markup, { verbatim: true })` concatenates every text node
  and does nothing else — no block breaks, no whitespace collapsing, no trim.
  The default answers "is this text present" (a SEARCH, where running two
  blocks together invents a phrase); `verbatim` answers "are these two the same
  text" (an EQUIVALENCE, where the answer that matters is the one ISO 14289-2's
  validator gives, and `DictionaryKeysHelper.getAllNodeText` concatenates). A
  second module would be two tag walkers that drift; a second question is a
  parameter. The default is unchanged, so every existing caller is
  byte-identical BY CONSTRUCTION — `test/richtext.test.ts`'s pre-existing cases
  and `test/annot-search.test.ts` are the fence.
  **Note a divergence in verbatim mode, recorded rather than chased:**
  `parseXml` SKIPS comments, where veraPDF's DOM walk returns a comment node's
  value and so includes its text. Commented rich text is vanishingly rare and
  chasing it would mean teaching `xml.ts` to retain comments for one caller.
  **Note, and CLAUDE.md said otherwise until `q7hc.4.2`:** `readRichTextMarkup`
  and its `readRichTextValue` alias live in **formfield.ts**, not here. This
  module exports exactly ONE function, `richTextToPlain`.
```

```bash
npm run typecheck && npm test
git add src/richtext.ts test/richtext.test.ts CLAUDE.md
git commit -m "feat(q7hc.4.2): richTextToPlain gains a verbatim mode

veraPDF concatenates every text node and does nothing else, where the
default deliberately separates blocks, collapses whitespace and trims —
three differences, not one, which is why the option is not called
separateBlocks.

The two modes answer different questions: presence (search) versus
equivalence (validation). A second module would be two tag walkers that
drift. Default unchanged; the existing cases are the fence."
```

---

### Task 3: `uaannot.ts` — the per-annotation record and the nine dict rules

**Files:**
- Create: `src/uaannot.ts`
- Create: `test/helpers/build-annot-pdf.ts`
- Create: `test/pdfua2-annot.test.ts`
- Modify: `src/structvalidate.ts`

**Interfaces:**
- Consumes: `UaCtx`, `Rule`, `uaClause` from `./uarule.js`; `Annotation` from
  `./annotation.js`; `Page` from `./page.js`; `StructElement` from
  `./struct.js`.
- Produces:
  ```ts
  export const ANNOT_RULES: Rule[];
  ```
  Rule names added here: `StampDescription`, `InkDescription`,
  `ScreenDescription`, `ThreeDDescription`, `RichMediaDescription`,
  `SoundProhibited`, `MovieProhibited`, `TrapNetProhibited`,
  `FileAttachmentRelationship`.

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-annot-pdf.ts`:

```ts
import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import type { StructElement } from '../../src/struct.js';
import { name, type PdfDict, type PdfObject } from '../../src/types.js';

/** One annotation to place on the page. */
export interface AnnotSpec {
  /** /Subtype, written verbatim — including subtypes our API cannot author. */
  subtype: string;
  /** /Rect; defaults to a 50x20 box. Pass [0,0,0,0] for a zero-size widget. */
  rect?: [number, number, number, number];
  /** /F annotation flags. */
  flags?: number;
  /** /Contents. */
  contents?: string;
  /** Extra raw dict entries — /Name, /FS, /AA, /FT, /Parent, /RC, ... */
  extra?: Record<string, PdfObject>;
  /** Tag the annotation under a chain of structure elements, outermost first.
   *  Omit to leave it OUT of the structure tree, which most rules exempt. */
  under?: string[];
  /** Append an Lbl to the innermost enclosing element. `'empty'` gives one
   *  with no /K, which does NOT count as a label. */
  label?: 'filled' | 'empty';
  /** /Alt on the innermost enclosing element. */
  alt?: string;
}

export interface AnnotPdfSpec {
  annots: AnnotSpec[];
  /** Page /Tabs. Omit to leave the key absent. */
  tabs?: string;
  /** Catalog /AcroForm /XFA. */
  xfa?: boolean;
}

/** A tagged, titled document whose single page carries `spec.annots`.
 *
 *  Annotations are written as RAW DICTS rather than through `page.AddLink` and
 *  friends, because most of these subtypes (/Sound, /Movie, /TrapNet, /3D,
 *  /RichMedia, /PrinterMark) have no authoring API here and never will — they
 *  are prohibited or out of scope. */
export function buildAnnotPdf(spec: AnnotPdfSpec): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  const root = doc.CreateStructTree();
  const docEl = root.Append('Document');
  const page = doc.Pages[0];

  if (spec.tabs !== undefined) page.Dict.set('Tabs', name(spec.tabs));
  if (spec.xfa === true) {
    const acro: PdfDict = new Map<string, PdfObject>([['XFA', []], ['Fields', []]]);
    doc.Catalog.set('AcroForm', acro);
  }

  // Set /Annots FIRST and push into the live array: `Page.Annotations` resolves
  // `this.Dict.get('Annots')` on every call, so each annotation is visible to
  // `page.Annotations` as soon as it is pushed — which is what lets
  // `AddAnnotation` find it inside the loop.
  const annots: PdfObject[] = [];
  page.Dict.set('Annots', annots);

  for (const a of spec.annots) {
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')],
      ['Subtype', name(a.subtype)],
      ['Rect', a.rect ?? [0, 0, 50, 20]],
    ]);
    if (a.flags !== undefined) dict.set('F', a.flags);
    if (a.contents !== undefined) {
      dict.set('Contents', { kind: 'string', bytes: new TextEncoder().encode(a.contents) });
    }
    for (const [k, v] of Object.entries(a.extra ?? {})) dict.set(k, v);
    const ref = doc.allocObject(dict);
    annots.push(ref);

    if (a.under !== undefined) {
      let el: StructElement = docEl;
      for (const t of a.under) el = el.Append(t);
      if (a.alt !== undefined) el.Alt = a.alt;
      if (a.label !== undefined) {
        const lbl = el.Append('Lbl');
        if (a.label === 'filled') lbl.MarkContent(page, [0, 0, 10, 10]);
      }
      el.AddAnnotation(
        // AddAnnotation needs an Annotation handle; the raw dict is already in
        // the live /Annots array, so re-read it through the page's accessor.
        page.Annotations[annots.length - 1]!,
      );
    }
  }
  doc.markModified();
  return doc.Save();
}
```

- [ ] **Step 2: Write the failing test**

Create `test/pdfua2-annot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotPdf, type AnnotPdfSpec } from './helpers/build-annot-pdf.js';
import { name } from '../src/types.js';

/** Rule ids reported for this document at `part`. */
const ids = (spec: AnnotPdfSpec, part: 1 | 2): string[] =>
  Document.Open(buildAnnotPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. A single-part
 *  assertion provably cannot tell a rule that correctly went quiet from one
 *  that was never wired up. */
function expectPair(spec: AnnotPdfSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

describe('PDF/UA-2 8.9: annotations that must describe themselves', () => {
  it('8.9.2.4.8-1 reports an Ink with no /Contents', () => {
    expectPair({ annots: [{ subtype: 'Ink' }] }, 'InkDescription');
  });

  it('8.9.2.4.8-1 is silent when /Contents is present', () => {
    expect(ids({ annots: [{ subtype: 'Ink', contents: 'a squiggle' }] }, 2))
      .not.toContain('InkDescription');
  });

  it('8.9.2.4.12-1 reports a Screen with no /Contents', () => {
    expectPair({ annots: [{ subtype: 'Screen' }] }, 'ScreenDescription');
  });

  it('8.9.2.4.19-1 reports a 3D with no /Contents', () => {
    expectPair({ annots: [{ subtype: '3D' }] }, 'ThreeDDescription');
  });

  it('8.9.2.4.19-2 reports a RichMedia with no /Contents', () => {
    expectPair({ annots: [{ subtype: 'RichMedia' }] }, 'RichMediaDescription');
  });

  it('8.9.2.4.7-1 accepts a Stamp with EITHER /Name or /Contents', () => {
    expectPair({ annots: [{ subtype: 'Stamp' }] }, 'StampDescription');
    expect(ids({ annots: [{ subtype: 'Stamp', extra: { Name: name('Approved') } }] }, 2))
      .not.toContain('StampDescription');
    expect(ids({ annots: [{ subtype: 'Stamp', contents: 'Approved' }] }, 2))
      .not.toContain('StampDescription');
  });
});

describe('PDF/UA-2 8.9: prohibited subtypes', () => {
  // Pinned from BOTH directions, as the issue's acceptance criterion asks: the
  // subtype reports, and a /Text in the same position does not — so the rule is
  // not simply firing on every annotation.
  for (const [subtype, rule] of [
    ['Sound', 'SoundProhibited'],
    ['Movie', 'MovieProhibited'],
    ['TrapNet', 'TrapNetProhibited'],
  ] as const) {
    it(`reports ${subtype} and nothing else in its place`, () => {
      expectPair({ annots: [{ subtype }] }, rule);
      expect(ids({ annots: [{ subtype: 'Text', contents: 'c' }] }, 2)).not.toContain(rule);
    });
  }
});

describe('PDF/UA-2 8.9.2.4.10-1: file attachment relationship', () => {
  it('reports a /FS whose filespec has no /AFRelationship', () => {
    expectPair({
      annots: [{
        subtype: 'FileAttachment', contents: 'c',
        extra: { FS: new Map([['Type', name('Filespec')]]) },
      }],
    }, 'FileAttachmentRelationship');
  });

  it('is silent when the filespec states one', () => {
    expect(ids({
      annots: [{
        subtype: 'FileAttachment', contents: 'c',
        extra: {
          FS: new Map([['Type', name('Filespec')], ['AFRelationship', name('Data')]]),
        },
      }],
    }, 2)).not.toContain('FileAttachmentRelationship');
  });

  it('is silent for a FileAttachment with no /FS at all', () => {
    expect(ids({ annots: [{ subtype: 'FileAttachment', contents: 'c' }] }, 2))
      .not.toContain('FileAttachmentRelationship');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: FAIL — none of the rule ids appear.

- [ ] **Step 4: Write `src/uaannot.ts`**

```ts
/** ISO 14289-2 clauses 8.9 (annotations) and 8.10 (forms) — the 25 rules
 *  `q7hc.4.2` added.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.9 Annotations/**` and `8.10 Forms/**`, plus
 *  veraPDF/veraPDF-validation@integration's `GFPDAnnot.java`,
 *  `annotations/GFPDWidgetAnnot.java`, `annotations/GFPDMarkupAnnot.java`,
 *  `annotations/GFPDFileAttachmentAnnot.java` and `gfse/GFSEForm.java`, fetched
 *  2026-09-15. A TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *
 *  **Invariant:** its own module rather than more of `structvalidate.ts`, which
 *  is the STRUCTURE TREE's rules (8.2) and was already ~900 lines. The split is
 *  by subject, the way `redactannots.ts` splits object-graph work off
 *  `redact.ts`'s content-stream surgery. Both import the shared vocabulary from
 *  `uarule.ts`, which is what keeps the pair free of an import cycle.
 *
 *  **Invariant:** NO rule here is converted. `ConvertToPdfUa` gains no pass —
 *  an absent `/Contents`, a missing `Lbl`, a prohibited `/Sound` and an XFA
 *  packet are authoring or destructive decisions, and the two that could be
 *  automated (`/Tabs`, `/AFRelationship`) are not worth a pass alone. Every
 *  rule here lands in `unresolved`. Stated so the absence reads as a decision.
 *
 *  **Note what is NOT here:** 8.10.3.5-1 (a graphic representing part of a
 *  signature's appearance needs `/Alt`). veraPDF states it over a grouped
 *  CONTENT-ITEM model we do not have; `visitFormContent` gives annotation
 *  granularity, so any version shipped now would be an approximation. Filed as
 *  `q7hc.4.6` rather than approximated silently. @internal */
import type { Annotation } from './annotation.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import { isDict, isName, type PdfDict } from './types.js';
import { uaClause, type Rule, type UaCtx } from './uarule.js';
import type { ValidationIssue } from './validation.js';

/** What every annotation rule reads, computed ONCE per annotation.
 *
 *  Twenty-two of the 25 rules want some subset of these, and `isArtifact` in
 *  particular walks an ancestor chain — so computing it per rule would walk the
 *  same chain eight times. */
interface AnnotCtx {
  annot: Annotation;
  page: Page;
  dict: PdfDict;
  subtype: string;
  /** /F, 0 when absent. */
  flags: number;
  /** The structure element enclosing it, or undefined when it is not in the
   *  tree — `/StructParent` through the ParentTree, which is veraPDF's
   *  `getParentDictionary`. */
  parent?: StructElement;
  /** An `Artifact` element ANYWHERE up the ancestor chain. */
  isArtifact: boolean;
}

/** Every annotation of every page, with its shared facts resolved.
 *
 *  **Invariant:** "in the structure tree" means `/StructParent` RESOLVES to an
 *  element. Every artifact rule in both clauses carries `structParentType ==
 *  null` as a PASS, so an annotation outside the tree is exempt — which reads
 *  wrong, and is what the anchor says. `UntaggedContent` covers that case.
 *
 *  **Note, measured for the link rules in `q7hc.4.1` and true here too:** the
 *  `/StructParent`-is-a-number test and the `element === undefined` test are
 *  REDUNDANT DEFENCES — an absent key resolves to `null`, which the first
 *  rejects, and the ParentTree would find nothing for it anyway. Breaking
 *  either ALONE proves nothing; do not "simplify" one away. */
function annotContexts(ctx: UaCtx): AnnotCtx[] {
  const out: AnnotCtx[] = [];
  for (const page of ctx.doc.Pages) {
    for (const annot of page.Annotations) {
      const spRaw = ctx.doc.resolve(annot.Dict.get('StructParent'));
      const parent = typeof spRaw === 'number'
        ? ctx.tree.ElementForObject(spRaw) : undefined;
      const flagsRaw = ctx.doc.resolve(annot.Dict.get('F'));
      out.push({
        annot, page, dict: annot.Dict, subtype: annot.Subtype,
        flags: typeof flagsRaw === 'number' ? flagsRaw : 0,
        parent,
        isArtifact: parent !== undefined && hasArtifactAncestor(parent),
      });
    }
  }
  return out;
}

/** `GFPDAnnot.getisArtifact`: an `Artifact` element ANYWHERE up the chain.
 *
 *  **Invariant, and the obvious reading is wrong:** it is the whole ANCESTOR
 *  CHAIN, not the direct parent. Eight rules read it, and a parent-only test
 *  passes an annotation nested two deep inside an artifact subtree — silently,
 *  since such a document renders identically either way.
 *
 *  **Note the depth bound:** `/P` can cycle in a file we did not write, and a
 *  validator must not hang on damage — `lexer.ts`'s posture. */
function hasArtifactAncestor(el: StructElement): boolean {
  let cur: StructElement | undefined = el;
  for (let depth = 0; cur !== undefined && depth < 64; depth++) {
    if (cur.StandardType === 'Artifact') return true;
    cur = cur.Parent;
  }
  return false;
}

/** Build an issue for one annotation. */
function annotIssue(
  ctx: UaCtx, a: AnnotCtx, rule: string, clause: string, message: string,
): ValidationIssue {
  return {
    rule, severity: 'error', clause: uaClause(ctx.part, { 2: clause }),
    page: a.page, element: a.parent, message,
  };
}

/** A rule over every annotation of a given /Subtype. */
function subtypeRule(
  subtype: string, rule: string, clause: string,
  fires: (ctx: UaCtx, a: AnnotCtx) => string | undefined,
): Rule {
  return (ctx) => {
    if (ctx.part !== 2) return [];
    const issues: ValidationIssue[] = [];
    for (const a of annotContexts(ctx)) {
      if (a.subtype !== subtype) continue;
      const message = fires(ctx, a);
      if (message !== undefined) issues.push(annotIssue(ctx, a, rule, clause, message));
    }
    return issues;
  };
}

/** 8.9.2.4.8-1, .12-1, .19-1, .19-2: these subtypes shall carry /Contents. */
const inkDescriptionRule = subtypeRule('Ink', 'InkDescription', '8.9.2.4.8',
  (_ctx, a) => a.annot.Contents === undefined
    ? 'Ink annotation has no /Contents to describe it.' : undefined);

const screenDescriptionRule = subtypeRule('Screen', 'ScreenDescription', '8.9.2.4.12',
  (_ctx, a) => a.annot.Contents === undefined
    ? 'Screen annotation has no /Contents to describe it.' : undefined);

const threeDDescriptionRule = subtypeRule('3D', 'ThreeDDescription', '8.9.2.4.19',
  (_ctx, a) => a.annot.Contents === undefined
    ? '3D annotation has no /Contents to describe it.' : undefined);

const richMediaDescriptionRule = subtypeRule(
  'RichMedia', 'RichMediaDescription', '8.9.2.4.19',
  (_ctx, a) => a.annot.Contents === undefined
    ? 'RichMedia annotation has no /Contents to describe it.' : undefined);

/** 8.9.2.4.7-1: a rubber stamp shall carry EITHER /Name or /Contents.
 *
 *  Note the disjunction — a stamp whose /Name is a standard one (`/Approved`)
 *  describes itself, so /Contents is required only when the name does not. */
const stampDescriptionRule = subtypeRule('Stamp', 'StampDescription', '8.9.2.4.7',
  (ctx, a) => {
    if (isName(ctx.doc.resolve(a.dict.get('Name')))) return undefined;
    return a.annot.Contents === undefined
      ? 'Rubber stamp annotation has neither /Name nor /Contents.' : undefined;
  });

/** 8.9.2.4.11-1, -2 and 8.9.2.4.15-1: prohibited outright. */
const soundProhibitedRule = subtypeRule('Sound', 'SoundProhibited', '8.9.2.4.11',
  () => 'Sound annotations are prohibited in PDF/UA-2.');
const movieProhibitedRule = subtypeRule('Movie', 'MovieProhibited', '8.9.2.4.11',
  () => 'Movie annotations are prohibited in PDF/UA-2.');
const trapNetProhibitedRule = subtypeRule('TrapNet', 'TrapNetProhibited', '8.9.2.4.15',
  () => 'TrapNet annotations are prohibited in PDF/UA-2.');

/** 8.9.2.4.10-1: a file attachment's /FS filespec shall state /AFRelationship.
 *
 *  **Note it is read off the FILESPEC, not off the annotation**
 *  (`GFPDFileAttachmentAnnot.getAFRelationship`), and the rule fires only when
 *  /FS is present at all. */
const fileAttachmentRule = subtypeRule(
  'FileAttachment', 'FileAttachmentRelationship', '8.9.2.4.10',
  (ctx, a) => {
    if (!a.dict.has('FS')) return undefined;
    const fs = ctx.doc.resolve(a.dict.get('FS'));
    if (isDict(fs) && isName(ctx.doc.resolve(fs.get('AFRelationship')))) return undefined;
    return 'File attachment /FS does not state /AFRelationship.';
  });

export const ANNOT_RULES: Rule[] = [
  inkDescriptionRule, screenDescriptionRule, threeDDescriptionRule,
  richMediaDescriptionRule, stampDescriptionRule,
  soundProhibitedRule, movieProhibitedRule, trapNetProhibitedRule,
  fileAttachmentRule,
];
```

- [ ] **Step 5: Append the rules in `structvalidate.ts`**

Add the import beside the others:

```ts
import { ANNOT_RULES } from './uaannot.js';
```

and append to `RULES`, after `tableRules`:

```ts
  // q7hc.4.2 — ISO 14289-2 8.9 and 8.10, part 2 only. APPENDED, so part-1
  // order holds.
  ...ANNOT_RULES,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: PASS.

- [ ] **Step 7: Confirm part 1 and the cycle set**

Run: `npx vitest run test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/import-cycles.test.ts`
Expected: PASS, all three, **unedited**.

- [ ] **Step 8: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uaannot.ts src/structvalidate.ts test/pdfua2-annot.test.ts test/helpers/build-annot-pdf.ts
git commit -m "feat(q7hc.4.2): the per-annotation record and nine dict rules

One record per annotation, computed once: isArtifact walks an ancestor
chain, so computing it per rule would walk the same chain eight times.

Prohibited subtypes are pinned from both directions — the subtype reports
and a /Text in its place does not."
```

---

### Task 4: The artifact and enclosure rules

**Files:**
- Modify: `src/uaannot.ts`
- Test: `test/pdfua2-annot.test.ts`

**Interfaces:**
- Consumes: `AnnotCtx`, `annotContexts`, `annotIssue` from Task 3.
- Produces rule names: `AnnotInvisible`, `AnnotNoView`, `MarkupEnclosure`,
  `PopupInTree`, `ZeroSizeWidget`, `PrinterMarkArtifact`, `WatermarkEnclosure`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-annot.test.ts`:

```ts
describe('PDF/UA-2 8.9.2.2: annotations that must be artifacts', () => {
  it('8.9.2.2-1 reports an Invisible annotation in the tree', () => {
    // /F bit 1 = Invisible (32000-2 Table 167), transcribed from the profile's
    // own `(F & 1) == 0`.
    expectPair({
      annots: [{ subtype: 'Text', contents: 'c', flags: 1, under: ['P'] }],
    }, 'AnnotInvisible');
  });

  it('8.9.2.2-1 is silent when the annotation is NOT in the tree', () => {
    // Every artifact rule carries `structParentType == null` as a pass, so an
    // untagged annotation is exempt. It reads wrong and it is the anchor's.
    expect(ids({ annots: [{ subtype: 'Text', contents: 'c', flags: 1 }] }, 2))
      .not.toContain('AnnotInvisible');
  });

  it('8.9.2.2-1 is silent under an Artifact element', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', flags: 1, under: ['Artifact'] }],
    }, 2)).not.toContain('AnnotInvisible');
  });

  it('isArtifact walks the WHOLE ancestor chain, not the direct parent', () => {
    // Nested TWO deep. A parent-only test reports here, silently, on a document
    // that renders identically — which is why the fixture nests.
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', flags: 1, under: ['Artifact', 'Span'] }],
    }, 2)).not.toContain('AnnotInvisible');
  });

  it('8.9.2.2-2 reports NoView without ToggleNoView', () => {
    // bit 6 = NoView (32), bit 9 = ToggleNoView (256).
    expectPair({
      annots: [{ subtype: 'Text', contents: 'c', flags: 32, under: ['P'] }],
    }, 'AnnotNoView');
  });

  it('8.9.2.2-2 is silent when ToggleNoView is also set', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', flags: 32 | 256, under: ['P'] }],
    }, 2)).not.toContain('AnnotNoView');
  });
});

describe('PDF/UA-2 8.9: enclosure', () => {
  it('8.9.2.3-1 reports a markup annotation not enclosed by Annot', () => {
    expectPair({
      annots: [{ subtype: 'Text', contents: 'c', under: ['P'] }],
    }, 'MarkupEnclosure');
  });

  it('8.9.2.3-1 is silent under an Annot element', () => {
    expect(ids({ annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }] }, 2))
      .not.toContain('MarkupEnclosure');
  });

  it('8.9.2.3-1 covers Ink, Stamp and FileAttachment, which EXTEND markup', () => {
    // veraPDF's GFPDInkAnnot, GFPDRubberStampAnnot and GFPDFileAttachmentAnnot
    // all extend GFPDMarkupAnnot, so the markup rules reach them — the set is
    // SIXTEEN subtypes, not the thirteen of the dispatch's default branch.
    for (const subtype of ['Ink', 'Stamp', 'FileAttachment']) {
      expect(ids({
        annots: [{ subtype, contents: 'c', extra: { Name: name('Approved') }, under: ['P'] }],
      }, 2), subtype).toContain('MarkupEnclosure');
    }
  });

  it('8.9.2.3-1 does NOT cover Sound or Movie, which ISO calls markup', () => {
    // The divergence to remember: ISO 32000-2 Table 171 counts Sound and Movie
    // as markup annotations and veraPDF's model does not. The profile resolves
    // against the MODEL, so we follow it.
    for (const subtype of ['Sound', 'Movie']) {
      expect(ids({ annots: [{ subtype, contents: 'c', under: ['P'] }] }, 2), subtype)
        .not.toContain('MarkupEnclosure');
    }
  });

  it('8.9.2.4.16-1 reports a Watermark not enclosed by Annot', () => {
    expectPair({
      annots: [{ subtype: 'Watermark', contents: 'c', under: ['P'] }],
    }, 'WatermarkEnclosure');
  });

  it('8.9.2.4.16-1 accepts a Watermark under Annot OR under Artifact', () => {
    for (const under of [['Annot'], ['Artifact']]) {
      expect(ids({ annots: [{ subtype: 'Watermark', contents: 'c', under }] }, 2))
        .not.toContain('WatermarkEnclosure');
    }
  });

  it('8.9.2.4.9-1 reports a Popup that IS in the tree', () => {
    // The INVERSE shape of every other rule here: a Popup must NOT be tagged.
    expectPair({ annots: [{ subtype: 'Popup', under: ['P'] }] }, 'PopupInTree');
    expect(ids({ annots: [{ subtype: 'Popup' }] }, 2)).not.toContain('PopupInTree');
  });

  it('8.9.2.4.14-1 reports a PrinterMark in the tree and not an artifact', () => {
    expectPair({
      annots: [{ subtype: 'PrinterMark', contents: 'c', under: ['P'] }],
    }, 'PrinterMarkArtifact');
    expect(ids({
      annots: [{ subtype: 'PrinterMark', contents: 'c', under: ['Artifact'] }],
    }, 2)).not.toContain('PrinterMarkArtifact');
  });

  it('8.9.2.4.13-1 reports a ZERO-SIZE widget in the tree', () => {
    expectPair({
      annots: [{ subtype: 'Widget', rect: [0, 0, 0, 0], under: ['Form'] }],
    }, 'ZeroSizeWidget');
  });

  it('8.9.2.4.13-1 is silent when EITHER dimension is non-zero', () => {
    // The profile tests `width != 0 || height != 0`, so a zero-WIDTH widget
    // with height is fine. A fixture with both zero cannot see that.
    for (const rect of [[0, 0, 50, 0], [0, 0, 0, 20]] as const) {
      expect(ids({ annots: [{ subtype: 'Widget', rect: [...rect], under: ['Form'] }] }, 2))
        .not.toContain('ZeroSizeWidget');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: FAIL — the seven new rule ids do not appear.

- [ ] **Step 3: Write the implementation**

Append to `src/uaannot.ts`, before `ANNOT_RULES`:

```ts
// /F annotation flags, 32000-2 Table 167. These three values are transcribed
// from the profile's own tests — `(F & 1)`, `(F & 32)`, `(F & 256)`.
const FLAG_INVISIBLE = 1;        // bit 1
const FLAG_NO_VIEW = 32;         // bit 6
const FLAG_TOGGLE_NO_VIEW = 256; // bit 9

/** The subtypes veraPDF models as `PDMarkupAnnot`.
 *
 *  **Invariant: SIXTEEN, and this is NOT ISO 32000-2 Table 171's markup list.**
 *  Thirteen come from `GFPDAnnot`'s dispatch default branch; `FileAttachment`,
 *  `Ink` and `Stamp` are here because their classes EXTEND `GFPDMarkupAnnot`.
 *  Table 171 additionally counts `Sound` and `Movie` as markup and veraPDF's
 *  model does not — the profile's `object="PDMarkupAnnot"` resolves against the
 *  MODEL, so we follow it. Do not "fix" this toward the ISO list.
 *
 *  **Note a third set with a confusingly similar name:** `annotation.ts`'s
 *  `MARKUP_SUBTYPES` is the narrow TEXT-markup family (highlight, underline,
 *  strikeout, squiggly) behind `MarkupAnnotation.MarkupType`. Three sets, one
 *  word; none of them is another. */
const MARKUP_ANNOTS = new Set([
  // GFPDAnnot dispatch, default branch (13)
  'Caret', 'Circle', 'FreeText', 'Highlight', 'Line', 'Polygon', 'PolyLine',
  'Redact', 'StrikeOut', 'Square', 'Squiggly', 'Text', 'Underline',
  // classes that EXTEND GFPDMarkupAnnot (3)
  'FileAttachment', 'Ink', 'Stamp',
]);

/** A rule over every annotation, whatever its subtype. */
function annotRule(
  rule: string, clause: string,
  fires: (ctx: UaCtx, a: AnnotCtx) => string | undefined,
): Rule {
  return (ctx) => {
    if (ctx.part !== 2) return [];
    const issues: ValidationIssue[] = [];
    for (const a of annotContexts(ctx)) {
      const message = fires(ctx, a);
      if (message !== undefined) issues.push(annotIssue(ctx, a, rule, clause, message));
    }
    return issues;
  };
}

/** True when the rule's artifact escape applies: not in the tree, or an
 *  artifact. Every rule in 8.9.2.2, .13, .14, .16 and 8.10 carries it. */
function exempt(a: AnnotCtx): boolean {
  return a.parent === undefined || a.isArtifact;
}

/** 8.9.2.2-1: an Invisible annotation shall be an artifact. */
const annotInvisibleRule = annotRule('AnnotInvisible', '8.9.2.2', (_ctx, a) =>
  exempt(a) || (a.flags & FLAG_INVISIBLE) === 0 ? undefined
    : 'Annotation sets the Invisible flag but is not an artifact.');

/** 8.9.2.2-2: a NoView annotation shall be an artifact, unless it also sets
 *  ToggleNoView — which means it is visible in some states. */
const annotNoViewRule = annotRule('AnnotNoView', '8.9.2.2', (_ctx, a) =>
  exempt(a)
    || (a.flags & FLAG_NO_VIEW) === 0
    || (a.flags & FLAG_TOGGLE_NO_VIEW) === FLAG_TOGGLE_NO_VIEW
    ? undefined
    : 'Annotation sets the NoView flag without ToggleNoView but is not an artifact.');

/** 8.9.2.3-1: a markup annotation shall be enclosed by an Annot element. */
const markupEnclosureRule = annotRule('MarkupEnclosure', '8.9.2.3', (_ctx, a) => {
  if (!MARKUP_ANNOTS.has(a.subtype) || exempt(a)) return undefined;
  if (a.parent?.StandardType === 'Annot') return undefined;
  return `Markup annotation is enclosed by '${a.parent?.Type ?? '(none)'}' `
    + 'instead of an Annot element.';
});

/** 8.9.2.4.16-1: a Watermark shall be an artifact or enclosed by Annot. */
const watermarkEnclosureRule = annotRule('WatermarkEnclosure', '8.9.2.4.16', (_ctx, a) => {
  if (a.subtype !== 'Watermark' || exempt(a)) return undefined;
  if (a.parent?.StandardType === 'Annot') return undefined;
  return 'Watermark annotation is neither an artifact nor enclosed by an Annot element.';
});

/** 8.9.2.4.9-1: a Popup shall NOT be in the structure tree.
 *
 *  **Note the INVERSE shape:** every other rule in this clause exempts an
 *  annotation outside the tree; this one fires precisely because it is inside
 *  one. A popup is the pop-up of another annotation and has no content of its
 *  own to tag. */
const popupInTreeRule = annotRule('PopupInTree', '8.9.2.4.9', (_ctx, a) =>
  a.subtype === 'Popup' && a.parent !== undefined
    ? 'Popup annotation is in the structure tree; it must not be.' : undefined);

/** 8.9.2.4.14-1: a printer's mark shall be an artifact. */
const printerMarkRule = annotRule('PrinterMarkArtifact', '8.9.2.4.14', (_ctx, a) =>
  a.subtype === 'PrinterMark' && !exempt(a)
    ? "Printer's mark annotation is in the structure tree and is not an artifact."
    : undefined);

/** 8.9.2.4.13-1: a widget of zero size shall be an artifact.
 *
 *  **Note the disjunction:** the profile tests `width != 0 || height != 0`, so
 *  only a widget that is zero on BOTH axes reports. A fixture with both zero
 *  cannot see that, so the suite pins each axis separately. */
const zeroSizeWidgetRule = annotRule('ZeroSizeWidget', '8.9.2.4.13', (_ctx, a) => {
  if (a.subtype !== 'Widget' || exempt(a)) return undefined;
  const r = a.annot.Rect;
  if (r === undefined) return undefined;
  const width = Math.abs(r[2] - r[0]);
  const height = Math.abs(r[3] - r[1]);
  if (width !== 0 || height !== 0) return undefined;
  return 'Widget annotation has zero width and height but is not an artifact.';
});
```

and add them to `ANNOT_RULES`:

```ts
  annotInvisibleRule, annotNoViewRule, markupEnclosureRule,
  watermarkEnclosureRule, popupInTreeRule, printerMarkRule, zeroSizeWidgetRule,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the ancestor walk is load-bearing**

Change `hasArtifactAncestor` to test only the element itself
(`return el.StandardType === 'Artifact';`) and run
`npx vitest run test/pdfua2-annot.test.ts`. Expected: the
"walks the WHOLE ancestor chain" case reddens. **Revert.**

Then change `exempt` to `return a.isArtifact;` (dropping the not-in-tree
escape) and confirm the "silent when the annotation is NOT in the tree" case
reddens. **Revert.**

If either leaves the file green, the fixture does not discriminate — fix the
fixture before continuing.

- [ ] **Step 6: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uaannot.ts test/pdfua2-annot.test.ts
git commit -m "feat(q7hc.4.2): the artifact and enclosure rules

isArtifact walks the WHOLE ancestor chain — a parent-only test passes an
annotation nested two deep in an artifact subtree, silently, on a document
that renders identically.

The markup set is SIXTEEN subtypes: veraPDF's thirteen plus FileAttachment,
Ink and Stamp, whose classes extend GFPDMarkupAnnot. It is NOT ISO Table
171's list, which counts Sound and Movie — pinned from both directions."
```

---

### Task 5: Alt mismatch, rich text and tab order

**Files:**
- Modify: `src/uaannot.ts`
- Test: `test/pdfua2-annot.test.ts`

**Interfaces:**
- Consumes: `richTextToPlain` from `./richtext.js`; `readRichTextMarkup` from
  `./formfield.js` (NOT from `richtext.js`).
- Produces rule names: `AnnotAltMismatch`, `MarkupRichText`, `TabOrder`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-annot.test.ts`:

```ts
describe('PDF/UA-2 8.9.4.2-1: Contents and Alt must agree', () => {
  it('reports when both are present and differ', () => {
    expectPair({
      annots: [{ subtype: 'Text', contents: 'one', under: ['Annot'], alt: 'two' }],
    }, 'AnnotAltMismatch');
  });

  it('is silent when they are identical', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'same', under: ['Annot'], alt: 'same' }],
    }, 2)).not.toContain('AnnotAltMismatch');
  });

  it('is silent when either is absent', () => {
    // The profile tests `Contents == null || Alt == null || Contents == Alt`,
    // so an annotation with only one of the two never reports.
    expect(ids({ annots: [{ subtype: 'Text', contents: 'one', under: ['Annot'] }] }, 2))
      .not.toContain('AnnotAltMismatch');
    expect(ids({ annots: [{ subtype: 'Text', under: ['Annot'], alt: 'two' }] }, 2))
      .not.toContain('AnnotAltMismatch');
  });
});

describe('PDF/UA-2 8.9.2.3-2: /RC must match /Contents', () => {
  const rc = (markup: string) =>
    ({ RC: { kind: 'string' as const, bytes: new TextEncoder().encode(markup) } });

  it('reports when the reduced rich text differs from /Contents', () => {
    expectPair({
      annots: [{
        subtype: 'Text', contents: 'hello', under: ['Annot'],
        extra: rc('<body><p>goodbye</p></body>'),
      }],
    }, 'MarkupRichText');
  });

  it('is silent when they agree', () => {
    expect(ids({
      annots: [{
        subtype: 'Text', contents: 'hello', under: ['Annot'],
        extra: rc('<body><p>hello</p></body>'),
      }],
    }, 2)).not.toContain('MarkupRichText');
  });

  it('reduces VERBATIM, so two blocks run together', () => {
    // The mode this rule exists for. veraPDF concatenates every text node, so
    // <p>a</p><p>b</p> is 'ab' and matches Contents 'ab'. Our DEFAULT reduction
    // would give 'a\nb' and report here — which is why the mode is not a
    // preference. A single-<p> fixture cannot tell the two apart.
    expect(ids({
      annots: [{
        subtype: 'Text', contents: 'ab', under: ['Annot'],
        extra: rc('<body><p>a</p><p>b</p></body>'),
      }],
    }, 2)).not.toContain('MarkupRichText');
  });

  it('is silent when /RC is absent', () => {
    expect(ids({ annots: [{ subtype: 'Text', contents: 'hello', under: ['Annot'] }] }, 2))
      .not.toContain('MarkupRichText');
  });
});

describe('PDF/UA-2 8.9.3.3-1: tab order', () => {
  it('reports a page with annotations whose /Tabs is absent', () => {
    expectPair({ annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }] },
      'TabOrder');
  });

  it('accepts A, W and S', () => {
    for (const tabs of ['A', 'W', 'S']) {
      expect(ids({
        annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }], tabs,
      }, 2), tabs).not.toContain('TabOrder');
    }
  });

  it('reports any other value', () => {
    expect(ids({
      annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }], tabs: 'R',
    }, 2)).toContain('TabOrder');
  });

  it('is silent for a page with NO annotations', () => {
    expect(ids({ annots: [] }, 2)).not.toContain('TabOrder');
  });

  it('is a WARNING, not an error', () => {
    // The profile tags this one `minor` where every other rule in 8.9 and 8.10
    // is `major`, so a document with only this defect still passes.
    const report = Document.Open(buildAnnotPdf({
      annots: [{ subtype: 'Text', contents: 'c', under: ['Annot'] }],
    })).ValidatePdfUa(2);
    const hit = report.Issues.find((i) => i.rule === 'TabOrder');
    expect(hit?.severity).toBe('warning');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: FAIL — the three new rule ids do not appear.

- [ ] **Step 3: Write the implementation**

Add the imports to `src/uaannot.ts`:

```ts
import { readRichTextMarkup } from './formfield.js';
import { richTextToPlain } from './richtext.js';
```

and the rules, before `ANNOT_RULES`:

```ts
/** 8.9.4.2-1: where an annotation has /Contents and the directly enclosing
 *  element has /Alt, the two shall be identical.
 *
 *  **Note this rule is ABSENT from the issue's own list** — it is the one that
 *  made 8.9 nineteen rules rather than eighteen. */
const annotAltMismatchRule = annotRule('AnnotAltMismatch', '8.9.4.2', (_ctx, a) => {
  const contents = a.annot.Contents;
  const alt = a.parent?.Alt;
  if (contents === undefined || alt === undefined || contents === alt) return undefined;
  return `Annotation /Contents ('${contents}') and the enclosing element's /Alt `
    + `('${alt}') are both present and differ.`;
});

/** 8.9.2.3-2: a markup annotation's /RC shall be textually equivalent to its
 *  /Contents.
 *
 *  **Invariant: the reduction is VERBATIM.** `DictionaryKeysHelper` concatenates
 *  every text node and does nothing else, so `<p>a</p><p>b</p>` is `ab`. Our
 *  DEFAULT reduction separates blocks on purpose — right for a search, wrong
 *  here — so this passes `{ verbatim: true }`. A single-block fixture cannot
 *  tell the two apart, which is what Acrobat writes.
 *
 *  **Note the two owners:** `readRichTextMarkup` (formfield.ts) handles the
 *  string-or-stream duality, `richTextToPlain` (richtext.ts) handles the
 *  markup. Neither throws, which is what keeps a damaged /RC from taking the
 *  report down — `annotsearch.ts`'s arrangement, reused. */
const markupRichTextRule = annotRule('MarkupRichText', '8.9.2.3', (ctx, a) => {
  if (!MARKUP_ANNOTS.has(a.subtype) || !a.dict.has('RC')) return undefined;
  const contents = a.annot.Contents;
  if (contents === undefined) return undefined;
  const markup = readRichTextMarkup(ctx.doc, a.dict, 'RC');
  if (markup === undefined) return undefined;
  const plain = richTextToPlain(markup, { verbatim: true });
  if (plain === undefined || plain === contents) return undefined;
  return `Annotation /RC reduces to '${plain}', which differs from /Contents `
    + `('${contents}').`;
});

/** 8.9.3.3-1: a page carrying annotations shall state a tab order of A, W or S.
 *
 *  **Note the SEVERITY:** the profile tags this `minor` where every other rule
 *  in 8.9 and 8.10 is `major`, so this is the one WARNING of the two clauses
 *  and a document with only this defect still reports `Passed`. */
const TAB_ORDERS = new Set(['A', 'W', 'S']);

const tabOrderRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const page of ctx.doc.Pages) {
    if (page.Annotations.length === 0) continue;
    const tabs = ctx.doc.resolve(page.Dict.get('Tabs'));
    if (isName(tabs) && TAB_ORDERS.has(tabs.name)) continue;
    issues.push({
      rule: 'TabOrder', severity: 'warning',
      clause: uaClause(ctx.part, { 2: '8.9.3.3' }), page,
      message: 'Page carries annotations but its /Tabs is not A, W or S.',
    });
  }
  return issues;
};
```

and add to `ANNOT_RULES`:

```ts
  annotAltMismatchRule, markupRichTextRule, tabOrderRule,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the verbatim mode is load-bearing**

Change `markupRichTextRule` to call `richTextToPlain(markup)` with no options
and run `npx vitest run test/pdfua2-annot.test.ts`. Expected: the "reduces
VERBATIM, so two blocks run together" case reddens. **Revert.**

- [ ] **Step 6: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uaannot.ts test/pdfua2-annot.test.ts
git commit -m "feat(q7hc.4.2): Alt mismatch, rich-text equivalence and tab order

8.9.4.2-1 is the rule the issue's own list omitted, and the reason 8.9 is
nineteen rules rather than eighteen.

The rich-text comparison reduces VERBATIM — a single-<p> fixture, which is
what Acrobat writes, cannot tell that from the default.

TabOrder is the one WARNING of both clauses; the profile tags it minor."
```

---

### Task 6: The six form rules

**Files:**
- Modify: `src/uaannot.ts`
- Test: `test/pdfua2-annot.test.ts`

**Interfaces:**
- Produces rule names: `WidgetEnclosure`, `FormWidgetCount`, `XfaPresent`,
  `WidgetDescription`, `WidgetActionDescription`, `TextFieldRichValue`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-annot.test.ts`:

```ts
describe('PDF/UA-2 8.10: forms', () => {
  /** A widget that IS a field: a merged field/widget carrying /FT. */
  const field = (extra: Record<string, unknown> = {}) => ({
    subtype: 'Widget', extra: { FT: name('Tx'), ...extra } as never,
  });

  it('8.10.1-1 reports a field widget not enclosed by Form', () => {
    expectPair({ annots: [{ ...field(), contents: 'c', under: ['P'] }] },
      'WidgetEnclosure');
  });

  it('8.10.1-1 is silent under a Form element', () => {
    expect(ids({ annots: [{ ...field(), contents: 'c', under: ['Form'] }] }, 2))
      .not.toContain('WidgetEnclosure');
  });

  it('8.10.1-1 EXEMPTS a widget that belongs to no field', () => {
    // isFieldWidget is `is a field OR has a /Parent`. A standalone widget is
    // exempt — and every widget our own form API creates IS a field widget, so
    // without this fixture the exemption is unmeasured.
    expect(ids({ annots: [{ subtype: 'Widget', contents: 'c', under: ['P'] }] }, 2))
      .not.toContain('WidgetEnclosure');
  });

  it('8.10.1-3 reports an /AcroForm /XFA', () => {
    expectPair({ annots: [], xfa: true }, 'XfaPresent');
    expect(ids({ annots: [] }, 2)).not.toContain('XfaPresent');
  });

  it('8.10.2.3-1 reports a field widget with neither Lbl nor /Contents', () => {
    expectPair({ annots: [{ ...field(), under: ['Form'] }] }, 'WidgetDescription');
  });

  it('8.10.2.3-1 is silent with /Contents, or with a FILLED Lbl', () => {
    expect(ids({ annots: [{ ...field(), contents: 'c', under: ['Form'] }] }, 2))
      .not.toContain('WidgetDescription');
    expect(ids({ annots: [{ ...field(), under: ['Form'], label: 'filled' }] }, 2))
      .not.toContain('WidgetDescription');
  });

  it('8.10.2.3-1 does NOT accept an EMPTY Lbl', () => {
    // GFPDWidgetAnnot.getcontainsLbl requires `!child.getChildren().isEmpty()`.
    // A label element with nothing in it labels nothing.
    expect(ids({ annots: [{ ...field(), under: ['Form'], label: 'empty' }] }, 2))
      .toContain('WidgetDescription');
  });

  it('8.10.2.3-2 reports a field widget with /AA and no /Contents', () => {
    expectPair({
      annots: [{ ...field({ AA: new Map() }), under: ['Form'], label: 'filled' }],
    }, 'WidgetActionDescription');
  });

  it('8.10.2.3-2 is satisfied by /Contents, NOT by a label', () => {
    // The two rules differ: -1 accepts an Lbl, -2 demands /Contents outright.
    expect(ids({
      annots: [{ ...field({ AA: new Map() }), contents: 'c', under: ['Form'] }],
    }, 2)).not.toContain('WidgetActionDescription');
  });

  it('8.10.1-2 reports a Form element holding two widgets', () => {
    // Both widgets tagged under ONE Form element, which needs the builder to
    // reuse the element rather than append a second — see `shareUnder`.
    expectPair({
      annots: [
        { ...field(), contents: 'a', under: ['Form'], shareUnder: 'f' },
        { ...field(), contents: 'b', under: ['Form'], shareUnder: 'f' },
      ],
    }, 'FormWidgetCount');
  });

  it('8.10.1-2 is silent for one widget per Form', () => {
    expect(ids({
      annots: [
        { ...field(), contents: 'a', under: ['Form'] },
        { ...field(), contents: 'b', under: ['Form'] },
      ],
    }, 2)).not.toContain('FormWidgetCount');
  });

  it('8.10.3.3-1 reports /RV without /V, and /RV differing from /V', () => {
    const rv = (markup: string) =>
      ({ RV: { kind: 'string' as const, bytes: new TextEncoder().encode(markup) } });
    expectPair({
      annots: [{ ...field(rv('<body><p>x</p></body>')), contents: 'c', under: ['Form'] }],
    }, 'TextFieldRichValue');
    expect(ids({
      annots: [{
        ...field({
          ...rv('<body><p>x</p></body>'),
          V: { kind: 'string' as const, bytes: new TextEncoder().encode('y') },
        }),
        contents: 'c', under: ['Form'],
      }],
    }, 2)).toContain('TextFieldRichValue');
  });

  it('8.10.3.3-1 is silent when /RV and /V agree', () => {
    expect(ids({
      annots: [{
        ...field({
          RV: { kind: 'string' as const, bytes: new TextEncoder().encode('<body><p>x</p></body>') },
          V: { kind: 'string' as const, bytes: new TextEncoder().encode('x') },
        }),
        contents: 'c', under: ['Form'],
      }],
    }, 2)).not.toContain('TextFieldRichValue');
  });
});
```

- [ ] **Step 2: Extend the fixture builder for shared enclosures**

`8.10.1-2` needs TWO widgets under ONE `Form` element. Add to `AnnotSpec` in
`test/helpers/build-annot-pdf.ts`:

```ts
  /** Two annotations carrying the same `shareUnder` key are tagged under the
   *  SAME enclosing element, rather than each getting its own chain. Required
   *  by 8.10.1-2, which is about one Form holding two widgets. */
  shareUnder?: string;
```

and in `buildAnnotPdf`, replace the `if (a.under !== undefined)` block's
element construction with a memo:

```ts
  const shared = new Map<string, StructElement>();
  // ... inside the loop:
    if (a.under !== undefined) {
      const key = a.shareUnder;
      let el = key === undefined ? undefined : shared.get(key);
      if (el === undefined) {
        el = docEl;
        for (const t of a.under) el = el.Append(t);
        if (key !== undefined) shared.set(key, el);
      }
      // ... alt, label and AddAnnotation exactly as before, on `el`
    }
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: FAIL — the six new rule ids do not appear.

- [ ] **Step 4: Write the implementation**

Append to `src/uaannot.ts`, before `ANNOT_RULES`:

```ts
/** `GFPDWidgetAnnot.getisFieldWidget`: the widget dict IS a field (a merged
 *  field/widget, carrying /FT) or it has a /Parent.
 *
 *  A standalone widget belonging to no field is exempt from 8.10.1-1 and both
 *  8.10.2.3 rules. Every widget this library's own form API creates is a field
 *  widget, so the exemption is unmeasured without a hand-built fixture. */
function isFieldWidget(a: AnnotCtx): boolean {
  return a.subtype === 'Widget' && (a.dict.has('FT') || a.dict.has('Parent'));
}

/** `GFPDWidgetAnnot.getcontainsLbl`: an `Lbl` among the ENCLOSING element's
 *  children, with a NON-EMPTY /K.
 *
 *  **Invariant: the empty-Lbl test is part of the rule.** A label element with
 *  nothing in it labels nothing, and a first reading checks only the type.
 *
 *  **Note it uses PLAIN children, not `significantChildren`.** `q7hc.4.1`'s
 *  pass-through splicing is `getStructuralSignificanceChildren`, a DIFFERENT
 *  method, and veraPDF calls the plain one here. Do not unify them. */
function hasFilledLabel(el: StructElement | undefined): boolean {
  if (el === undefined) return false;
  return el.Children.some((c) => c.StandardType === 'Lbl'
    && (c.Children.length > 0 || c.ContentItems.length > 0));
}

/** 8.10.1-1: a field widget shall be enclosed by a Form element. */
const widgetEnclosureRule = annotRule('WidgetEnclosure', '8.10.1', (_ctx, a) => {
  if (!isFieldWidget(a) || exempt(a)) return undefined;
  if (a.parent?.StandardType === 'Form') return undefined;
  return `Widget annotation is enclosed by '${a.parent?.Type ?? '(none)'}' `
    + 'instead of a Form element.';
});

/** 8.10.2.3-1: a field widget needs a label or a /Contents. */
const widgetDescriptionRule = annotRule('WidgetDescription', '8.10.2.3', (_ctx, a) => {
  if (!isFieldWidget(a) || exempt(a)) return undefined;
  if (hasFilledLabel(a.parent) || a.annot.Contents !== undefined) return undefined;
  return 'Widget annotation has neither an Lbl in its enclosing element nor /Contents.';
});

/** 8.10.2.3-2: a field widget with /AA needs /Contents.
 *
 *  **Note it is NOT satisfied by a label**, unlike -1: an additional action can
 *  change the field's behaviour, and the description of that has to travel with
 *  the annotation. */
const widgetActionRule = annotRule('WidgetActionDescription', '8.10.2.3', (_ctx, a) => {
  if (!isFieldWidget(a) || exempt(a) || !a.dict.has('AA')) return undefined;
  if (a.annot.Contents !== undefined) return undefined;
  return 'Widget annotation has an /AA additional action but no /Contents.';
});

/** 8.10.1-2: a Form element shall hold at most one widget annotation.
 *
 *  Counts `/OBJR` kids whose referenced dict is `/Subtype /Widget`, which is
 *  `GFSEForm.getwidgetAnnotsCount`. */
const formWidgetCountRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    if (element.StandardType !== 'Form') continue;
    let widgets = 0;
    for (const item of element.ContentItems) {
      if (item.kind !== 'objr') continue;
      const d = ctx.doc.resolve(item.ref);
      if (!isDict(d)) continue;
      const st = ctx.doc.resolve(d.get('Subtype'));
      if (isName(st) && st.name === 'Widget') widgets++;
    }
    if (widgets <= 1) continue;
    issues.push({
      rule: 'FormWidgetCount', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.10.1' }), element,
      message: `Form structure element holds ${widgets} widget annotations; `
        + 'it may hold at most one.',
    });
  }
  return issues;
};

/** 8.10.1-3: XFA forms shall not be present.
 *
 *  **Note the overlap with `xfaconvert.ts`, which is documented rather than
 *  automated:** `ConvertXfaToAcroForm()` converts the fields and removes
 *  `/XFA`, so running it first satisfies this rule for free. The validator does
 *  not call it, and `ConvertToPdfUa` gains no XFA pass — that would be a
 *  field-authoring decision. */
const xfaPresentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const acro = ctx.doc.resolve(ctx.catalog.get('AcroForm'));
  if (!isDict(acro) || !acro.has('XFA')) return [];
  return [{
    rule: 'XfaPresent', severity: 'error',
    clause: uaClause(ctx.part, { 2: '8.10.1' }),
    message: 'Catalog /AcroForm carries an /XFA packet, which PDF/UA-2 prohibits. '
      + 'ConvertXfaToAcroForm() converts the fields and removes it.',
  }];
};

/** 8.10.3.3-1: a text field with /RV shall also have /V, and the two shall be
 *  textually equivalent.
 *
 *  Reduced VERBATIM, for `markupRichTextRule`'s reason. */
const textFieldRichValueRule = annotRule('TextFieldRichValue', '8.10.3.3', (ctx, a) => {
  if (!a.dict.has('RV')) return undefined;
  const vRaw = ctx.doc.resolve(a.dict.get('V'));
  const v = isString(vRaw) ? decodePdfText(vRaw.bytes) : undefined;
  if (v === undefined) return 'Text field has /RV but no /V.';
  const markup = readRichTextMarkup(ctx.doc, a.dict, 'RV');
  if (markup === undefined) return undefined;
  const plain = richTextToPlain(markup, { verbatim: true });
  if (plain === undefined || plain === v) return undefined;
  return `Text field /RV reduces to '${plain}', which differs from /V ('${v}').`;
});
```

and extend the imports at the top of `src/uaannot.ts` — `isString` is exported
from `./types.js` and `decodePdfText` from `./metadata.js`, both verified:

```ts
import { decodePdfText } from './metadata.js';
import { isDict, isName, isString, type PdfDict } from './types.js';
```

and add to `ANNOT_RULES`:

```ts
  widgetEnclosureRule, widgetDescriptionRule, widgetActionRule,
  formWidgetCountRule, xfaPresentRule, textFieldRichValueRule,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-annot.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove three form rules are load-bearing**

Run each, confirm it reddens, then **revert**:

1. `hasFilledLabel` ignoring emptiness (drop the `Children.length > 0 ||
   ContentItems.length > 0` test) — the EMPTY-Lbl case must redden.
2. `isFieldWidget` returning `a.subtype === 'Widget'` — the standalone-widget
   exemption case must redden.
3. `widgetActionRule` accepting a label (add `|| hasFilledLabel(a.parent)`) —
   the "/AA is satisfied by Contents, NOT by a label" case must redden.

- [ ] **Step 7: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uaannot.ts test/pdfua2-annot.test.ts test/helpers/build-annot-pdf.ts
git commit -m "feat(q7hc.4.2): the six form rules

containsLbl requires a NON-EMPTY Lbl — a label element with nothing in it
labels nothing, and a first reading checks only the type.

isFieldWidget exempts a widget belonging to no field, and every widget our
own form API creates IS one, so the exemption needs a hand-built fixture.

8.10.2.3-2 is NOT satisfied by a label, unlike -1."
```

---

### Task 7: The census, the count correction, and the docs

**Files:**
- Create: `test/pdfua2-annot-coverage.test.ts`
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Write the census**

Create `test/pdfua2-annot-coverage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The 25 rule names ISO 14289-2 8.9 and 8.10 add (`q7hc.4.2`).
 *
 *  A CENSUS rather than a behaviour test: `pdfua2-annot.test.ts` asserts each
 *  as a cross-part pair, and this asserts the set is exactly the 25 — so a rule
 *  dropped in a refactor, or a twenty-sixth quietly added, is a red build. */
const CLAUSE_8_9_8_10_RULES = [
  'AnnotInvisible',             // 8.9.2.2-1
  'AnnotNoView',                // 8.9.2.2-2
  'MarkupEnclosure',            // 8.9.2.3-1
  'MarkupRichText',             // 8.9.2.3-2
  'StampDescription',           // 8.9.2.4.7-1
  'InkDescription',             // 8.9.2.4.8-1
  'PopupInTree',                // 8.9.2.4.9-1
  'FileAttachmentRelationship', // 8.9.2.4.10-1
  'SoundProhibited',            // 8.9.2.4.11-1
  'MovieProhibited',            // 8.9.2.4.11-2
  'ScreenDescription',          // 8.9.2.4.12-1
  'ZeroSizeWidget',             // 8.9.2.4.13-1
  'PrinterMarkArtifact',        // 8.9.2.4.14-1
  'TrapNetProhibited',          // 8.9.2.4.15-1
  'WatermarkEnclosure',         // 8.9.2.4.16-1
  'ThreeDDescription',          // 8.9.2.4.19-1
  'RichMediaDescription',       // 8.9.2.4.19-2
  'TabOrder',                   // 8.9.3.3-1
  'AnnotAltMismatch',           // 8.9.4.2-1
  'WidgetEnclosure',            // 8.10.1-1
  'FormWidgetCount',            // 8.10.1-2
  'XfaPresent',                 // 8.10.1-3
  'WidgetDescription',          // 8.10.2.3-1
  'WidgetActionDescription',    // 8.10.2.3-2
  'TextFieldRichValue',         // 8.10.3.3-1
] as const;

describe('ISO 14289-2 8.9 / 8.10 rule census', () => {
  it('names exactly twenty-five rules', () => {
    expect(CLAUSE_8_9_8_10_RULES).toHaveLength(25);
    expect(new Set(CLAUSE_8_9_8_10_RULES).size).toBe(25);
  });

  it('every one is emitted by uaannot.ts', () => {
    const src = readFileSync('src/uaannot.ts', 'utf8');
    for (const rule of CLAUSE_8_9_8_10_RULES) {
      expect(src, `${rule} is not emitted anywhere`).toContain(`'${rule}'`);
    }
  });

  it('the markup set is SIXTEEN subtypes', () => {
    // Asserted by size so a half-pasted table is a red build — the rule
    // htmlforeign.ts sets for its five tables.
    const src = readFileSync('src/uaannot.ts', 'utf8');
    const m = /const MARKUP_ANNOTS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    expect(m).not.toBeNull();
    const entries = m![1].match(/'[A-Za-z]+'/g) ?? [];
    expect(entries).toHaveLength(16);
  });

  it('8.10.3.5-1 is deliberately NOT among them', () => {
    // Deferred to q7hc.4.6: veraPDF states it over a grouped content-item model
    // we do not have, so any version here would be an approximation. Named so
    // the absence reads as a decision.
    expect(CLAUSE_8_9_8_10_RULES as readonly string[]).not.toContain('SignatureGraphicAlt');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/pdfua2-annot-coverage.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 3: Correct the rule count in CLAUDE.md**

In `CLAUDE.md`, find the paragraph beginning **"Note the SCOPE, so the absences
read as decisions:"** and replace its first sentences. It currently reads
"`q7hc.4` was 18 of the anchor's 90 rules and `q7hc.4.1` added the 8.2.5 clause,
so 38 now ship. The remaining 51 are `.2` (annotations and forms, 25), `.3`
(fonts and CMaps, 15) and `.4` (PUA, language, optional content, destinations,
embedded files, 11)."

Replace with:

```markdown
  **Note the SCOPE, so the absences read as decisions, and note the count was
  WRONG until `q7hc.4.2` counted the files:** the anchor has **91** rule files,
  not 90 — `8.9 Annotations` holds 19, not 18. `q7hc.4` covered 18, `q7hc.4.1`
  the 8.2.5 clause (21), and `q7hc.4.2` clauses 8.9 and 8.10 (25 of their 26),
  so **64 of 91** ship. The remaining 27 are `.3` (fonts and CMaps, 15), `.4`
  (PUA, language, optional content, destinations, embedded files, 11) and
  `.6` (8.10.3.5-1, 1).
  **Note the earlier figure mixed two units**, which is how it came to be wrong
  twice over: "38" counted the new rule NAMES `q7hc.4.1` added, while the rest
  of the sentence counted profile FILES — and `8.2.5.28.2-1` is covered without
  being newly implemented, so the file count was 39.
```

- [ ] **Step 4: Add the `uaannot.ts` CLAUDE.md entry**

Immediately after the `uarule.ts` entry added in Task 1:

```markdown
- **uaannot.ts** — ISO 14289-2 clauses 8.9 (annotations) and 8.10 (forms), the
  25 rules `q7hc.4.2` added. Transcribed from the veraPDF profiles plus
  `GFPDAnnot.java`, `annotations/GFPDWidgetAnnot.java`,
  `annotations/GFPDMarkupAnnot.java`, `annotations/GFPDFileAttachmentAnnot.java`
  and `gfse/GFSEForm.java` — as in `q7hc.4.1`, the profiles alone are not
  enough, because `isArtifact`, `isFieldWidget`, `containsLbl` and the
  rich-text reduction are bare identifiers there.
  **Invariant:** its own module rather than more of `structvalidate.ts`, which
  is the STRUCTURE TREE's rules and was already ~900 lines. The split is by
  subject, the way `redactannots.ts` splits object-graph work off `redact.ts`'s
  content-stream surgery; both import the shared vocabulary from `uarule.ts`,
  which is what keeps the pair free of a cycle.
  **Invariant:** ONE record per annotation, computed once. `isArtifact` walks an
  ancestor chain, so computing it per rule would walk the same chain eight
  times.
  **Invariant, and the obvious reading is wrong:** `isArtifact` is an `Artifact`
  element ANYWHERE up the chain, not the direct parent. A parent-only test
  passes an annotation nested two deep inside an artifact subtree — silently,
  on a document that renders identically.
  **Invariant:** "in the structure tree" means `/StructParent` RESOLVES, and an
  annotation outside the tree is EXEMPT from every artifact rule. That reads
  wrong; it is what the anchor says, and `UntaggedContent` covers that case.
  **Note, measured in `q7hc.4.1` and true here too:** that exemption is held by
  a CONJUNCTION of the `/StructParent`-is-a-number test and the
  `element === undefined` test — breaking either ALONE proves nothing.
  **Invariant:** `MARKUP_ANNOTS` is **SIXTEEN** subtypes and is NOT ISO 32000-2
  Table 171's markup list. Thirteen come from `GFPDAnnot`'s dispatch default
  branch; `FileAttachment`, `Ink` and `Stamp` are there because their classes
  EXTEND `GFPDMarkupAnnot`. Table 171 additionally counts `Sound` and `Movie`,
  and veraPDF's model does not — the profile resolves against the MODEL. Do not
  "fix" it toward ISO. **Note a THIRD set with a near-identical name:**
  `annotation.ts`'s `MARKUP_SUBTYPES` is the narrow TEXT-markup family
  (highlight, underline, strikeout, squiggly). Three sets, one word.
  **Invariant:** `containsLbl` requires a NON-EMPTY `Lbl` — a label element with
  nothing in it labels nothing — and it reads PLAIN children, not
  `significantChildren`. `q7hc.4.1`'s pass-through splicing is a DIFFERENT
  veraPDF method and is not called here.
  **Invariant:** `isFieldWidget` is "the dict IS a field (`/FT`) or has a
  `/Parent`", so a standalone widget is exempt from 8.10.1-1 and both 8.10.2.3
  rules. Every widget this library's own form API creates is a field widget, so
  that exemption is unmeasured without a hand-built fixture.
  **Note 8.10.2.3-2 is NOT satisfied by a label**, unlike -1: an additional
  action changes the field's behaviour and its description must travel with the
  annotation.
  **Note `TabOrder` is the one WARNING of both clauses** — the profile tags it
  `minor` where every other rule is `major` — so a document with only that
  defect still reports `Passed`.
  **Invariant:** NOTHING here is converted. `ConvertToPdfUa` gains no pass: an
  absent `/Contents`, a missing `Lbl`, a prohibited `/Sound` and an XFA packet
  are authoring or destructive decisions, and the two that could be automated
  (`/Tabs`, `/AFRelationship`) are not worth a pass alone. Every rule lands in
  `unresolved`. **Note the `/XFA` overlap is documented rather than automated:**
  `ConvertXfaToAcroForm()` converts the fields and removes the packet, so
  running it first satisfies 8.10.1-3 for free.
  **Note what is ABSENT and why:** 8.10.3.5-1 (a graphic representing part of a
  signature's appearance needs `/Alt`) is stated over a grouped CONTENT-ITEM
  model we do not have — `visitFormContent` gives annotation granularity — so
  it is filed as `q7hc.4.6` rather than approximated silently.
```

- [ ] **Step 5: README and CHANGELOG**

In `README.md`, extend the `ValidatePdfUa` sentence that lists what part 2
adds, appending before its final "Part 1 is the default and is unchanged.":

```markdown
It also answers clauses 8.9 and 8.10 — annotations and forms: an Invisible or NoView annotation that is not an artifact, a markup annotation not enclosed by an `Annot` element or whose `/RC` disagrees with its `/Contents`, `/Ink`, `/Screen`, `/3D` and `/RichMedia` annotations with no `/Contents` and a rubber stamp with neither `/Name` nor `/Contents`, a `/Popup` that is tagged, a file attachment whose `/FS` states no `/AFRelationship`, the prohibited `/Sound`, `/Movie` and `/TrapNet` subtypes, a zero-size widget or a printer's mark that is not an artifact, a watermark outside an `Annot`, a page carrying annotations with no `/Tabs` (a warning), an annotation whose `/Contents` and enclosing `/Alt` differ, a field widget outside a `Form` element or sharing one with another widget, an `/XFA` packet, a widget with neither a label nor `/Contents`, and a text field whose `/RV` has no matching `/V`.
```

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, above the
`q7hc.4.1` entry:

```markdown
- **`ValidatePdfUa(2)` now answers ISO 14289-2 clauses 8.9 and 8.10** —
  annotations and forms. Twenty-five rules: the annotations that must be
  artifacts (Invisible, NoView without ToggleNoView, zero-size widgets,
  printer's marks), the ones that must describe themselves (`/Ink`, `/Screen`,
  `/3D`, `/RichMedia`, and a rubber stamp with neither `/Name` nor
  `/Contents`), enclosure (markup annotations in an `Annot`, field widgets in a
  `Form`, at most one widget per `Form`, a `/Popup` that must NOT be tagged),
  the subtypes PDF/UA-2 prohibits outright (`/Sound`, `/Movie`, `/TrapNet`),
  `/XFA`, tab order, and three textual-equivalence rules — `/Contents` against
  the enclosing element's `/Alt`, `/RC` against `/Contents`, and a text field's
  `/RV` against its `/V`. The last two reduce rich text the way the standard's
  reference validator does, by concatenating every text node, which is a new
  `{ verbatim: true }` mode on the existing reducer rather than a second one;
  the default is unchanged. Note what is NOT converted: every rule here lands
  in `unresolved`, because an absent `/Contents`, a missing label, a prohibited
  `/Sound` and an XFA packet are all authoring or destructive decisions —
  though `ConvertXfaToAcroForm()` converts the fields and removes `/XFA`, so
  running it first satisfies that rule for free. All part 2 only; part 1 is
  unchanged. (`q7hc.4.2`)
```

- [ ] **Step 6: Full verification and commit**

```bash
npm run typecheck && npm test
npx vitest run test/pdfua-part1-identity.test.ts test/import-cycles.test.ts
node -e "const fs=require('fs');const md=fs.readFileSync('CLAUDE.md','utf8');const m=fs.readdirSync('src').filter(f=>f.endsWith('.ts')).filter(b=>!md.includes('**'+b+'**')&&!md.includes('\`'+b+'\`'));console.log(m.length===0?'sweep clean':'MISSING: '+m.join(', '));"
git add test/pdfua2-annot-coverage.test.ts CLAUDE.md README.md CHANGELOG.md
git commit -m "docs(q7hc.4.2): the census, and the rule count corrected to 91

The anchor has 91 rule files, not 90 — 8.9 holds 19, not 18. The earlier
figure also mixed two units: 38 counted new rule NAMES where the rest of
the sentence counted profile FILES. 64 of 91 now ship."
```

---

## Final verification

- [ ] `npm run typecheck` — green.
- [ ] `npm test` — green.
- [ ] The four part-1 fences pass **with no edits in the diff**:
      `git diff --stat main -- test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfuaconvert.test.ts test/markdown-pdfua.test.ts`
      (expected: empty).
- [ ] `test/richtext.test.ts`'s PRE-EXISTING cases and `test/annot-search.test.ts`
      pass unedited — the fence that `richTextToPlain`'s default did not move.
- [ ] `test/import-cycles.test.ts` — the same 15 pairs. `uarule.ts` is what
      keeps it there; if this is red, the extraction in Task 1 was skipped.
- [ ] The CLAUDE.md sweep prints nothing.
- [ ] `bd close q7hc.4.2` with a note recording the 91/26 correction, the
      deferral to `q7hc.4.6`, and any rule a mutation showed to be uncovered.
- [ ] `git pull --rebase && git push && git status` — must show up to date with
      origin. **Work is not complete until the push succeeds.**
