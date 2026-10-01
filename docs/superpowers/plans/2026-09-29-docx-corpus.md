# Real-world DOCX Corpus Implementation Plan (`m2fp.4`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A corpus of `.docx` files written by Word 2010 and LibreOffice, each read back by BOTH applications into committed ground truth, and a test holding `readDocx` to what the two readers agree on.

**Architecture:** Two builder scripts (Word COM, LibreOffice UNO) produce ten documents from five shared recipes; two reader scripts turn any `.docx` into a `DocxTruth` JSON in one schema; a TypeScript helper projects `readDocx`'s model into the same schema and diffs by JSON path; `test/docx-corpus.test.ts` pins the reader disagreements and asserts `readDocx` everywhere else. `wmlbody.ts` gains the records the corpus needs (sections, headers, footers, revisions, simple fields).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest; PowerShell 5.1 + Word 2010 COM; LibreOffice (pinned, unpacked by an MSI administrative install) with its bundled Python and UNO. The scripts are never run by `npm test`.

**Spec:** `docs/superpowers/specs/2026-09-29-docx-corpus-design.md`

## Global Constraints

- Zero runtime dependencies; nothing new is exported from `index.ts`; no CHANGELOG entry.
- Word files are named `word2010-<topic>.docx`; LibreOffice files `lo<major>.<minor>-<topic>.docx`; truth files `<name>.word.json` and `<name>.lo.json` beside them. Topics: `styles`, `lists`, `tables`, `media`, `skipped`.
- `wml-oracle.docx` is `m2fp.3`'s oracle and is NOT part of the corpus; `word2010-basic.docx` IS.
- Truth JSON is written only by the reader scripts — never edited by hand. It is UTF-8 WITHOUT a BOM.
- **Ruling (spec gap): `styleName` is recorded but never compared.** Word's localized UI reports `Заголовок 1`, LibreOffice `Heading 1`, `readDocx` `heading 1` — no two can agree.
- **Ruling (spec gap): both readers ACCEPT ALL tracked changes before reading paragraphs** (after counting them). `readDocx` shows the final text, while Word's `Range.Text` and LibreOffice's `getString` include deleted text.
- Every `catch` in `src/` calls `rethrowLimit(e)` first. `npm run typecheck` and `npm test` green before closing.
- **The ledger** for this plan is `.superpowers/sdd/2026-09-29-docx-corpus/progress.md` (executing-plans creates it); every deviation is a `Ruling:` line there.
- Downloading LibreOffice was approved in brainstorming; it goes OUTSIDE the repo, in `%LOCALAPPDATA%\pdf4ts-tools\`.

## Review Focus

1. **A truth file where PowerShell collapsed a one-element array to a scalar** — `ConvertTo-Json` does this through a pipeline; every array field must still be an array. Pinned by `assertTruthShape` in Task 2, run on every truth file in Task 5.
2. **Two readers disagreeing so widely that the test asserts nothing** (paragraph counts differing at a TOC or section break) — each file must still compare at least one paragraph. Pinned in Task 5.
3. **A `.docx` added to the directory without truth** — the test must fail naming it, not skip it. Pinned in Task 5.
4. **A truth file read with a BOM or CRLF** — parsing must not depend on either. Pinned in Task 2 (`readTruth`).
5. **Text inside a text box** — both readers treat it as a separate story while `readDocx` keeps it inline; the test strips the recipe's marker text and says why. Pinned in Task 5.

---

## File Structure

- Modify `src/wmlbody.ts`, `src/wmlstyles.ts` — record sections, header/footer references, revisions and simple fields.
- Create `test/helpers/docx-truth.ts` — `DocxTruth` types, `readTruth`, `assertTruthShape`, `mergeSegments`, `leafDiff`, `comparable`, `readerDisagreements`, `truthOf`.
- Create `test/docx-truth.test.ts`, `test/docx-corpus.test.ts`.
- Create `scripts/gen-docx-corpus-word.ps1`, `scripts/docx-truth-word.ps1`, `scripts/lo_common.py`, `scripts/gen-docx-corpus-lo.py`, `scripts/docx-truth-lo.py`, `scripts/gen-docx-corpus.ps1`, `scripts/docx-disagreements.ts`.
- Create (generated) `test/fixtures/docx/word2010-{styles,lists,tables,media,skipped}.docx`, `lo<v>-{…}.docx`, every `*.word.json` / `*.lo.json`, `disagreements.json`.
- Modify `test/fixtures/docx/PROVENANCE.md`, `CLAUDE.md`, `test/wmlbody.test.ts`.

---

### Task 1: `wmlbody.ts` records sections, headers, footers, revisions and simple fields

**Files:**
- Modify: `src/wmlbody.ts`, `src/wmlstyles.ts`
- Test: `test/wmlbody.test.ts`

**Interfaces:**
- Produces: `unsupported` names `w:headerReference`, `w:footerReference`, `w:sectPr` (a section break inside a paragraph), `w:ins`, `w:del`, `w:moveTo`, `w:moveFrom`, `w:fldSimple` — Task 5's skipped mapping relies on them.

- [ ] **Step 1: Write the failing tests**

Append to `test/wmlbody.test.ts` (it already defines `body`, `paras`, `textOf`, `unsupported`, `p`, `r`):

```ts
describe('sections, revisions and simple fields', () => {
  it('records the header and footer references of the final section', () => {
    const res = body(p(r('x')) + '<w:sectPr><w:headerReference w:type="default" r:id="rH"/>'
      + '<w:footerReference w:type="default" r:id="rF"/><w:footerReference w:type="first" r:id="rF2"/>'
      + '<w:pgSz w:w="11906" w:h="16838"/></w:sectPr>');
    expect(unsupported(res)).toEqual({ 'w:headerReference': 1, 'w:footerReference': 2 });
    expect(res.page?.widthPt).toBe(595.3);
  });

  it('records a section break inside a paragraph, and keeps it out of the paragraph\'s unmodelled list', () => {
    const res = body(p(r('one'), '<w:sectPr><w:headerReference w:type="default" r:id="rH"/><w:pgSz w:w="16838" w:h="11906"/></w:sectPr>')
      + p(r('two')));
    expect(unsupported(res)).toEqual({ 'w:sectPr': 1, 'w:headerReference': 1 });
    expect(paras(res)[0].unmodelled).toEqual([]);
    expect(paras(res).map(textOf)).toEqual(['one', 'two']);
  });

  it('records tracked insertions and deletions while showing the final text', () => {
    const res = body(p(`${r('a')}<w:ins w:id="1" w:author="x">${r('b')}</w:ins>`
      + '<w:del w:id="2" w:author="x"><w:r><w:delText>c</w:delText></w:r></w:del>'));
    expect(textOf(paras(res)[0])).toBe('ab');
    expect(unsupported(res)).toEqual({ 'w:ins': 1, 'w:del': 1 });
  });

  it('records moves like insertions and deletions', () => {
    const res = body(p(`<w:moveFrom w:id="1" w:author="x"><w:r><w:t>old</w:t></w:r></w:moveFrom><w:moveTo w:id="2" w:author="x">${r('new')}</w:moveTo>`));
    expect(textOf(paras(res)[0])).toBe('new');
    expect(unsupported(res)).toEqual({ 'w:moveFrom': 1, 'w:moveTo': 1 });
  });

  it('records a simple field while keeping its result', () => {
    const res = body(p(`<w:fldSimple w:instr=" PAGE ">${r('7')}</w:fldSimple>`));
    expect(textOf(paras(res)[0])).toBe('7');
    expect(unsupported(res)).toEqual({ 'w:fldSimple': 1 });
  });

  it('records a block-level insertion and keeps its paragraphs', () => {
    const res = body(`<w:ins w:id="1" w:author="x">${p(r('inserted'))}</w:ins>`);
    expect(paras(res).map(textOf)).toEqual(['inserted']);
    expect(unsupported(res)).toEqual({ 'w:ins': 1 });
  });
});
```

In the same file, two existing expectations change, because what was silent is now recorded. In `'descends content controls, smart tags, custom XML, insertions and simple fields'` replace

```ts
    expect(unsupported(res)).toEqual({});
```

with

```ts
    expect(unsupported(res)).toEqual({ 'w:ins': 1, 'w:fldSimple': 1 });
```

and in `'drops deletions, bookmarks and proofing marks silently'` rename the test to `'drops deletions (recorded), bookmarks and proofing marks'` and replace its `expect(unsupported(res)).toEqual({});` with `expect(unsupported(res)).toEqual({ 'w:del': 1 });`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/wmlbody.test.ts`
Expected: FAIL — the six new cases and the two changed expectations (8 failures).

- [ ] **Step 3: Implement**

In `src/wmlstyles.ts`, add `'sectPr'` to `QUIET_PPR` (a section break is reported by the body walker, once, as a construct):

```ts
const QUIET_PPR = new Set(['pStyle', 'keepNext', 'keepLines', 'widowControl', 'contextualSpacing', 'snapToGrid',
  'autoSpaceDE', 'autoSpaceDN', 'adjustRightInd', 'suppressAutoHyphens', 'rPr', 'sectPr']);
```

In `src/wmlbody.ts`:

1. Below `const TRANSPARENT = …`, add:

```ts
/** Kept to the rules above — `ins`/`moveTo`/`fldSimple` descended, `del`/`moveFrom`
 *  dropped — but RECORDED: the reader shows the final text of a tracked change and
 *  the result of a field, and `m2fp.5` reports that it did (`m2fp.4`). */
const RECORDED = new Set(['ins', 'del', 'moveTo', 'moveFrom', 'fldSimple']);
```

and remove `'del'` and `'moveFrom'` from `DROPPED`, and `'ins'`, `'moveTo'` and `'fldSimple'` from `TRANSPARENT`, so each name lives in one set plus `RECORDED`:

```ts
const DROPPED = new Set([
  'bookmarkStart', 'bookmarkEnd', 'proofErr', 'permStart', 'permEnd',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
  'commentRangeStart', 'commentRangeEnd', 'lastRenderedPageBreak', 'sectPr', 'sdtPr', 'sdtEndPr',
  'rPr', 'pPr', 'tblPr', 'tblGrid', 'trPr', 'tcPr', 'tblPrEx', 'softHyphen', 'instrText', 'delInstrText', 'delText',
]);
const TRANSPARENT = new Set(['smartTag', 'customXml']);
const DESCENDED_RECORDED = new Set(['ins', 'moveTo', 'fldSimple']);
```

2. In `blockChildren`, before the `TRANSPARENT` branch, add:

```ts
      else if (c.ns === W && RECORDED.has(c.local)) {
        this.note(`w:${c.local}`);
        if (DESCENDED_RECORDED.has(c.local)) this.blockChildren(c, out);
      }
```

3. In `inlineChildren`, before the `TRANSPARENT` branch, add:

```ts
      else if (c.ns === W && RECORDED.has(c.local)) {
        this.note(`w:${c.local}`);
        if (DESCENDED_RECORDED.has(c.local)) this.inlineChildren(c, out, pStyle, link);
      }
```

4. In `collectRows` and `collectCells` (inside `table`/`row`), add the same branch with `collectRows(c)` / `collectCells(c)` as the descent, before their `TRANSPARENT` branch.

5. Add to `Walker`:

```ts
  /** A section's header and footer references: never rendered by the flow
   *  engine, so reported rather than silently lost (`m2fp.4`). */
  section(sectPr: NsElement | undefined): void {
    for (const c of sectPr?.children ?? []) {
      if (c.ns === W && (c.local === 'headerReference' || c.local === 'footerReference')) this.note(`w:${c.local}`);
    }
  }
```

6. In `paragraph`, right after `const pPr = wChild(p, 'pPr');`, add:

```ts
    const sect = wChild(pPr, 'sectPr');
    if (sect) { this.note('w:sectPr'); this.section(sect); }
```

7. In `parseBody`, after `walker.finish();`, add `walker.section(wChild(body, 'sectPr'));`.

8. Add to the module doc comment, after the TRANSPARENT invariant:

```ts
 *  **Invariant (`m2fp.4`):** tracked changes and simple fields keep their m2fp.3
 *  treatment — the FINAL text is shown — but are recorded, and so are a section
 *  break inside a paragraph and every header/footer reference: the flow engine
 *  renders none of them, and a report that omits them lies about the document.
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/wmlbody.test.ts test/wmlread.test.ts test/wml-oracle.test.ts test/wmlstyles.test.ts test/limits-catch.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wmlbody.ts src/wmlstyles.ts test/wmlbody.test.ts
git commit -m "feat(m2fp.4): record sections, headers, footers, revisions and simple fields"
```
(End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.)

---

### Task 2: The truth schema and the comparison helper

**Files:**
- Create: `test/helpers/docx-truth.ts`
- Test: `test/docx-truth.test.ts`

**Interfaces:**
- Consumes: `readDocx`, `WmlDocument` (`src/wmlread.ts`); `WmlBlock`, `WmlInline`, `WmlParagraph`, `WmlCell`, `WmlLink` (`src/wmlbody.ts`).
- Produces (Tasks 5–6): `Segment`, `TruthParagraph`, `TruthLink`, `TruthCounts`, `DocxTruth`, `Comparable`; `COUNT_KEYS`; `readTruth(path): DocxTruth`; `assertTruthShape(t: unknown, where: string): asserts t is DocxTruth`; `mergeSegments(segs): Segment[]`; `leafDiff(a, b, path?): string[]`; `comparable(t: DocxTruth): Comparable`; `readerDisagreements(a: DocxTruth, b: DocxTruth): string[]`; `truthOf(doc: WmlDocument, strip?: readonly string[]): Comparable`.

- [ ] **Step 1: Write the failing tests**

Create `test/docx-truth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mergeSegments, leafDiff, comparable, readerDisagreements, truthOf, readTruth, assertTruthShape, type DocxTruth,
} from './helpers/docx-truth.js';
import { readDocx } from '../src/wmlread.js';
import { buildOoxmlPackage } from '../src/ooxml.js';
import { docXml, p, r } from './helpers/wml.js';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const read = (body: string, rels: { id: string; type: string; target: string; external?: boolean }[] = []) =>
  readDocx(buildOoxmlPackage([{ path: 'word/document.xml', bytes: docXml(body), contentType: `${CT}.document.main+xml` }],
    [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' },
      ...rels.map((x) => ({ source: 'word/document.xml', ...x }))]));

const truth = (over: Partial<DocxTruth> = {}): DocxTruth => ({
  reader: 'R', paragraphs: [], tables: [], links: [], images: 0,
  counts: { headers: 0, footers: 0, footnotes: 0, endnotes: 0, textBoxes: 0, fields: 0, comments: 0, revisions: 0 },
  ...over,
});
const seg = (text: string, bold = false) => ({ text, bold, italic: false, sizePt: 10, font: 'F' });

describe('mergeSegments', () => {
  it('merges adjacent equal formatting and drops empty text', () => {
    expect(mergeSegments([seg('a'), seg(''), seg('b'), seg('c', true), seg('d', true), seg('e')]))
      .toEqual([seg('ab'), seg('cd', true), seg('e')]);
  });
});

describe('leafDiff', () => {
  it('reports leaf paths, array lengths, and compares arrays up to the shorter', () => {
    expect(leafDiff({ a: [1, 2, 3], b: { c: 'x' } }, { a: [1, 9], b: { c: 'y', d: 1 } }))
      .toEqual(['a.length', 'a[1]', 'b.c', 'b.d']);
  });

  it('tolerates a float difference under 0.01', () => {
    expect(leafDiff({ s: 10.5 }, { s: 10.504 })).toEqual([]);
    expect(leafDiff({ s: 10.5 }, { s: 10.6 })).toEqual(['s']);
  });
});

describe('comparable and readerDisagreements', () => {
  it('never compares the reader name or a style name, and compares counts', () => {
    const a = truth({ reader: 'Word', paragraphs: [{ text: 'x', styleName: 'Заголовок 1', heading: 1, listLabel: null, inTable: false, segments: [] }] });
    const b = truth({ reader: 'LO', paragraphs: [{ text: 'x', styleName: 'Heading 1', heading: 1, listLabel: null, inTable: false, segments: [] }] });
    expect(readerDisagreements(a, b)).toEqual([]);
    b.counts.footnotes = 1;
    expect(readerDisagreements(a, b)).toEqual(['counts.footnotes']);
    expect(Object.keys(comparable(a))).toEqual(['paragraphs', 'tables', 'links', 'images']);
  });
});

describe('truthOf', () => {
  it('projects paragraphs, headings, labels, segments and table cells', () => {
    const doc = read(p(r('Bold ', '<w:b/>') + r('plain') + '<w:r><w:tab/></w:r>' + r('x'))
      + '<w:tbl><w:tr><w:tc>' + p(r('c1')) + p(r('c1b')) + '</w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' + p(r('c2')) + '</w:tc></w:tr>'
      + '<w:tr><w:tc>' + p(r('d1')) + '</w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr>' + p('') + '</w:tc></w:tr></w:tbl>');
    const t = truthOf(doc);
    expect(t.paragraphs[0]).toEqual({ text: 'Bold plain\tx', heading: null, listLabel: null, inTable: false,
      segments: [{ text: 'Bold ', bold: true, italic: false, sizePt: 10, font: '' }, { text: 'plain\tx', bold: false, italic: false, sizePt: 10, font: '' }] });
    expect(t.paragraphs.map((x) => [x.text, x.inTable])).toEqual([['Bold plain\tx', false], ['c1', true], ['c1b', true], ['c2', true], ['d1', true], ['', true]]);
    expect(t.tables).toEqual([{ rows: [['c1\nc1b', 'c2'], ['d1']] }]);
  });

  it('merges a link\'s runs, reads anchors, counts images, and strips marker text', () => {
    const doc = read(p(`<w:hyperlink r:id="rL">${r('the ')}${r('site', '<w:b/>')}</w:hyperlink>${r(' and ')}`
      + `<w:hyperlink w:anchor="bm">${r('here')}</w:hyperlink>${r(' Boxed words')}`),
    [{ id: 'rL', type: `${REL}/hyperlink`, target: 'https://example.com', external: true }]);
    const t = truthOf(doc, ['Boxed words']);
    expect(t.links).toEqual([{ text: 'the site', url: 'https://example.com' }, { text: 'here', anchor: 'bm' }]);
    expect(t.paragraphs[0].text).toBe('the site and here ');
    expect(t.images).toBe(0);
  });
});

describe('readTruth and assertTruthShape', () => {
  it('reads a file with a BOM and CRLF line ends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'truth-'));
    const f = join(dir, 'x.word.json');
    writeFileSync(f, '﻿' + JSON.stringify(truth(), null, 2).replace(/\n/g, '\r\n'));
    expect(readTruth(f).reader).toBe('R');
  });

  it('refuses a one-element array collapsed to a scalar, naming where', () => {
    const bad = { ...truth(), tables: [{ rows: ['only'] }] } as unknown;
    expect(() => assertTruthShape(bad, 'x.lo.json')).toThrow(/x\.lo\.json.*tables\[0\]\.rows\[0\]/);
    const bad2 = { ...truth(), paragraphs: { text: 'x' } } as unknown;
    expect(() => assertTruthShape(bad2, 'y')).toThrow(/y.*paragraphs/);
  });
});
```

`buildOoxmlPackage`'s relationship takes `external: true` for `TargetMode="External"` (`src/ooxml.ts:27`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docx-truth.test.ts`
Expected: FAIL — cannot resolve `./helpers/docx-truth.js`.

- [ ] **Step 3: Implement `test/helpers/docx-truth.ts`**

```ts
/** m2fp.4's ground truth: the schema the two reader scripts write
 *  (scripts/docx-truth-word.ps1, scripts/docx-truth-lo.py), and the projection
 *  of readDocx's model into the same schema, so all three compare by JSON path.
 *
 *  styleName is recorded and never compared: Word's localized UI names a style
 *  `Заголовок 1`, LibreOffice `Heading 1`, readDocx `heading 1`. */
import { readFileSync } from 'node:fs';
import type { WmlDocument } from '../../src/wmlread.js';
import type { WmlBlock, WmlCell, WmlInline, WmlLink, WmlParagraph } from '../../src/wmlbody.js';

export interface Segment { text: string; bold: boolean; italic: boolean; sizePt: number; font: string }
export interface TruthParagraph {
  text: string; styleName: string; heading: number | null; listLabel: string | null; inTable: boolean; segments: Segment[];
}
export type TruthLink = { text: string; url: string } | { text: string; anchor: string };
export const COUNT_KEYS = ['headers', 'footers', 'footnotes', 'endnotes', 'textBoxes', 'fields', 'comments', 'revisions'] as const;
export type TruthCounts = Record<(typeof COUNT_KEYS)[number], number>;
export interface DocxTruth {
  reader: string;
  paragraphs: TruthParagraph[];
  tables: { rows: string[][] }[];
  links: TruthLink[];
  images: number;
  counts: TruthCounts;
}
export interface Comparable {
  paragraphs: Omit<TruthParagraph, 'styleName'>[];
  tables: { rows: string[][] }[];
  links: TruthLink[];
  images: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws naming the file and the path of the first field of the wrong shape —
 *  chiefly a one-element array PowerShell's ConvertTo-Json collapsed to a scalar. */
export function assertTruthShape(t: unknown, where: string): asserts t is DocxTruth {
  const fail = (path: string): never => { throw new Error(`${where}: ${path} has the wrong shape`); };
  if (!isObj(t)) fail('(root)');
  const o = t as Record<string, unknown>;
  if (typeof o.reader !== 'string') fail('reader');
  if (!Array.isArray(o.paragraphs)) fail('paragraphs');
  (o.paragraphs as unknown[]).forEach((p, i) => {
    if (!isObj(p) || typeof p.text !== 'string') fail(`paragraphs[${i}]`);
    const q = p as Record<string, unknown>;
    if (!Array.isArray(q.segments)) fail(`paragraphs[${i}].segments`);
    (q.segments as unknown[]).forEach((s, j) => { if (!isObj(s) || typeof s.text !== 'string') fail(`paragraphs[${i}].segments[${j}]`); });
  });
  if (!Array.isArray(o.tables)) fail('tables');
  (o.tables as unknown[]).forEach((t2, i) => {
    if (!isObj(t2) || !Array.isArray(t2.rows)) fail(`tables[${i}].rows`);
    ((t2 as { rows: unknown[] }).rows).forEach((row, j) => { if (!Array.isArray(row)) fail(`tables[${i}].rows[${j}]`); });
  });
  if (!Array.isArray(o.links)) fail('links');
  if (typeof o.images !== 'number') fail('images');
  if (!isObj(o.counts)) fail('counts');
  for (const k of COUNT_KEYS) if (typeof (o.counts as Record<string, unknown>)[k] !== 'number') fail(`counts.${k}`);
}

export function readTruth(path: string): DocxTruth {
  const t: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  assertTruthShape(t, path);
  return t;
}

const fmtKey = (s: Segment): string => JSON.stringify([s.bold, s.italic, s.sizePt, s.font]);
export function mergeSegments(segs: readonly Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.text === '') continue;
    const last = out[out.length - 1];
    if (last && fmtKey(last) === fmtKey(s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/** Leaf paths where `a` and `b` differ. Arrays of different length report
 *  `<path>.length` and are compared element by element up to the shorter. */
export function leafDiff(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) leafDiff(a[i], b[i], `${path}[${i}]`, out);
  } else if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) leafDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (!Object.is(a, b) && !(typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.01)) {
    out.push(path);
  }
  return out;
}

export function comparable(t: DocxTruth): Comparable {
  return {
    paragraphs: t.paragraphs.map(({ styleName: _ignored, ...rest }) => rest),
    tables: t.tables, links: t.links, images: t.images,
  };
}

export function readerDisagreements(a: DocxTruth, b: DocxTruth): string[] {
  return [...leafDiff(comparable(a), comparable(b)), ...leafDiff(a.counts, b.counts, 'counts')];
}

// ---- readDocx's model in the truth schema ----

const strip = (s: string, list: readonly string[]): string => list.reduce((acc, x) => acc.split(x).join(''), s);

function inlineText(i: WmlInline): string {
  switch (i.kind) {
    case 'text': return i.text;
    case 'tab': return '\t';
    case 'break': return i.type === 'line' ? '\n' : '';
    default: return '';
  }
}

function flatten(blocks: readonly WmlBlock[], inTable: boolean, out: { p: WmlParagraph; inTable: boolean }[]): void {
  for (const b of blocks) {
    if (b.kind === 'paragraph') out.push({ p: b, inTable });
    else for (const row of b.rows) for (const cell of row.cells) flatten(cell.blocks, true, out);
  }
}

function segmentsOf(p: WmlParagraph, list: readonly string[]): Segment[] {
  const segs: Segment[] = [];
  let pending = '';
  for (const i of p.inlines) {
    if (i.kind === 'text') {
      segs.push({ text: pending + i.text, bold: i.props.bold, italic: i.props.italic, sizePt: i.props.sizePt, font: i.props.font ?? '' });
      pending = '';
    } else {
      const t = inlineText(i);
      if (t === '') continue;
      if (segs.length > 0) segs[segs.length - 1].text += t; else pending += t;
    }
  }
  return mergeSegments(segs.map((s) => ({ ...s, text: strip(s.text, list) })));
}

const paraText = (p: WmlParagraph, list: readonly string[]): string => strip(p.inlines.map(inlineText).join(''), list);

function cellText(cell: WmlCell, list: readonly string[]): string {
  const ps: { p: WmlParagraph; inTable: boolean }[] = [];
  flatten(cell.blocks, true, ps);
  return ps.map((x) => paraText(x.p, list)).join('\n');
}

/** `strip` removes text a reader attributes to another story (the text-box
 *  recipe's words, which readDocx keeps inline by m2fp.3's rule). */
export function truthOf(doc: WmlDocument, list: readonly string[] = []): Comparable {
  const flat: { p: WmlParagraph; inTable: boolean }[] = [];
  flatten(doc.blocks, false, flat);
  const links: TruthLink[] = [];
  let images = 0;
  for (const { p } of flat) {
    let open: { link: WmlLink; entry: TruthLink } | undefined;
    for (const i of p.inlines) {
      if (i.kind === 'image') images++;
      if (i.kind === 'text' && i.link) {
        if (open && JSON.stringify(open.link) === JSON.stringify(i.link)) { open.entry.text += i.text; continue; }
        const entry: TruthLink = 'url' in i.link ? { text: i.text, url: i.link.url } : { text: i.text, anchor: i.link.anchor };
        links.push(entry);
        open = { link: i.link, entry };
      } else open = undefined;
    }
  }
  return {
    paragraphs: flat.map(({ p, inTable }) => ({
      text: paraText(p, list), heading: p.heading ?? null, listLabel: p.list?.label ?? null, inTable,
      segments: segmentsOf(p, list),
    })),
    tables: doc.blocks.filter((b) => b.kind === 'table').map((t) => ({
      rows: t.rows.map((row) => row.cells.filter((c) => c.vMerge !== 'continue').map((c) => cellText(c, list))),
    })),
    links, images,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/docx-truth.test.ts && npm run typecheck`
Expected: PASS. If `truthOf`'s first-paragraph case fails only on `font` (a document with no `w:rFonts` anywhere resolves no font), the `''` default is intended.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/docx-truth.ts test/docx-truth.test.ts
git commit -m "test(m2fp.4): the DOCX truth schema and its comparison helper"
```

---

### Task 3: The Word half — builder and reader

**Files:**
- Create: `scripts/gen-docx-corpus-word.ps1`, `scripts/docx-truth-word.ps1`
- Create (generated): `test/fixtures/docx/word2010-{styles,lists,tables,media,skipped}.docx`, `word2010-*.word.json` (six, `basic` included)

**Interfaces:**
- Produces: the `DocxTruth` JSON (Task 2's `assertTruthShape` accepts it); `scripts/docx-truth-word.ps1 -Docx <path[]>` writes `<name>.word.json` beside each file.

- [ ] **Step 1: Write the builder**

Create `scripts/gen-docx-corpus-word.ps1`:

```powershell
# m2fp.4: builds the five Word-written corpus documents through Microsoft Word
# COM. NOT run by npm test (needs Word; Word stamps docProps/core.xml, so a rerun
# is never byte-identical — the VENDORED files are the reference). The recipes
# mirror scripts/gen-docx-corpus-lo.py text for text; keep the two in step.
# Styles are addressed by WdBuiltinStyle number: this Word is localized (1049).
param([string]$OutDir = (Join-Path $PSScriptRoot '..\test\fixtures\docx'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$OutDir = [IO.Path]::GetFullPath($OutDir)

$png = Join-Path $env:TEMP 'gen-docx-corpus-pic.png'
$bmp = New-Object System.Drawing.Bitmap 16, 16
for ($x = 0; $x -lt 16; $x++) { for ($y = 0; $y -lt 16; $y++) {
  $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $x * 16, $y * 16, 128)) } }
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()

$w = New-Object -ComObject Word.Application
$w.Visible = $false; $w.DisplayAlerts = 0
"Word $($w.Version) build $($w.Build)"

function New-Doc { $script:d = $w.Documents.Add(); $script:sel = $w.Selection }
function S([object]$id) { $d.Styles.Item($id) }
# Collapse the selection to the end of the main story (before its final mark),
# which is safe after inserting a table, a footnote or a shape.
function Endpos { $e = $d.Content.End - 1; $sel.SetRange($e, $e) }
function Save-Doc([string]$topic) {
  $out = Join-Path $OutDir "word2010-$topic.docx"
  if (Test-Path $out) { Remove-Item $out }
  $d.SaveAs2([ref]$out, [ref]16); $d.Close([ref]0); "wrote $out"
}
# A paragraph in $style, typed PLAIN, then each run's formatting applied to its
# own range — so no formatting leaks through the insertion point.
# A run is a string or a hashtable: t, bold, italic, size, font, color ('red'), cstyle.
function P([object]$style, [object[]]$runs) {
  $sel.Range.ListFormat.RemoveNumbers()
  $sel.Style = $style
  $spans = @()
  foreach ($r in $runs) {
    if ($r -is [string]) { $r = @{ t = $r } }
    $s = $sel.Start; $sel.TypeText($r.t); $spans += ,@($s, $sel.Start, $r)
  }
  foreach ($sp in $spans) {
    $rg = $d.Range($sp[0], $sp[1]); $f = $sp[2]
    if ($f.cstyle) { $rg.Style = (S $f.cstyle) }
    if ($f.bold) { $rg.Font.Bold = 1 }
    if ($f.italic) { $rg.Font.Italic = 1 }
    if ($f.size) { $rg.Font.Size = $f.size }
    if ($f.font) { $rg.Font.Name = $f.font }
    if ($f.color -eq 'red') { $rg.Font.Color = 255 }   # wdColorRed
  }
  $sel.TypeParagraph()
}
# A list item: $tmpl applied at level $level, continuing the previous list or not.
function L([string]$t, [object]$tmpl, [int]$level, [bool]$cont) {
  $sel.Style = (S -1)
  $sel.Range.ListFormat.ApplyListTemplate($tmpl, $cont, 0)
  $sel.Range.ListFormat.ListLevelNumber = $level
  $sel.TypeText($t); $sel.TypeParagraph()
}

try {
  # ---- styles ----
  New-Doc
  $ch = $d.Styles.Add('Custom Heading', 1); $ch.BaseStyle = (S -3).NameLocal
  $sc = $d.Styles.Add('Strong Custom', 2); $sc.Font.Bold = 1
  $bp = $d.Styles.Add('Bold Para', 1); $bp.BaseStyle = (S -1).NameLocal; $bp.Font.Bold = 1
  P (S -2) @('Styles and headings')
  P (S -3) @('Second level')
  P (S -4) @('Third level')
  P (S 'Custom Heading') @('Custom heading text')
  P (S -1) @('Plain body text.')
  P (S -1) @(@{ t = 'Direct '; bold = 1 }, @{ t = 'formats '; italic = 1 }, @{ t = 'sizes '; size = 16 },
    @{ t = 'fonts '; font = 'Courier New' }, @{ t = 'colours '; color = 'red' }, 'end.')
  P (S -1) @('A ', @{ t = 'strong '; cstyle = 'Strong Custom' }, 'word.')
  P (S 'Bold Para') @(@{ t = 'toggle '; cstyle = 'Strong Custom' }, 'rest.')
  Save-Doc 'styles'

  # ---- lists ----
  New-Doc
  $bt = $w.ListGalleries.Item(1).ListTemplates.Item(1)     # wdBulletGallery
  $nt = $d.ListTemplates.Add($true)
  $spec = @(@('%1.', 0), @('%2.', 4), @('%3.', 2))           # Arabic, lowercase letter, lowercase roman
  for ($i = 0; $i -lt 3; $i++) {
    $lv = $nt.ListLevels.Item($i + 1)
    $lv.NumberFormat = $spec[$i][0]; $lv.NumberStyle = $spec[$i][1]; $lv.StartAt = 1
    $lv.NumberPosition = 18 * $i; $lv.TextPosition = 18 * ($i + 1)
  }
  P (S -1) @('Bullets:')
  L 'Fruit' $bt 1 $false; L 'Apple' $bt 2 $true; L 'Green apple' $bt 3 $true; L 'Vegetables' $bt 1 $true
  P (S -1) @('Numbers:')
  L 'First' $nt 1 $false; L 'Sub a' $nt 2 $true; L 'Sub sub i' $nt 3 $true; L 'Second' $nt 1 $true
  P (S -1) @('An interruption.')
  L 'Third' $nt 1 $true
  P (S -1) @('A new list:')
  L 'Restart one' $nt 1 $false; L 'Restart two' $nt 1 $true
  P (S -1) @('End of lists.')
  Save-Doc 'lists'

  # ---- tables ----
  New-Doc
  P (S -1) @('Table:')
  $t = $d.Tables.Add($sel.Range, 4, 3); $t.Borders.Enable = $true
  $vals = @(@('Name', 'Qty', 'Note'), @('Wide cell', '', 'Shaded'), @('Tall', '', 'c3'), @('', 'b4', 'c4'))
  for ($r = 1; $r -le 4; $r++) { for ($c = 1; $c -le 3; $c++) { $t.Cell($r, $c).Range.Text = $vals[$r - 1][$c - 1] } }
  $t.Rows.Item(1).HeadingFormat = -1
  $t.Cell(2, 3).Shading.BackgroundPatternColor = 65535        # wdColorYellow
  $inner = $d.Tables.Add($t.Cell(3, 2).Range, 2, 1)
  $inner.Cell(1, 1).Range.Text = 'in1'; $inner.Cell(2, 1).Range.Text = 'in2'
  $t.Cell(3, 1).Merge($t.Cell(4, 1))
  $t.Cell(2, 1).Merge($t.Cell(2, 2))
  Endpos
  P (S -1) @('After the table.')
  Save-Doc 'tables'

  # ---- media ----
  New-Doc
  $sel.Style = (S -1); $sel.TypeText('Picture: '); $sel.InlineShapes.AddPicture($png) | Out-Null; Endpos; $sel.TypeParagraph()
  $sel.TypeText('A link to ')
  $d.Hyperlinks.Add($sel.Range, 'https://example.com/docs', [Type]::Missing, [Type]::Missing, 'the example site') | Out-Null
  Endpos; $sel.TypeText('.'); $sel.TypeParagraph()
  $s = $sel.Start; $sel.TypeText('Target paragraph'); $d.Bookmarks.Add('target', $d.Range($s, $sel.Start)) | Out-Null; $sel.TypeParagraph()
  $sel.TypeText('Jump to ')
  $d.Hyperlinks.Add($sel.Range, '', 'target', [Type]::Missing, 'the target') | Out-Null
  Endpos; $sel.TypeText('.'); $sel.TypeParagraph()
  Save-Doc 'media'

  # ---- skipped ----
  New-Doc
  $d.Sections.Item(1).Headers.Item(1).Range.Text = 'Running header'
  $d.Sections.Item(1).Footers.Item(1).Range.Text = 'Running footer'
  P (S -1) @('Contents:')
  $toc = $d.TablesOfContents.Add($sel.Range, $true, 1, 3); Endpos
  P (S -2) @('Chapter one')
  $sel.TypeText('Body with a footnote'); $d.Footnotes.Add($sel.Range).Range.Text = 'The footnote text.'; Endpos; $sel.TypeParagraph()
  $sel.TypeText('Body with an endnote'); $d.Endnotes.Add($sel.Range).Range.Text = 'The endnote text.'; Endpos; $sel.TypeParagraph()
  P (S -1) @('Anchor for a text box.')
  $anchor = $d.Paragraphs.Item($d.Paragraphs.Count - 1).Range
  $box = $d.Shapes.AddTextbox(1, 72, 72, 150, 30, $anchor); $box.TextFrame.TextRange.Text = 'Boxed words'; Endpos
  $s = $sel.Start; $sel.TypeText('Commented words'); $d.Comments.Add($d.Range($s, $sel.Start), 'A comment.') | Out-Null; Endpos; $sel.TypeParagraph()
  $base = $sel.Start; $sel.TypeText('Kept deleted words.')
  $d.TrackRevisions = $true
  $d.Range($base + 5, $base + 5).InsertAfter('inserted ')        # "Kept inserted deleted words."
  $d.Range($base + 14, $base + 22).Delete() | Out-Null            # deletes "deleted "
  $d.TrackRevisions = $false
  Endpos; $sel.TypeParagraph()
  $sel.InsertBreak(2)                                              # wdSectionBreakNextPage
  $d.Sections.Item(2).PageSetup.Orientation = 1                    # wdOrientLandscape
  P (S -2) @('Chapter two')
  P (S -1) @('Landscape page.')
  $toc.Update()
  Save-Doc 'skipped'
} finally {
  $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null
  Remove-Item $png -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Write the reader**

Create `scripts/docx-truth-word.ps1`:

```powershell
# m2fp.4: Microsoft Word's reading of any .docx, as the DocxTruth JSON of
# test/helpers/docx-truth.ts, written beside it as <name>.word.json. Word opens
# each file read-only; tracked changes are COUNTED and then accepted (in memory
# only) so the paragraphs are the final text, as readDocx shows it. NOT run by
# npm test.
param([Parameter(Mandatory = $true)][string[]]$Docx)
$ErrorActionPreference = 'Stop'

# Field marks, anchors of notes and comments, page breaks and cell marks are not
# text; a manual line break (\v) is a newline.
function Clean([string]$s) {
  if ($null -eq $s) { return '' }
  $s = $s -replace "`v", "`n"
  return ($s -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', '')
}
$UNDEF = 9999999
function SegmentOf($rg) {
  [ordered]@{ text = ''; bold = ($rg.Font.Bold -eq -1); italic = ($rg.Font.Italic -eq -1)
    sizePt = [double]$rg.Font.Size; font = [string]$rg.Font.Name }
}
function Add-Seg([System.Collections.ArrayList]$segs, $seg, [string]$t) {
  if ($t -eq '') { return }
  $last = if ($segs.Count) { $segs[$segs.Count - 1] } else { $null }
  if ($last -and $last.bold -eq $seg.bold -and $last.italic -eq $seg.italic -and $last.sizePt -eq $seg.sizePt -and $last.font -eq $seg.font) {
    $last.text += $t
  } else { $seg.text = $t; [void]$segs.Add($seg) }
}

$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $false; $w.DisplayAlerts = 0
  $reader = "Word $($w.Build)"
  foreach ($path in $Docx) {
    $path = [IO.Path]::GetFullPath($path)
    $d = $w.Documents.Open($path, $false, $true)

    $hdr = 0; $ftr = 0
    for ($si = 1; $si -le $d.Sections.Count; $si++) {
      $sec = $d.Sections.Item($si)
      foreach ($k in 1, 2, 3) {
        $h = $sec.Headers.Item($k); $f = $sec.Footers.Item($k)
        if ($h.Exists -and -not ($si -gt 1 -and $h.LinkToPrevious) -and (Clean ($h.Range.Text -replace "`r", '')).Trim() -ne '') { $hdr++ }
        if ($f.Exists -and -not ($si -gt 1 -and $f.LinkToPrevious) -and (Clean ($f.Range.Text -replace "`r", '')).Trim() -ne '') { $ftr++ }
      }
    }
    $tb = 0
    for ($i = 1; $i -le $d.Shapes.Count; $i++) { try { if ($d.Shapes.Item($i).TextFrame.HasText) { $tb++ } } catch { } }
    $fields = 0
    for ($i = 1; $i -le $d.Fields.Count; $i++) { if ($d.Fields.Item($i).Type -ne 88) { $fields++ } }   # not wdFieldHyperlink
    $counts = [ordered]@{ headers = $hdr; footers = $ftr; footnotes = $d.Footnotes.Count; endnotes = $d.Endnotes.Count
      textBoxes = $tb; fields = $fields; comments = $d.Comments.Count; revisions = $d.Revisions.Count }
    if ($d.Revisions.Count -gt 0) { $d.Revisions.AcceptAll() }

    $paras = @()
    for ($pi = 1; $pi -le $d.Paragraphs.Count; $pi++) {
      $p = $d.Paragraphs.Item($pi)
      $segs = New-Object System.Collections.ArrayList
      $ws = $p.Range.Words
      for ($wi = 1; $wi -le $ws.Count; $wi++) {
        $wd = $ws.Item($wi)
        if ($null -eq $wd -or $null -eq $wd.Text) { continue }
        $t = Clean ($wd.Text -replace "`r", '')
        if ($t -eq '') { continue }
        if ($wd.Font.Bold -eq $UNDEF -or $wd.Font.Italic -eq $UNDEF -or $wd.Font.Size -eq $UNDEF -or $wd.Font.Name -eq '') {
          $chs = $wd.Characters
          for ($ci = 1; $ci -le $chs.Count; $ci++) {
            $c = $chs.Item($ci); Add-Seg $segs (SegmentOf $c) (Clean ($c.Text -replace "`r", ''))
          }
        } else { Add-Seg $segs (SegmentOf $wd) $t }
      }
      $lvl = [int]$p.OutlineLevel
      $label = $null
      if ($p.Range.ListFormat.ListType -ne 0) { $label = [string]$p.Range.ListFormat.ListString }
      $paras += [ordered]@{
        text = Clean ($p.Range.Text -replace "`r", '')
        styleName = [string]$p.Style.NameLocal
        heading = $(if ($lvl -ge 1 -and $lvl -le 9) { $lvl } else { $null })
        listLabel = $label
        inTable = [bool]$p.Range.Information(12)                  # wdWithInTable
        segments = @($segs.ToArray())
      }
    }

    $tables = @()
    for ($ti = 1; $ti -le $d.Tables.Count; $ti++) {
      $tbl = $d.Tables.Item($ti)
      $byRow = @{}
      $cells = $tbl.Range.Cells
      for ($ci = 1; $ci -le $cells.Count; $ci++) {
        $c = $cells.Item($ci)
        if ($c.NestingLevel -ne 1) { continue }
        $txt = (Clean ($c.Range.Text -replace "`r", "`n")).TrimEnd("`n")
        if (-not $byRow.ContainsKey($c.RowIndex)) { $byRow[$c.RowIndex] = New-Object System.Collections.ArrayList }
        [void]$byRow[$c.RowIndex].Add($txt)
      }
      $rows = @()
      foreach ($k in ($byRow.Keys | Sort-Object)) { $rows += , @($byRow[$k].ToArray()) }
      $tables += [ordered]@{ rows = $rows }
    }

    $links = @()
    for ($i = 1; $i -le $d.Hyperlinks.Count; $i++) {
      $h = $d.Hyperlinks.Item($i)
      $text = Clean $h.TextToDisplay
      if ([string]$h.Address -ne '') { $links += [ordered]@{ text = $text; url = [string]$h.Address } }
      else { $links += [ordered]@{ text = $text; anchor = [string]$h.SubAddress } }
    }
    $images = 0
    for ($i = 1; $i -le $d.InlineShapes.Count; $i++) { if ($d.InlineShapes.Item($i).Type -eq 3) { $images++ } }   # wdInlineShapePicture

    $d.Close([ref]0)
    $out = [ordered]@{ reader = $reader; paragraphs = $paras; tables = $tables; links = $links; images = $images; counts = $counts }
    $json = [IO.Path]::ChangeExtension($path, $null).TrimEnd('.') + '.word.json'
    [IO.File]::WriteAllText($json, (ConvertTo-Json -InputObject $out -Depth 10), (New-Object Text.UTF8Encoding($false)))
    "wrote $json"
  }
} finally { $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
```

- [ ] **Step 3: Build and read**

Run (PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-docx-corpus-word.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/docx-truth-word.ps1 -Docx (Get-ChildItem test/fixtures/docx/word2010-*.docx).FullName
```

Expected: `wrote …` for five documents, then six truth files. If Word raises a COM error on a recipe line, fix that line (Word 2010's object model is the reference), rerun, and ledger `Task 3: Ruling: <line> — <why>`.

- [ ] **Step 4: Check every truth file's shape and each recipe's intent**

Run: `npx tsx -e "import('./test/helpers/docx-truth.ts').then(m=>{for(const f of require('fs').readdirSync('test/fixtures/docx').filter(f=>f.endsWith('.word.json'))){const t=m.readTruth('test/fixtures/docx/'+f);console.log(f,t.paragraphs.length,'paras',t.tables.length,'tables',t.links.length,'links',t.images,'img',JSON.stringify(t.counts));for(const p of t.paragraphs)console.log('  ',JSON.stringify(p.text),p.heading,p.listLabel,p.inTable,p.segments.map(s=>(s.bold?'B':'')+(s.italic?'I':'')+s.sizePt).join(','))}})"`

Expected, per recipe — Word's reading must show each intent, or the builder is wrong:
- `styles`: headings 1, 2, 3 on the first three; the `Direct …` paragraph has five differently formatted segments then `end.`; `strong ` bold in its paragraph; `toggle ` NOT bold (the XOR, as the m2fp.3 oracle found) and `rest.` bold.
- `lists`: bullets on Fruit/Apple/Green apple/Vegetables; `1.`, `a.`, `i.`, `2.`; `3.` on Third after the interruption; `1.`, `2.` on the restarted list.
- `tables`: one top-level table of 4 rows; `Wide cell` alone in row 2 with `Shaded`; the nested `in1`/`in2` inside the table's text.
- `media`: `images` 1; links `[{text:'the example site',url:'https://example.com/docs'},{text:'the target',anchor:'target'}]`.
- `skipped`: `headers` ≥ 1, `footers` ≥ 1, `footnotes` 1, `endnotes` 1, `textBoxes` 1, `fields` ≥ 1, `comments` 1, `revisions` 2; a paragraph `Kept inserted words.`.

A recipe whose intent did not happen (for example, no `3.` after the interruption) is a builder bug: fix the recipe and rerun Steps 3–4. The READER is not wrong unless its output contradicts what Word shows on screen for that file — then fix the reader and ledger it.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-docx-corpus-word.ps1 scripts/docx-truth-word.ps1 test/fixtures/docx/word2010-*.docx test/fixtures/docx/word2010-*.word.json
git commit -m "test(m2fp.4): Word-written corpus documents and Word's reading of them"
```

---

### Task 4: The LibreOffice half — obtain, build, read, drive

**Files:**
- Create: `scripts/lo_common.py`, `scripts/gen-docx-corpus-lo.py`, `scripts/docx-truth-lo.py`, `scripts/gen-docx-corpus.ps1`
- Create (generated): `test/fixtures/docx/lo<v>-*.docx`, every `*.lo.json`, `word`-read truth of the LibreOffice files

**Interfaces:**
- Consumes: Task 3's reader script (the driver runs it over the LibreOffice files).
- Produces: `scripts/gen-docx-corpus.ps1 -LoProgram <dir> [-SkipBuild]`.

- [ ] **Step 1: Obtain LibreOffice**

Run (bash):

```bash
curl -sL https://download.documentfoundation.org/libreoffice/stable/ | grep -o 'href="[0-9][0-9.]*/"' | sed 's/href="//;s/\/"//' | sort -V | tail -3
```

Take the highest version `V` listed. Then (PowerShell):

```powershell
$V = '<the version>'
$root = Join-Path $env:LOCALAPPDATA 'pdf4ts-tools'; New-Item -ItemType Directory -Force $root | Out-Null
$msi = Join-Path $root "LibreOffice_${V}_Win_x86-64.msi"
Invoke-WebRequest "https://download.documentfoundation.org/libreoffice/stable/$V/win/x86_64/LibreOffice_${V}_Win_x86-64.msi" -OutFile $msi
(Get-FileHash $msi -Algorithm SHA256).Hash
$dir = Join-Path $root "libreoffice-$V"
Start-Process msiexec -ArgumentList '/a', "`"$msi`"", '/qn', "TARGETDIR=`"$dir`"" -Wait
$prog = (Get-ChildItem $dir -Recurse -Filter soffice.exe | Select-Object -First 1).DirectoryName; $prog
& "$prog\soffice.exe" --version
& "$prog\python.exe" -c "import uno; print('uno ok')"
```

Expected: a version line and `uno ok`. Ledger `Task 4: LibreOffice <full version>, MSI SHA-256 <hash>, program dir <prog>`.

**If any of this fails** (download blocked, `/a` refused, `python.exe` absent), take the spec's FALLBACK: ledger `Task 4: Ruling: fallback — Word half only — <reason>`, file `bd create --type task --parent aspose-pdf-foss-for-ts-m2fp "DOCX corpus: the LibreOffice half"` with the reason, skip to Task 5 (which works with one reader per file), and skip Steps 2–6 here.

- [ ] **Step 2: Write the shared UNO helper**

Create `scripts/lo_common.py`:

```python
# m2fp.4: start a private headless LibreOffice and connect to it over UNO.
# Run with LibreOffice's OWN python.exe, which carries the uno module; the
# soffice.exe beside it is the office started.
import os, sys, time, shutil, tempfile, subprocess
import uno
from com.sun.star.beans import PropertyValue

PROGRAM = os.path.dirname(sys.executable)
SOFFICE = os.path.join(PROGRAM, 'soffice.exe')
PORT = 2083


def prop(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


class Office:
    """A headless office with a throwaway profile, so no user setting leaks in."""

    def __enter__(self):
        self.profile = tempfile.mkdtemp(prefix='lo-profile-')
        self.proc = subprocess.Popen([
            SOFFICE, '--headless', '--invisible', '--norestore', '--nologo', '--nodefault', '--nolockcheck',
            '-env:UserInstallation=' + uno.systemPathToFileUrl(self.profile),
            '--accept=socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % PORT])
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
        for _ in range(240):
            try:
                self.ctx = resolver.resolve('uno:socket,host=127.0.0.1,port=%d;urp;StarOffice.ComponentContext' % PORT)
                break
            except Exception:
                time.sleep(0.5)
        else:
            self.proc.kill()
            raise RuntimeError('LibreOffice did not start')
        self.smgr = self.ctx.ServiceManager
        self.desktop = self.smgr.createInstanceWithContext('com.sun.star.frame.Desktop', self.ctx)
        return self

    def __exit__(self, *exc):
        try:
            self.desktop.terminate()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=60)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)

    def version(self):
        cp = self.smgr.createInstanceWithContext('com.sun.star.configuration.ConfigurationProvider', self.ctx)
        node = cp.createInstanceWithArguments('com.sun.star.configuration.ConfigurationAccess',
                                              (prop('nodepath', '/org.openoffice.Setup/Product'),))
        return node.getByName('ooSetupVersionAboutBox')
```

- [ ] **Step 3: Write the builder**

Create `scripts/gen-docx-corpus-lo.py`:

```python
# m2fp.4: builds the five LibreOffice-written corpus documents through UNO.
# Usage: <LibreOffice program>\python.exe scripts\gen-docx-corpus-lo.py <outdir>
# NOT run by npm test. The recipes mirror scripts/gen-docx-corpus-word.ps1 text
# for text; keep the two in step.
import os, sys, struct, zlib, tempfile
import uno
from lo_common import Office, prop
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
from com.sun.star.awt.FontWeight import BOLD
from com.sun.star.awt.FontSlant import ITALIC
from com.sun.star.text.TextContentAnchorType import AS_CHARACTER, AT_PARAGRAPH
from com.sun.star.style.NumberingType import ARABIC, CHARS_LOWER_LETTER, ROMAN_LOWER

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'docx'))
MANAGED = ('CharWeight', 'CharPosture', 'CharHeight', 'CharFontName', 'CharColor', 'CharStyleName', 'HyperLinkURL')
PARA_RESET = ('PageDescName', 'ParaIsNumberingRestart', 'NumberingStartValue')


def png16(path):
    raw = b''.join(b'\x00' + bytes(v for x in range(16) for v in (x * 16, y * 16, 128)) for y in range(16))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 16, 16, 8, 2, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def size(w, h):
    s = uno.createUnoStruct('com.sun.star.awt.Size')
    s.Width, s.Height = w, h
    return s


class Writer:
    def __init__(self, office):
        self.o = office
        self.doc = office.desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, (prop('Hidden', True),))
        self.text = self.doc.Text
        self.cur = self.text.createTextCursor()
        self.first = True

    def _break(self):
        if not self.first:
            self.text.insertControlCharacter(self.cur, PARAGRAPH_BREAK, False)
        self.first = False
        for n in PARA_RESET:
            try:
                self.cur.setPropertyToDefault(n)
            except Exception:
                pass

    def para(self, style, runs, numbering='', level=0, restart=False, page=None):
        """A paragraph: style, runs (str or (text, {props})), optional list style and level."""
        self._break()
        self.cur.ParaStyleName = style
        self.cur.NumberingStyleName = numbering
        if numbering:
            self.cur.NumberingLevel = level
            if restart:
                self.cur.ParaIsNumberingRestart = True
        if page:
            self.cur.PageDescName = page
        for r in runs:
            if isinstance(r, str):
                self.run(r)
            else:
                self.run(r[0], **r[1])

    def run(self, text, **props):
        self.cur.setPropertiesToDefault(MANAGED)
        self.text.insertString(self.cur, text, False)
        if props:
            self.cur.goLeft(len(text), True)
            for k, v in props.items():
                self.cur.setPropertyValue(k, v)
            self.cur.collapseToEnd()

    def block(self, content):
        """A table or an index, in a paragraph of its own; the next para() reuses the one after it."""
        self._break()
        self.text.insertTextContent(self.cur, content, False)
        self.first = True

    def save(self, name):
        path = os.path.join(OUT, name)
        if os.path.exists(path):
            os.remove(path)
        self.doc.storeToURL(uno.systemPathToFileUrl(path), (prop('FilterName', 'MS Word 2007 XML'), prop('Overwrite', True)))
        self.doc.close(True)
        print('wrote ' + path)


def styles_doc(o, tag):
    w = Writer(o)
    fams = w.doc.StyleFamilies
    pst, cst = fams.getByName('ParagraphStyles'), fams.getByName('CharacterStyles')
    ch = w.doc.createInstance('com.sun.star.style.ParagraphStyle'); pst.insertByName('Custom Heading', ch); ch.ParentStyle = 'Heading 2'
    sc = w.doc.createInstance('com.sun.star.style.CharacterStyle'); cst.insertByName('Strong Custom', sc); sc.CharWeight = BOLD
    bp = w.doc.createInstance('com.sun.star.style.ParagraphStyle'); pst.insertByName('Bold Para', bp); bp.ParentStyle = 'Standard'; bp.CharWeight = BOLD
    w.para('Heading 1', ['Styles and headings'])
    w.para('Heading 2', ['Second level'])
    w.para('Heading 3', ['Third level'])
    w.para('Custom Heading', ['Custom heading text'])
    w.para('Standard', ['Plain body text.'])
    w.para('Standard', [('Direct ', {'CharWeight': BOLD}), ('formats ', {'CharPosture': ITALIC}), ('sizes ', {'CharHeight': 16.0}),
                        ('fonts ', {'CharFontName': 'Courier New'}), ('colours ', {'CharColor': 0xFF0000}), 'end.'])
    w.para('Standard', ['A ', ('strong ', {'CharStyleName': 'Strong Custom'}), 'word.'])
    w.para('Bold Para', [('toggle ', {'CharStyleName': 'Strong Custom'}), 'rest.'])
    w.save('lo%s-styles.docx' % tag)


def lists_doc(o, tag):
    w = Writer(o)
    nst = w.doc.StyleFamilies.getByName('NumberingStyles')
    ml = w.doc.createInstance('com.sun.star.style.NumberingStyle'); nst.insertByName('Corpus Multilevel', ml)
    rules = ml.NumberingRules
    for lvl, ntype in enumerate((ARABIC, CHARS_LOWER_LETTER, ROMAN_LOWER)):
        pvs = list(rules.getByIndex(lvl))
        for pv in pvs:
            if pv.Name == 'NumberingType': pv.Value = ntype
            elif pv.Name == 'Suffix': pv.Value = '.'
            elif pv.Name == 'Prefix': pv.Value = ''
            elif pv.Name == 'ParentNumbering': pv.Value = 1
            elif pv.Name == 'ListFormat': pv.Value = '%%%d%%.' % (lvl + 1)
        uno.invoke(rules, 'replaceByIndex', (lvl, uno.Any('[]com.sun.star.beans.PropertyValue', tuple(pvs))))
    ml.NumberingRules = rules
    w.para('Standard', ['Bullets:'])
    for text, lvl in (('Fruit', 0), ('Apple', 1), ('Green apple', 2), ('Vegetables', 0)):
        w.para('Standard', [text], numbering='List 1', level=lvl)
    w.para('Standard', ['Numbers:'])
    for text, lvl in (('First', 0), ('Sub a', 1), ('Sub sub i', 2), ('Second', 0)):
        w.para('Standard', [text], numbering='Corpus Multilevel', level=lvl)
    w.para('Standard', ['An interruption.'])
    w.para('Standard', ['Third'], numbering='Corpus Multilevel')
    w.para('Standard', ['A new list:'])
    w.para('Standard', ['Restart one'], numbering='Corpus Multilevel', restart=True)
    w.para('Standard', ['Restart two'], numbering='Corpus Multilevel')
    w.para('Standard', ['End of lists.'])
    w.save('lo%s-lists.docx' % tag)


def tables_doc(o, tag):
    w = Writer(o)
    w.para('Standard', ['Table:'])
    t = w.doc.createInstance('com.sun.star.text.TextTable'); t.initialize(4, 3)
    w.block(t)
    vals = (('Name', 'Qty', 'Note'), ('Wide cell', '', 'Shaded'), ('Tall', '', 'c3'), ('', 'b4', 'c4'))
    for r, row in enumerate(vals):
        for c, v in enumerate(row):
            t.getCellByName('%s%d' % ('ABC'[c], r + 1)).setString(v)
    t.RepeatHeadline = True
    t.HeaderRowCount = 1
    t.getCellByName('C2').BackColor = 0xFFFF00
    inner = w.doc.createInstance('com.sun.star.text.TextTable'); inner.initialize(2, 1)
    cell = t.getCellByName('B3'); cell.setString('')
    cell.insertTextContent(cell.createTextCursor(), inner, False)
    inner.getCellByName('A1').setString('in1'); inner.getCellByName('A2').setString('in2')
    cc = t.createCursorByCellName('A3'); cc.goDown(1, True); cc.mergeRange()
    cc = t.createCursorByCellName('A2'); cc.goRight(1, True); cc.mergeRange()
    w.para('Standard', ['After the table.'])
    w.save('lo%s-tables.docx' % tag)


def media_doc(o, tag, png):
    w = Writer(o)
    w.para('Standard', ['Picture: '])
    g = o.smgr.createInstanceWithContext('com.sun.star.graphic.GraphicProvider', o.ctx).queryGraphic((prop('URL', uno.systemPathToFileUrl(png)),))
    obj = w.doc.createInstance('com.sun.star.text.TextGraphicObject'); obj.Graphic = g; obj.AnchorType = AS_CHARACTER; obj.Size = size(423, 423)
    w.text.insertTextContent(w.cur, obj, False)
    w.para('Standard', ['A link to ', ('the example site', {'HyperLinkURL': 'https://example.com/docs'}), '.'])
    w._break(); w.cur.ParaStyleName = 'Standard'; w.cur.NumberingStyleName = ''
    bm = w.doc.createInstance('com.sun.star.text.Bookmark'); bm.Name = 'target'
    w.text.insertTextContent(w.cur, bm, False)
    w.run('Target paragraph')
    w.para('Standard', ['Jump to ', ('the target', {'HyperLinkURL': '#target'}), '.'])
    w.save('lo%s-media.docx' % tag)


def skipped_doc(o, tag):
    w = Writer(o)
    ps = w.doc.StyleFamilies.getByName('PageStyles').getByName('Standard')
    ps.HeaderIsOn = True; ps.HeaderText.setString('Running header')
    ps.FooterIsOn = True; ps.FooterText.setString('Running footer')
    w.para('Standard', ['Contents:'])
    toc = w.doc.createInstance('com.sun.star.text.ContentIndex'); toc.CreateFromOutline = True
    w.block(toc)
    w.para('Heading 1', ['Chapter one'])
    w.para('Standard', ['Body with a footnote'])
    fn = w.doc.createInstance('com.sun.star.text.Footnote'); w.text.insertTextContent(w.cur, fn, False); fn.setString('The footnote text.')
    w.para('Standard', ['Body with an endnote'])
    en = w.doc.createInstance('com.sun.star.text.Endnote'); w.text.insertTextContent(w.cur, en, False); en.setString('The endnote text.')
    w.para('Standard', ['Anchor for a text box.'])
    fr = w.doc.createInstance('com.sun.star.text.TextFrame'); fr.Size = size(5000, 1000); fr.AnchorType = AT_PARAGRAPH
    w.text.insertTextContent(w.cur, fr, False); fr.getText().setString('Boxed words')
    w.para('Standard', ['Commented words'])
    ann = w.doc.createInstance('com.sun.star.text.textfield.Annotation'); ann.Author = 'Corpus'; ann.Content = 'A comment.'
    w.text.insertTextContent(w.cur, ann, False)
    w.para('Standard', ['Kept deleted words.'])
    c2 = w.text.createTextCursorByRange(w.cur.getEnd())
    c2.goLeft(len('deleted words.'), False)
    w.doc.RecordChanges = True
    w.text.insertString(c2, 'inserted ', False)          # "Kept inserted deleted words."
    c2.goRight(len('deleted '), True); c2.setString('')   # deletes "deleted "
    w.doc.RecordChanges = False
    w.para('Heading 1', ['Chapter two'], page='Landscape')
    w.para('Standard', ['Landscape page.'])
    toc.update()
    w.save('lo%s-skipped.docx' % tag)


def main():
    png = os.path.join(tempfile.gettempdir(), 'gen-docx-corpus-lo.png')
    png16(png)
    with Office() as o:
        v = o.version()
        tag = '.'.join(v.split('.')[:2])
        print('LibreOffice ' + v)
        styles_doc(o, tag); lists_doc(o, tag); tables_doc(o, tag); media_doc(o, tag, png); skipped_doc(o, tag)
    os.remove(png)


main()
```

- [ ] **Step 4: Write the reader**

Create `scripts/docx-truth-lo.py`:

```python
# m2fp.4: LibreOffice's reading of any .docx, as the DocxTruth JSON of
# test/helpers/docx-truth.ts, written beside it as <name>.lo.json. Tracked
# changes are COUNTED and then accepted (in memory only) so the paragraphs are
# the final text, as readDocx shows it. NOT run by npm test.
# Usage: <LibreOffice program>\python.exe scripts\docx-truth-lo.py <file.docx>...
import os, re, sys, json
import uno
from lo_common import Office, prop

CONTROL = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f]')


def clean(s):
    return CONTROL.sub('', (s or '').replace('\x0b', '\n').replace('\r', '\n'))


def count_enum(access):
    n, e = 0, access.createEnumeration()
    while e.hasMoreElements():
        e.nextElement(); n += 1
    return n


def segments(par):
    out, e = [], par.createEnumeration()
    while e.hasMoreElements():
        portion = e.nextElement()
        if portion.TextPortionType != 'Text':
            continue
        t = clean(portion.getString())
        if not t:
            continue
        seg = {'text': t, 'bold': portion.CharWeight >= 150, 'italic': portion.CharPosture.value != 'NONE',
               'sizePt': float(portion.CharHeight), 'font': portion.CharFontName}
        if out and all(out[-1][k] == seg[k] for k in ('bold', 'italic', 'sizePt', 'font')):
            out[-1]['text'] += t
        else:
            out.append(seg)
    return out


def links_of(par, links, state):
    e = par.createEnumeration()
    while e.hasMoreElements():
        portion = e.nextElement()
        url = portion.HyperLinkURL if portion.TextPortionType == 'Text' else ''
        t = clean(portion.getString())
        if url and state.get('url') == url:
            state['entry']['text'] += t
        elif url:
            entry = {'text': t, 'anchor': url[1:]} if url.startswith('#') else {'text': t, 'url': url}
            links.append(entry); state.clear(); state.update(url=url, entry=entry)
        else:
            state.clear()
    state.clear()


def cell_key(name):
    m = re.match(r'^([A-Z]+)(\d+)$', name)
    if not m:
        return (10 ** 9, 0)
    col = 0
    for ch in m.group(1):
        col = col * 26 + (ord(ch) - 64)
    return (int(m.group(2)), col)


def walk(text, in_table, doc, paras, tables, links, top):
    e = text.createEnumeration()
    while e.hasMoreElements():
        el = e.nextElement()
        if el.supportsService('com.sun.star.text.Paragraph'):
            lvl = el.OutlineLevel
            label = el.ListLabelString if el.NumberingStyleName or el.NumberingIsNumber else ''
            try:
                style = doc.StyleFamilies.getByName('ParagraphStyles').getByName(el.ParaStyleName).DisplayName
            except Exception:
                style = el.ParaStyleName
            paras.append({'text': clean(el.getString()), 'styleName': style,
                          'heading': lvl if 1 <= lvl <= 9 else None, 'listLabel': label or None,
                          'inTable': in_table, 'segments': segments(el)})
            links_of(el, links, {})
        elif el.supportsService('com.sun.star.text.TextTable'):
            names = sorted(el.getCellNames(), key=cell_key)
            if top:
                rows = {}
                for n in names:
                    rows.setdefault(cell_key(n)[0], []).append(clean(el.getCellByName(n).getString()).rstrip('\n'))
                tables.append({'rows': [rows[k] for k in sorted(rows)]})
            for n in names:
                walk(el.getCellByName(n), True, doc, paras, tables, links, False)


def text_boxes(doc):
    n = 0
    for i in range(doc.DrawPage.getCount()):
        try:
            if doc.DrawPage.getByIndex(i).TextBox:
                n += 1
        except Exception:
            pass
    return n or doc.TextFrames.getCount()


def read(o, path):
    doc = o.desktop.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(path)), '_blank', 0, (prop('Hidden', True),))
    try:
        hdr = ftr = 0
        pstyles = doc.StyleFamilies.getByName('PageStyles')
        for name in pstyles.getElementNames():
            ps = pstyles.getByName(name)
            if not ps.isInUse():
                continue
            if ps.HeaderIsOn and ps.HeaderText.getString().strip():
                hdr += 1
            if ps.FooterIsOn and ps.FooterText.getString().strip():
                ftr += 1
        fields = comments = 0
        e = doc.TextFields.createEnumeration()
        while e.hasMoreElements():
            f = e.nextElement()
            if f.supportsService('com.sun.star.text.textfield.Annotation'):
                comments += 1
            elif not f.supportsService('com.sun.star.text.textfield.URL'):
                fields += 1
        fields += doc.DocumentIndexes.getCount()
        counts = {'headers': hdr, 'footers': ftr, 'footnotes': doc.Footnotes.getCount(), 'endnotes': doc.Endnotes.getCount(),
                  'textBoxes': text_boxes(doc), 'fields': fields, 'comments': comments, 'revisions': count_enum(doc.Redlines)}
        if counts['revisions']:
            disp = o.smgr.createInstanceWithContext('com.sun.star.frame.DispatchHelper', o.ctx)
            disp.executeDispatch(doc.CurrentController.Frame, '.uno:AcceptAllTrackedChanges', '', 0, ())
        paras, tables, links = [], [], []
        walk(doc.Text, False, doc, paras, tables, links, True)
        return {'reader': 'LibreOffice ' + o.version(), 'paragraphs': paras, 'tables': tables, 'links': links,
                'images': doc.GraphicObjects.getCount(), 'counts': counts}
    finally:
        doc.close(True)


def main():
    with Office() as o:
        for path in sys.argv[1:]:
            truth = read(o, path)
            out = os.path.splitext(path)[0] + '.lo.json'
            with open(out, 'w', encoding='utf-8', newline='\n') as f:
                json.dump(truth, f, ensure_ascii=False, indent=2)
            print('wrote ' + out)


main()
```

- [ ] **Step 5: Write the driver**

Create `scripts/gen-docx-corpus.ps1`:

```powershell
# m2fp.4: (re)builds the DOCX corpus and both readers' truth for every corpus
# file, then prints SHA-256s for PROVENANCE. NOT run by npm test.
#   -LoProgram  LibreOffice's program directory (soffice.exe, python.exe)
#   -SkipBuild  re-read only; keep the vendored .docx files
param([Parameter(Mandatory = $true)][string]$LoProgram, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..'
$fx = [IO.Path]::GetFullPath((Join-Path $root 'test\fixtures\docx'))
$py = Join-Path $LoProgram 'python.exe'
Push-Location $PSScriptRoot
try {
  if (-not $SkipBuild) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'gen-docx-corpus-word.ps1') -OutDir $fx
    if ($LASTEXITCODE) { throw 'Word builder failed' }
    & $py (Join-Path $PSScriptRoot 'gen-docx-corpus-lo.py') $fx
    if ($LASTEXITCODE) { throw 'LibreOffice builder failed' }
  }
  $files = @(Get-ChildItem $fx -Filter *.docx | Where-Object { $_.Name -ne 'wml-oracle.docx' } | Sort-Object Name)
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'docx-truth-word.ps1') -Docx $files.FullName
  if ($LASTEXITCODE) { throw 'Word reader failed' }
  & $py (Join-Path $PSScriptRoot 'docx-truth-lo.py') $files.FullName
  if ($LASTEXITCODE) { throw 'LibreOffice reader failed' }
} finally { Pop-Location }
foreach ($f in $files) { "{0}  {1}" -f (Get-FileHash $f.FullName -Algorithm SHA256).Hash, $f.Name }
```

- [ ] **Step 6: Run it all and check the LibreOffice recipes**

Run (PowerShell): `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-docx-corpus.ps1 -LoProgram '<prog>'`

Note: the Word builder runs again and REWRITES the five Word files (new `core.xml` timestamps) — that is expected; Task 3's commit is superseded by this one. Expected: ten documents plus `word2010-basic.docx`, each with `.word.json` and `.lo.json`, and 11 SHA-256 lines.

Rerun Task 3 Step 4's check over `*.lo.json` (change the filter to `.lo.json`) and check the SAME recipe intents on the `lo*` files as read by LibreOffice. A UNO call that failed or an intent that did not happen is a builder bug: fix it and rerun with `-SkipBuild` omitted. Ledger every recipe change as `Task 4: Ruling:`. Known points where LibreOffice may genuinely differ and that are NOT bugs: the bullet character, the page-style header count, and whether the text frame becomes a shape; these become recorded disagreements in Task 5.

- [ ] **Step 7: Commit**

```bash
git add scripts/lo_common.py scripts/gen-docx-corpus-lo.py scripts/docx-truth-lo.py scripts/gen-docx-corpus.ps1 test/fixtures/docx/*.docx test/fixtures/docx/*.word.json test/fixtures/docx/*.lo.json
git status --short test/fixtures/docx   # wml-oracle.* must NOT appear
git commit -m "test(m2fp.4): LibreOffice-written corpus documents and both readers' truth"
```

---

### Task 5: The disagreements file and the corpus test

**Files:**
- Create: `scripts/docx-disagreements.ts`, `test/fixtures/docx/disagreements.json`, `test/docx-corpus.test.ts`
- Modify: `src/wml*.ts` only for divergences ruled small (TDD in the module's own test file)

**Interfaces:**
- Consumes: everything in Task 2's `docx-truth.ts`; `readDocx`.

- [ ] **Step 1: Write the disagreements generator and run it**

Create `scripts/docx-disagreements.ts`:

```ts
// m2fp.4: writes test/fixtures/docx/disagreements.json — per corpus file, the
// JSON paths where Word's and LibreOffice's readings of it differ. Run after
// scripts/gen-docx-corpus.ps1; test/docx-corpus.test.ts asserts this file
// EXACTLY, so a regenerated truth that moves a disagreement reddens the build.
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTruth, readerDisagreements } from '../test/helpers/docx-truth.js';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'docx');
const out: Record<string, string[]> = {};
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.docx') && x !== 'wml-oracle.docx').sort()) {
  const base = join(DIR, f.replace(/\.docx$/, ''));
  if (!existsSync(`${base}.word.json`) || !existsSync(`${base}.lo.json`)) { out[f] = []; continue; }
  out[f] = readerDisagreements(readTruth(`${base}.word.json`), readTruth(`${base}.lo.json`)).sort();
}
writeFileSync(join(DIR, 'disagreements.json'), JSON.stringify(out, null, 2) + '\n');
for (const [f, d] of Object.entries(out)) console.log(f, d.length);
```

Run: `npx tsx scripts/docx-disagreements.ts`
Expected: one line per corpus file with its disagreement count. Read `disagreements.json`: for EACH disagreement, look at both truth files at that path and ledger one line `Task 5: Disagreement: <file> <path> — Word <x>, LibreOffice <y>`. Group repeated shapes (e.g. every bullet label) into one line. These lines become PROVENANCE's findings in Task 6.

- [ ] **Step 2: Write the corpus test**

Create `test/docx-corpus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readDocx } from '../src/wmlread.js';
import {
  readTruth, readerDisagreements, leafDiff, comparable, truthOf, COUNT_KEYS, type DocxTruth, type TruthCounts,
} from './helpers/docx-truth.js';

// m2fp.4's corpus: .docx files written by Word 2010 and LibreOffice, each READ
// by both (test/fixtures/docx/PROVENANCE.md). readDocx is held to what the two
// readers AGREE on; where they disagree, the disagreement itself is pinned.
const DIR = join(__dirname, 'fixtures', 'docx');
const NOT_CORPUS = new Set(['wml-oracle.docx']);   // m2fp.3's oracle: OURS, read by Word
const files = readdirSync(DIR).filter((f) => f.endsWith('.docx') && !NOT_CORPUS.has(f)).sort();
const disagreements = JSON.parse(readFileSync(join(DIR, 'disagreements.json'), 'utf8')) as Record<string, string[]>;

// The text-box recipe's words: both applications read a text box as a separate
// story, while readDocx keeps an unknown construct's text inline (m2fp.3's
// visible-beats-dropped rule), so they are stripped before comparing.
const OTHER_STORY_TEXT = ['Boxed words'];

// Where readDocx differs from what both readers agree on, and the issue that
// owns it. Fixing one reddens its pin on purpose.
const KNOWN_GAPS: Record<string, { path: string; issue: string }[]> = {};
const KNOWN_SKIP_GAPS: Record<string, { count: keyof TruthCounts; issue: string }[]> = {};

const SKIP_MAP: Record<keyof TruthCounts, string[]> = {
  headers: ['w:headerReference'], footers: ['w:footerReference'],
  footnotes: ['w:footnoteReference'], endnotes: ['w:endnoteReference'],
  textBoxes: ['w:txbxContent', 'w:pict'], fields: ['w:fldChar', 'w:fldSimple'],
  comments: ['w:commentReference'], revisions: ['w:ins', 'w:del'],
};

function truthsOf(f: string): DocxTruth[] {
  const base = join(DIR, f.replace(/\.docx$/, ''));
  return ['word', 'lo'].map((k) => `${base}.${k}.json`).filter(existsSync).map(readTruth);
}

function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const m of path.matchAll(/[^.[\]]+|\[(\d+)\]/g)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[m[1] ?? m[0]];
  }
  return cur;
}

it('has a corpus, every file with at least one reader\'s truth and a disagreements entry', () => {
  expect(files.length).toBeGreaterThanOrEqual(6);
  const missing = files.filter((f) => truthsOf(f).length === 0 || !(f in disagreements));
  expect(missing).toEqual([]);
});

describe.each(files)('%s', (f) => {
  const truths = truthsOf(f);
  const ours = readDocx(new Uint8Array(readFileSync(join(DIR, f))));
  const pinned = disagreements[f] ?? [];
  const set = new Set(pinned);
  // An array the readers disagree on in LENGTH is compared only up to the
  // shorter of THEIRS: past it one reader's elements have no witness.
  const shorter = new Map<string, number>();
  for (const p of pinned) {
    if (!p.endsWith('.length') || truths.length < 2) continue;
    const base = p.slice(0, -'.length'.length);
    const lens = truths.map((t) => (get(comparable(t), base) as unknown[] | undefined)?.length ?? 0);
    shorter.set(base, Math.min(...lens));
  }
  const excluded = (path: string): boolean => {
    if (set.has(path)) return true;
    for (const [base, min] of shorter) {
      if (!path.startsWith(`${base}[`)) continue;
      const i = Number(/^\[(\d+)\]/.exec(path.slice(base.length))![1]);
      if (i >= min) return true;
    }
    return false;
  };

  it('pins exactly where the two readers disagree', () => {
    const got = truths.length === 2 ? readerDisagreements(truths[0], truths[1]).sort() : [];
    expect(got).toEqual([...pinned].sort());
  });

  it('still compares at least one paragraph', () => {
    const n = truths[0].paragraphs.length;
    const min = shorter.get('paragraphs') ?? n;
    expect(Math.min(n, min)).toBeGreaterThan(0);
  });

  it('matches the readers wherever they agree', () => {
    const diff = leafDiff(comparable(truths[0]), truthOf(ours, OTHER_STORY_TEXT)).filter((p) => !excluded(p)).sort();
    expect(diff).toEqual((KNOWN_GAPS[f] ?? []).map((g) => g.path).sort());
  });

  it('records every construct the readers found and readDocx does not model', () => {
    const names = new Set(ours.unsupported.map((u) => u.name));
    const missing = COUNT_KEYS.filter((k) => truths.every((t) => t.counts[k] > 0) && !SKIP_MAP[k].some((n) => names.has(n)));
    expect(missing).toEqual((KNOWN_SKIP_GAPS[f] ?? []).map((g) => g.count));
  });
});
```

- [ ] **Step 3: Run it and adjudicate every failure**

Run: `npx vitest run test/docx-corpus.test.ts > <workspace>/corpus.txt 2>&1` and read the failures.

For EACH failing path in `matches the readers wherever they agree` and each missing count, decide in this order:

1. **The helper projects wrongly** (a normalization in `truthOf` that no reader shares — e.g. how a tab or a line break is attributed). Fix `test/helpers/docx-truth.ts`, add a `test/docx-truth.test.ts` case that fails first, ledger `Task 5: Ruling: projection — <what>`.
2. **`readDocx` is wrong and the fix is SMALL and LOCAL** (one rule in one `wml*` module). Write the failing case in that module's own test file from a hand-built XML string reproducing the shape, watch it fail, fix, rerun both files, ledger `Task 5: Ruling: fixed <rule> in <module>`.
3. **`readDocx` is wrong and the fix is LARGER** (a new construct, a model change). File `bd create --type task --parent aspose-pdf-foss-for-ts-m2fp "<title>" -d "<the path, both readers' values, ours>"`, add the path to `KNOWN_GAPS[f]` (or the count to `KNOWN_SKIP_GAPS[f]`) with that issue id, ledger `Task 5: Ruling: pinned <path> as <issue>`.
4. **Both readers agree on something `readDocx` deliberately does differently by spec** (the recorded-not-modelled line) — pin it as case 3 with the spec clause in the issue text instead of filing new work only if no issue already covers it; name the clause in the ledger.

Never edit a truth file, and never widen `OTHER_STORY_TEXT` beyond text-box words without a ledgered ruling.

Rerun until green.

- [ ] **Step 4: Prove the test load-bearing**

Break three rules one at a time, confirm red, restore with `git checkout <file>`:
- `src/wmlnumbering.ts`: `case 'lowerRoman': return n > 0 ? roman(n) : String(n);` → `case 'lowerRoman': return String(n);` (a corpus list label must redden).
- `src/wmlstyles.ts`: `return (pv ?? false) !== (cv ?? false);` → `return (pv ?? false) || (cv ?? false);` (the `toggle` segment must redden).
- `src/wmlbody.ts`: in `section`, the `this.note(...)` line removed (the skipped check must redden on `headers`).

Ledger each as `Task 5: Mutation <n>: red at <test names>`. A green one is a finding: add the case that catches it, or ledger why it cannot be caught here.

- [ ] **Step 5: Commit**

```bash
git add scripts/docx-disagreements.ts test/fixtures/docx/disagreements.json test/docx-corpus.test.ts test/helpers/docx-truth.ts test/docx-truth.test.ts src/ test/
git commit -m "test(m2fp.4): hold readDocx to what Word and LibreOffice agree on"
```

---

### Task 6: PROVENANCE, CLAUDE.md, gates, close

**Files:**
- Modify: `test/fixtures/docx/PROVENANCE.md`, `CLAUDE.md`

- [ ] **Step 1: PROVENANCE**

Replace the opening paragraph of `test/fixtures/docx/PROVENANCE.md` so it describes the corpus, then append one section per new file in the existing `word2010-basic.docx` section's shape: Producer (exact version), Command (`scripts/gen-docx-corpus.ps1 -LoProgram <dir>`, or the Word builder alone), SHA-256 (from the driver's output), Not reproducible byte for byte (both writers stamp `docProps/core.xml`), License (ours plus the writer's defaults), What it covers, What it does NOT cover. Then add:

```markdown
## Ground truth and reader disagreements

Every corpus file has `<name>.word.json` (Microsoft Word 2010, `scripts/docx-truth-word.ps1`)
and, when LibreOffice was available, `<name>.lo.json` (`scripts/docx-truth-lo.py`), both in the
`DocxTruth` schema of `test/helpers/docx-truth.ts`. Both readers count tracked changes and
then ACCEPT them in memory, so paragraphs are the final text. `styleName` is recorded and
never compared (Word's UI is Russian). `disagreements.json` is written by
`scripts/docx-disagreements.ts`; `test/docx-corpus.test.ts` asserts it exactly.

- **LibreOffice:** <full version>, MSI `LibreOffice_<V>_Win_x86-64.msi`, SHA-256 `<hash>`,
  unpacked by `msiexec /a` outside the repository.

### Where Word and LibreOffice disagree
<one bullet per Task 5 `Disagreement:` ledger line, grouped by shape>

### Where readDocx is held to a known gap
<one bullet per KNOWN_GAPS / KNOWN_SKIP_GAPS entry, with its issue id, or "none">
```

- [ ] **Step 2: CLAUDE.md**

Replace the `fixtures/docx/` row of the fixture table with one that describes the whole directory: the m2fp.2 Word file, the m2fp.3 oracle (ours, read by Word), and the m2fp.4 corpus (two writers, two readers, `disagreements.json` pinned exactly, `readDocx` held to the agreement) — naming what the corpus corrected (every Task 5 ruling that fixed `src/`).

In the `wmlns.ts … wmlread.ts` Source-list entry, add after the "relationship naming nothing" invariant:

```markdown
  **Invariant (`m2fp.4`):** tracked changes (`w:ins`/`w:del`/moves) and simple
  fields keep the final-text treatment but are RECORDED, and so are header and
  footer references and a section break inside a paragraph — the flow engine
  renders none of them, and the corpus showed they had left no trace at all.
```

plus one `**Note (m2fp.4):**` line per `src/` fix Task 5 made. Run the Source-list sweep from CLAUDE.md's Conventions; it must print nothing.

- [ ] **Step 3: Full gates**

Run: `npm run typecheck` then `npm test` (to a file; read the tail).
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/docx/PROVENANCE.md CLAUDE.md
git commit -m "docs(m2fp.4): DOCX corpus provenance, reader disagreements and CLAUDE.md"
```

Closing `m2fp.4` in `bd` and pushing happen after the branch is merged (executing-plans' finish), not here.
