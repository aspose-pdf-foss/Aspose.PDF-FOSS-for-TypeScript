# XFA Qualified Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dynamic XFA form whose one `<pageSet>` states `relation="simplexPaginated"` or `"duplexPaginated"` paginates (page-area qualifiers, `pageEven`/`pageOdd` breaks, `last`/`only` termination) and converts, matching Adobe Reader's page sequence.

**Architecture:** `xfatemplate.ts` reads the three page-area qualifiers and stops refusing the two relations; `xfapage.ts`'s existing `Paginator` gains a qualified mode whose page-area choice has ONE owner, `chooseArea`, leaving the ordered path untouched; termination reruns `paginate` with one forced page area. Adobe Reader 26.1 probes (164g.11's harness) are the oracle, run FIRST because three of the rules are open until they report.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, Adobe Acrobat Reader 26.1 via `scripts/run-xfa-adobe-probe.ps1` (Windows, not run by `npm test`).

**Spec:** `docs/superpowers/specs/2026-10-14-xfa-qualified-pagination-design.md` (issue `aspose-pdf-foss-for-ts-164g.9`). Read it first.

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only.
- Import specifiers carry `.js`; strict TypeScript; `npm run typecheck` and `npm test` both green before any commit that touches `src/`.
- `xfapage.ts` stays a pure leaf over `xfaflow.js`, `xfageom.js`, `xfasplitpos.js` that NEVER throws: what it cannot paginate is refused BY NAME.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts` enforces it).
- No approximated geometry: a shape the spec and the probes leave open is refused, not guessed.
- Every rule carries its citation: `XFA 3.3 p. N` or `Adobe probe qN`.
- The ordered relation's behaviour does not move: `test/xfapage.test.ts`, `test/xfa-real.test.ts`, `test/xfa-dynamic-oracle.test.ts`, `test/xfa-master-oracle.test.ts`, `test/xfa-adobe-oracle.test.ts` pass UNEDITED.
- Nested and sibling page sets are refused citing `164g.22`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A qualified page area with no `<contentArea>` that matches every later page** (a `rest`/`any` boilerplate area) — a reasonable person expects a refusal, not an endless page loop. Test in Task 3 ("refuses a boilerplate page area that would repeat forever").
2. **`occur` stated on a qualified page area or page set** — expected to be ignored with a warning, never to refuse or cap pages (an ordered-mode `occur min` refusal must not leak into qualified mode). Tests in Task 2 and Task 3.
3. **An unknown qualifier value (`pagePosition="middle"`)** — expected to refuse the page set by name, not to be read as `any`. Test in Task 2.
4. **A qualifier stated under `orderedOccurrence`** — p. 302 says it is ignored, so an unknown value there must NOT refuse an ordered document that converts today. Test in Task 2.
5. **Termination when the final page is a blank filler page** — expected: no redo of a page that holds no content; the appended `last` page still follows. Test in Task 5.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/gen-xfa-adobe-probes.ts` | Modify | Accept a probe's own `<pageSet>`; report each page's page area |
| `test/fixtures/xfa-adobe/q1.xml`…`q14.xml`, `q1.pdf`…`q14.pdf`, `captures/q*.png`, `adobe-qualified.json`, `PROVENANCE.md` | Create / Modify | The Adobe oracle |
| `test/helpers/xfa-adobe.ts` | Modify | Load qualified probes and goldens |
| `src/xfapage.ts` | Modify | Qualifier types, `chooseArea`, qualified `Paginator` mode, parity breaks, termination |
| `src/xfatemplate.ts` | Modify | Read qualifiers and relation; stop refusing `pageEven`/`pageOdd` |
| `src/xfaconvert.ts` | Verify (modify only if Task 6 shows it must) | Blank pages created like boilerplate |
| `test/xfatemplate-qualified.test.ts` | Create | Template parsing |
| `test/xfapage-qualified.test.ts` | Create | Selection, breaks, termination |
| `test/xfa-adobe-qualified-oracle.test.ts` | Create | Probes converted and compared |
| `CHANGELOG.md`, `CLAUDE.md`, `README.md` | Modify | Docs |

---

### Task 1: Adobe Reader probes q1–q14

Runs Adobe Reader, so it must run on this Windows machine with Reader installed at `C:\Program Files\Adobe\Acrobat DC\Acrobat\Acrobat.exe`. Its output decides four rules the later tasks branch on.

**Files:**
- Modify: `scripts/gen-xfa-adobe-probes.ts`
- Create: `test/fixtures/xfa-adobe/q1.xml` … `q14.xml`
- Create: `test/fixtures/xfa-adobe/q1.pdf` … `q14.pdf`, `captures/q1.png` … `captures/q14.png`
- Create: `test/fixtures/xfa-adobe/adobe-qualified.json`
- Modify: `test/fixtures/xfa-adobe/PROVENANCE.md`
- Modify: `test/helpers/xfa-adobe.ts`

**Interfaces:**
- Produces (Task 6 consumes): `QUALIFIED_PROBES: readonly string[]` (`'q1'`…`'q14'`), `qualifiedGoldens(): QualifiedGoldens`, and

```ts
export interface QualifiedProbe {
  /** 'match': we must reproduce `areas` and `fields`; 'refused': we must refuse, citing `reason`. */
  expect: 'match' | 'refused';
  reason?: string;
  /** Page area NAME per page, page 1 first, exactly as Adobe reported. */
  areas: string[];
  /** Our SOM field name to Adobe's 1-based page. */
  fields: Record<string, number>;
  /** What Adobe showed, in words, when it is not a plain sequence. */
  note?: string;
}
export interface QualifiedGoldens {
  reader: string;
  /** The four open rules, as the probes settled them. */
  decisions: {
    /** q3: under simplex, does an oddOrEven="even" page area ever match? */
    simplexEvenArea: 'never' | 'matches';
    /** q12: what a pageEven break does under simplex. */
    simplexPageEven: 'newPage' | 'filler' | 'stays';
    /** q9: does duplex append a blank back page after a final odd page? */
    duplexTrailingBack: boolean;
    /** q10: what Adobe does when no page area matches page 1. */
    noMatch: 'nothing' | 'other';
  };
  probes: Record<string, QualifiedProbe>;
}
```

- [ ] **Step 1: Teach the generator a probe-owned page set and a page-area report**

In `scripts/gen-xfa-adobe-probes.ts`, after `const body = readFileSync(...)`, split off an optional `<pageSet>`:

```ts
/** A probe may state its own <pageSet> (164g.9); otherwise the one-page-area default. */
const own = /<pageSet\b[\s\S]*?<\/pageSet>/.exec(body);
const pageSet = own?.[0] ?? `<pageSet><pageArea name="P1" id="P1"><medium short="8.5in" long="11in" stock="letter"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea></pageSet>`;
const content = own ? body.replace(own[0], '') : body;
```

In the script string, replace the `try { … }` line with:

```js
  try {
    walk(xfa.form);
    var areas = [];
    for (var p = 0; p < xfa.layout.pageCount(); p++) {
      var ds = xfa.layout.pageContent(p, "draw", true);
      var nm = [];
      for (var j = 0; j < ds.length; j++) nm.push(ds.item(j).name);
      areas.push((p + 1) + ":" + nm.join("/"));
    }
    msg = "pages=" + xfa.layout.pageCount() + "\\nareas=" + areas.join(" ") + "\\n" + rows.join("\\n");
  }
```

In `template`, replace the inline `<pageSet>…</pageSet>` with `${pageSet}` and `${body}` with `${content}`.

- [ ] **Step 2: Rebuild one existing probe to prove the default path did not change**

Run: `npx tsx scripts/gen-xfa-adobe-probes.ts t5`
Expected: `wrote …/t5.out.pdf`. Then `git status --short test/fixtures/xfa-adobe/` shows only the untracked `t5.out.pdf`. Delete it: `rm test/fixtures/xfa-adobe/t5.out.pdf`.

- [ ] **Step 3: Write the fourteen probe templates**

Shared fragments (write them out in full in every file; no includes):
- A page area `X` is
  `<pageArea name="X" id="X" QUALIFIERS><medium short="8.5in" long="11in" stock="letter"/><contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/><draw name="markX" x="4.5in" y="0.1in" w="3in" h="0.3in"><font typeface="Arial" size="10pt"/><value><text>AREA-X</text></value></draw></pageArea>`
  with `QUALIFIERS` as listed, and the content area `h` as listed (default `10in`).
- An item run of N is
  `<subform name="item" layout="position" w="7.5in" h="8in"><occur min="N" initial="N" max="N"/><field name="f" w="2in" h="0.3in"><ui><textEdit/></ui></field></subform>`
  (8in plus the 3in oracle exceeds a 10in content area, so page 1 holds the oracle alone and each item takes its own page.)
- A short item `S` is `<subform name="S" layout="position" w="7.5in" h="2in">BREAK<field name="f" w="2in" h="0.3in"><ui><textEdit/></ui></field></subform>`.

| File | `<pageSet relation=…>` | Page areas (in order) | Body after the page set |
|---|---|---|---|
| `q1.xml` | `simplexPaginated` | A `pagePosition="rest"`; B `pagePosition="first"` | item run of 2 |
| `q2.xml` | `duplexPaginated` | A `oddOrEven="odd" pagePosition="rest"`; B `oddOrEven="even" pagePosition="rest"`; C `pagePosition="first"` | item run of 3 |
| `q3.xml` | `simplexPaginated` | A `pagePosition="first"`; B `oddOrEven="even" pagePosition="rest"`; C `pagePosition="rest"` | item run of 2 |
| `q4.xml` | `duplexPaginated` | C `pagePosition="first"`; A `oddOrEven="odd" pagePosition="rest"`; B `oddOrEven="even" pagePosition="rest"` | `<subform name="X" layout="tb"><subform name="Y" layout="position" w="7.5in" h="8in"><occur min="2" initial="2" max="2"/><field name="f" w="2in" h="0.3in"><ui><textEdit/></ui></field></subform><breakAfter targetType="pageOdd" startNew="1"/></subform><subform name="Z" layout="position" w="7.5in" h="8in"><field name="f" w="2in" h="0.3in"><ui><textEdit/></ui></field></subform>` |
| `q5.xml` | `simplexPaginated` | A `pagePosition="any"`; B `pagePosition="last"` | item run of 3 |
| `q6.xml` | `simplexPaginated` | A `pagePosition="first"`; B `pagePosition="any"`; C `pagePosition="last"`; D `pagePosition="only"` | `<subform name="item" layout="position" w="7.5in" h="6in"><field name="f" w="2in" h="0.3in"><ui><textEdit/></ui></field></subform>` |
| `q7.xml` | `simplexPaginated` | as q6 | item run of 3 |
| `q8.xml` | `simplexPaginated` | A `pagePosition="any"`; B `pagePosition="last"` with content area `h="2in"` | item run of 2 |
| `q9.xml` | `duplexPaginated` | A `oddOrEven="odd"`; B `oddOrEven="even"` | item run of 2 |
| `q10.xml` | `simplexPaginated` | A `pagePosition="rest"` | item run of 1 |
| `q11.xml` | (no `relation`) | A; B | short item `S0` with BREAK empty, then short item `S1` with BREAK `<breakBefore targetType="pageOdd" startNew="1"/>` |
| `q12.xml` | `simplexPaginated` | A `pagePosition="any"` | `S0` with no break, `S1` with `<breakBefore targetType="pageEven"/>` |
| `q13.xml` | `duplexPaginated` | C `pagePosition="first"`; A `pagePosition="rest" blankOrNotBlank="notBlank"`; F `pagePosition="rest" blankOrNotBlank="blank"` | `S0` with `<breakBefore targetType="pageOdd" startNew="1"/>` |
| `q14.xml` | `simplexPaginated` | A `pagePosition="any"` carrying `<occur max="1"/>` as its first child | item run of 2 |

- [ ] **Step 4: Generate, run and capture each probe**

For each `qN` in q1…q14:

```bash
npx tsx scripts/gen-xfa-adobe-probes.ts qN
mv test/fixtures/xfa-adobe/qN.out.pdf test/fixtures/xfa-adobe/qN.pdf
```

```powershell
scripts/run-xfa-adobe-probe.ps1 -Name qN
Move-Item test\fixtures\xfa-adobe\qN.png test\fixtures\xfa-adobe\captures\qN.png
```

Read each capture with the Read tool. A capture whose field is empty or reads `ERR` is itself a result: re-run once (Reader occasionally needs longer than 15 s); if it is empty twice, record it as `note: "Reader drew no page"`.

- [ ] **Step 5: Transcribe `adobe-qualified.json`**

From each capture's `areas=` line take the page-area name per page (the draw `markX` → `X`); from each field row take its first fragment's page. Field keys are OUR SOM names: `form1.item[1].f` becomes `form1[0].item[1].f[0]`; `form1.X.Y[1].f` becomes `form1[0].X[0].Y[1].f[0]`. The `oracle.out` field is NOT recorded. Write:

```json
{
  "reader": "Adobe Acrobat Reader 26.1.21691.0 (Acrobat DC, Reader mode, Protected Mode on)",
  "decisions": { "simplexEvenArea": "…", "simplexPageEven": "…", "duplexTrailingBack": …, "noMatch": "…" },
  "probes": { "q1": { "expect": "match", "areas": ["B", "A", "A"], "fields": { "form1[0].item[0].f[0]": 2, "form1[0].item[1].f[0]": 3 } }, … }
}
```

`decisions` from: q3 (`never` if pages 2-3 use C, `matches` if they use B); q12 (`newPage` if S1 is on page 2 with no blank page, `filler` if a blank page precedes it, `stays` if S1 stays on page 1); q9 (`true` if a 4th, blank page with area B follows); q10 (`nothing` if Reader drew no page or reported `ERR`, `other` otherwise). A probe Reader could not lay out gets `"expect": "refused"`, `"reason": "XFA 3.3 p. 304"`, `"areas": []`, `"fields": {}`.

- [ ] **Step 6: Gate — compare against the spec's predictions**

Predicted (spec): q1 `B,A,A`; q2 `C,B,A,B`; q4 `C,B,A,B(blank),A`, then a trailing blank `B` if q9 says so; q5 `A,A,A,B`; q6 `D`; q7 `A,B,B,C`; q8 `A,A,A,B` with B holding no field; q11 `A,A(blank),A` with S0 on page 1 with the oracle, S1 on page 3; q13 `C,F,A`; q14 `A,A,A`.

If ANY match probe contradicts its prediction in a way the four `decisions` do not explain — or q10 is `other` — STOP. Report the capture and the transcription to the human partner; the rule must be redesigned from what Adobe shows before Task 3 starts. Otherwise continue.

- [ ] **Step 7: Helper and provenance**

Append to `test/helpers/xfa-adobe.ts` (after `adobeGoldens`) the `QualifiedProbe`/`QualifiedGoldens` interfaces from **Interfaces** above, and:

```ts
export const QUALIFIED_PROBES: readonly string[] = Array.from({ length: 14 }, (_, i) => `q${String(i + 1)}`);
export const qualifiedGoldens = (): QualifiedGoldens =>
  JSON.parse(readFileSync(new URL('adobe-qualified.json', DIR), 'utf8')) as QualifiedGoldens;
```

Append a section to `PROVENANCE.md`:

```markdown
## Qualified pagination probes (164g.9)

**Producer:** as above, 2026-10-14. `qN.xml` states its own `<pageSet>`; each
page area carries a draw named `markX` reading `AREA-X`, and the docReady report
adds `areas=` — per page, the draws `xfa.layout.pageContent(p, "draw", true)`
returns. `adobe-qualified.json` holds, per probe, the page area of every page
and the page of every field, plus the four rules XFA 3.3 leaves open as the
probes settled them (`decisions`).

**Ceiling:** one producer, one version, hand transcription, the screen as the
channel — and Reader lays out on SCREEN, so these are Adobe's answers for the
display view, not for a duplex printer. Not covered: nested and sibling page
sets (164g.22), page-number initialization and scripting.

| File | SHA-256 |
|---|---|
```

and one row per `qN.pdf` from `sha256sum test/fixtures/xfa-adobe/q*.pdf`.

- [ ] **Step 8: Commit**

```bash
git add scripts/gen-xfa-adobe-probes.ts test/fixtures/xfa-adobe/ test/helpers/xfa-adobe.ts
git commit -m "test(164g.9): Adobe Reader probes for qualified pagination, q1-q14

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read qualifiers and accept the two relations

**Files:**
- Modify: `src/xfapage.ts` (types only), `src/xfatemplate.ts` (`breakOf`, `pageAreaOf`, `pageSetOf`)
- Create: `test/xfatemplate-qualified.test.ts`

**Interfaces:**
- Produces, in `src/xfapage.ts`:

```ts
export type XfaPagePosition = 'any' | 'first' | 'last' | 'rest' | 'only';
export type XfaOddOrEven = 'any' | 'odd' | 'even';
export type XfaBlankOrNotBlank = 'any' | 'blank' | 'notBlank';
// on XfaPageAreaModel, all optional (absent reads as 'any'):
pagePosition?: XfaPagePosition; oddOrEven?: XfaOddOrEven; blankOrNotBlank?: XfaBlankOrNotBlank;
// on XfaPageSet:
/** Warnings found while reading the page set (an ignored occur). */
warnings?: string[];
// on PaginatedPage:
/** A page holding no content by design: a parity filler or an appended last page. */
blank?: true;
```

- [ ] **Step 1: Write the failing tests**

`test/xfatemplate-qualified.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';

const CA = '<contentArea x="0" y="0" w="500pt" h="700pt"/>';
const MED = '<medium short="8.5in" long="11in"/>';
const tpl = (pageSet: string, body = '<subform name="s" w="100pt" h="10pt"/>') => parseXfaTemplate(parseXml(
  `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb">${pageSet}${body}</subform></template>`));

describe('qualified page sets in the template (164g.9)', () => {
  it('reads the three qualifiers onto each page area', () => {
    const t = tpl(`<pageSet relation="duplexPaginated"><pageArea name="A" pagePosition="rest" oddOrEven="even" blankOrNotBlank="blank">${MED}${CA}</pageArea><pageArea name="B">${MED}${CA}</pageArea></pageSet>`);
    const ps = t.body!.pageSet!;
    expect(ps.relation).toBe('duplexPaginated');
    expect(ps.refusal).toBeUndefined();
    expect(ps.pageAreas[0]).toMatchObject({ pagePosition: 'rest', oddOrEven: 'even', blankOrNotBlank: 'blank' });
    expect(ps.pageAreas[1].pagePosition).toBeUndefined();
  });
  it('refuses an unknown qualifier value by name under a qualified relation', () => {
    const ps = tpl(`<pageSet relation="simplexPaginated"><pageArea name="A" pagePosition="middle">${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBe('pageArea pagePosition="middle" is not one XFA defines (XFA 3.3 p. 302)');
  });
  it('ignores qualifiers, valid or not, under orderedOccurrence (p. 302)', () => {
    const ps = tpl(`<pageSet><pageArea name="A" pagePosition="middle" oddOrEven="even">${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBeUndefined();
    expect(ps.pageAreas[0].pagePosition).toBeUndefined();
    expect(ps.pageAreas[0].oddOrEven).toBeUndefined();
  });
  it('ignores occur on a qualified page area and page set, with one warning each (p. 296)', () => {
    const ps = tpl(`<pageSet relation="simplexPaginated"><occur min="3" max="2"/><pageArea name="A"><occur min="5" max="x"/>${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBeUndefined();
    expect(ps.pageAreas[0].max).toBe(-1);
    expect(ps.max).toBe(-1);
    expect(ps.warnings).toEqual([
      'pageArea A states <occur>, which simplexPaginated ignores (XFA 3.3 p. 296)',
      'pageSet states <occur>, which simplexPaginated ignores (XFA 3.3 p. 296)',
    ]);
  });
  it('refuses a relation XFA does not define', () => {
    const ps = tpl(`<pageSet relation="shuffled"><pageArea name="A">${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBe('pageSet relation="shuffled" is not one XFA defines (XFA 3.3 p. 798)');
  });
  it('still refuses a second or nested page set, citing 164g.22', () => {
    const ps = tpl(`<pageSet relation="simplexPaginated"><pageArea name="A">${MED}${CA}</pageArea><pageSet relation="duplexPaginated"><pageArea name="B">${MED}${CA}</pageArea></pageSet></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBe('more than one pageSet, or a nested one, is not paginated (164g.22)');
  });
  it('reads pageEven and pageOdd breaks without refusing them', () => {
    const t = tpl(`<pageSet><pageArea name="A">${MED}${CA}</pageArea></pageSet>`,
      '<subform name="s" w="100pt" h="10pt"><breakBefore targetType="pageOdd" startNew="1"/></subform>');
    expect(t.body!.root.children[0].breakBefore).toEqual({ targetType: 'pageOdd', startNew: true });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfatemplate-qualified.test.ts`
Expected: FAIL — qualifiers absent, `pageOdd` refused with `(164g.9)`, nested refusal cites `164g.9`.

- [ ] **Step 3: Add the types to `src/xfapage.ts`**

Add the three type aliases above `XfaContentArea`; add the three optional fields to `XfaPageAreaModel` (after `max`, each with a one-line doc comment citing p. 302-303); add `warnings?: string[]` to `XfaPageSet`; add `blank?: true` to `PaginatedPage` with the doc comment from **Interfaces**.

- [ ] **Step 4: Implement in `src/xfatemplate.ts`**

In `breakOf`, delete the two lines

```ts
  else if (targetType === 'pageEven' || targetType === 'pageOdd')
    refusal = `${label}: ${shown} is not implemented (164g.9)`;
```

and change the allowlist line to

```ts
  else if (!['auto', 'pageArea', 'contentArea', 'pageEven', 'pageOdd'].includes(targetType))
```

Add above `pageAreaOf`:

```ts
const QUALIFIERS = {
  pagePosition: ['any', 'first', 'last', 'rest', 'only'],
  oddOrEven: ['any', 'odd', 'even'],
  blankOrNotBlank: ['any', 'blank', 'notBlank'],
} as const;

/** A qualified page area's pagePosition, oddOrEven and blankOrNotBlank (XFA 3.3
 *  p. 302-303), or why one cannot be read. Absent reads as `any`. */
function qualifiersOf(el: XmlNode): Pick<XfaPageAreaModel, 'pagePosition' | 'oddOrEven' | 'blankOrNotBlank'> | string {
  const out: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(QUALIFIERS)) {
    const v = el.attrs.get(key);
    if (v === undefined) continue;
    if (!(allowed as readonly string[]).includes(v)) return `pageArea ${key}="${v}" is not one XFA defines (XFA 3.3 p. 302)`;
    out[key] = v;
  }
  return out as Pick<XfaPageAreaModel, 'pagePosition' | 'oddOrEven' | 'blankOrNotBlank'>;
}
```

Change `pageAreaOf(el)` to `pageAreaOf(el: XmlNode, qualified?: string, warnings: string[] = [])`. When `qualified` is set: skip the `layoutMax` and `minRefusal` checks, use `max = -1`, push `pageArea ${name ?? '(unnamed)'} states <occur>, which ${qualified} ignores (XFA 3.3 p. 296)` when a `<occur>` child exists, and spread `qualifiersOf(el)` (returning its string as the refusal). Unqualified: unchanged.

In `pageSetOf`, read the relation first and pass it through:

```ts
  const relation = ps.attrs.get('relation') ?? 'orderedOccurrence';
  const qualified = relation === 'simplexPaginated' || relation === 'duplexPaginated' ? relation : undefined;
  const warnings: string[] = [];
```

call `pageAreaOf(c, qualified, warnings)`; when `qualified`, replace the `layoutMax`/`minRefusal` page-set checks by `max = -1` plus the warning `pageSet states <occur>, which ${qualified} ignores (XFA 3.3 p. 296)` when `<occur>` exists (pushed AFTER the page-area warnings); when `relation` is none of the three, set `refusal = \`pageSet relation="${relation}" is not one XFA defines (XFA 3.3 p. 798)\``; change the nested message to cite `(164g.22)`; return `{ relation, max, pageAreas: areas, ...(warnings.length ? { warnings } : {}), ...refusal }`.

In `src/xfapage.ts` `paginate`, replace

```ts
  if (ps.relation !== 'orderedOccurrence')
    return refuseAll(`pageSet relation="${ps.relation}" is not implemented (164g.9)`);
```

with `warnings.push(...(ps.warnings ?? []));` (the relation is now one of three; Task 3 consumes it).

- [ ] **Step 5: Run the new tests, then the fence**

Run: `npx vitest run test/xfatemplate-qualified.test.ts test/xfapage.test.ts test/xfatemplate.test.ts`
Expected: PASS. If an existing `xfapage.test.ts` case asserted the old `(164g.9)` relation refusal, it is the ONE allowed edit: point it at `relation: 'shuffled'` refused in `xfatemplate` instead, and say so in the commit body.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/xfapage.ts src/xfatemplate.ts test/xfatemplate-qualified.test.ts
git commit -m "feat(164g.9): read page-area qualifiers and accept qualified relations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Qualified page selection

**Files:**
- Modify: `src/xfapage.ts`
- Create: `test/xfapage-qualified.test.ts`

**Interfaces:**
- Consumes: Task 2's types; `decisions.simplexEvenArea` from `adobe-qualified.json`.
- Produces:

```ts
export type PaginationMode = 'ordered' | 'simplex' | 'duplex';
export interface PageState { position: 'first' | 'rest'; parity: 'odd' | 'even'; blank: boolean }
/** The one owner of qualified matching: the first page area, in document order,
 *  whose qualifiers fit `s` (XFA 3.3 p. 302-304), or undefined. */
export function chooseArea(areas: readonly XfaPageAreaModel[], s: PageState, mode: 'simplex' | 'duplex'): number | undefined;
// Paginator gains: constructor(ps, maxOf, heights, mode: PaginationMode, force?: ReadonlyMap<number, number>)
// Paginator.parityOf(index: number): 'odd' | 'even'
```

- [ ] **Step 1: Write the failing tests**

`test/xfapage-qualified.test.ts` (helpers copied from `test/xfapage.test.ts`, extended with qualifiers and a blank marker):

```ts
import { describe, it, expect } from 'vitest';
import {
  paginate, chooseArea,
  type XfaBody, type XfaPageAreaModel, type XfaContentArea, type XfaHeight, type PageState,
} from '../src/xfapage.js';
import type { LayoutNode, XfaBreak } from '../src/xfaflow.js';

const kid = (label: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], ...extra });
const ca = (h: number): XfaContentArea => ({
  node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: { w: '500pt', h: `${String(h)}pt` }, children: [] },
});
const area = (name: string, extra: Partial<XfaPageAreaModel> = {}, cas: XfaContentArea[] = [ca(100)]): XfaPageAreaModel =>
  ({ name, max: -1, contentAreas: cas, ...extra });
const body = (relation: string, pageAreas: XfaPageAreaModel[], kids: LayoutNode[], rootBreak?: XfaBreak): XfaBody => ({
  root: { kind: 'subform', label: 'root[0]', layout: 'tb', geom: {}, children: kids, ...(rootBreak ? { breakBefore: rootBreak } : {}) },
  pageSet: { relation, max: -1, pageAreas },
});
const height: XfaHeight = (n) => ({ h: Number((n.geom.h ?? '0pt').replace('pt', '')), past: n.label.endsWith('!') });
/** Page-area names per page; a blank page is suffixed '*'. */
const seq = (b: XfaBody) => paginate(b, height).pages.map((p) => `${b.pageSet!.pageAreas[p.pageArea].name!}${p.blank ? '*' : ''}`);
const refusals = (b: XfaBody) => [...paginate(b, height).refused].map(([n, why]) => [n.label, why]);
const three = () => [kid('a', 100), kid('b', 100), kid('c', 100)];
const S = 'simplexPaginated';
const D = 'duplexPaginated';
const st = (position: 'first' | 'rest', parity: 'odd' | 'even', blank = false): PageState => ({ position, parity, blank });

describe('chooseArea (XFA 3.3 p. 302-304)', () => {
  it('takes the first page area in document order whose pagePosition fits', () => {
    const areas = [area('A', { pagePosition: 'rest' }), area('B', { pagePosition: 'first' }), area('C')];
    expect(chooseArea(areas, st('first', 'odd'), 'simplex')).toBe(1);
    expect(chooseArea(areas, st('rest', 'odd'), 'simplex')).toBe(0);
  });
  it('never matches last or only in normal layout (p. 308)', () => {
    const areas = [area('L', { pagePosition: 'last' }), area('O', { pagePosition: 'only' })];
    expect(chooseArea(areas, st('first', 'odd'), 'duplex')).toBeUndefined();
    expect(chooseArea(areas, st('rest', 'even'), 'duplex')).toBeUndefined();
  });
  it('matches oddOrEven against the parity under duplex', () => {
    const areas = [area('O', { oddOrEven: 'odd' }), area('E', { oddOrEven: 'even' })];
    expect(chooseArea(areas, st('rest', 'even'), 'duplex')).toBe(1);
    expect(chooseArea(areas, st('rest', 'odd'), 'duplex')).toBe(0);
  });
  it('matches blankOrNotBlank against the reason under duplex (p. 303)', () => {
    const areas = [area('N', { blankOrNotBlank: 'notBlank' }), area('B', { blankOrNotBlank: 'blank' })];
    expect(chooseArea(areas, st('rest', 'odd', true), 'duplex')).toBe(1);
    expect(chooseArea(areas, st('rest', 'odd', false), 'duplex')).toBe(0);
  });
  it('ignores blankOrNotBlank under simplex (p. 798)', () => {
    expect(chooseArea([area('B', { blankOrNotBlank: 'blank' })], st('rest', 'odd', false), 'simplex')).toBe(0);
  });
  it('reads oddOrEven under simplex as Adobe does (probe q3)', () => {
    const areas = [area('E', { oddOrEven: 'even' }), area('C')];
    // decisions.simplexEvenArea: 'never' -> 1 ; 'matches' -> 0
    expect(chooseArea(areas, st('rest', 'odd'), 'simplex')).toBe(SIMPLEX_EVEN_WANT);
  });
});
```

Set `const SIMPLEX_EVEN_WANT = 1;` at the top if `decisions.simplexEvenArea` is `'never'`, `0` if `'matches'`.

```ts
describe('paginate: qualified selection', () => {
  it('uses the first-qualified area on page 1, then rest (Example 8.25)', () => {
    expect(seq(body(S, [area('A', { pagePosition: 'rest' }), area('B', { pagePosition: 'first' })], three()))).toEqual(['B', 'A', 'A']);
  });
  it('alternates odd and even under duplex (Example 8.26)', () => {
    const areas = [area('A', { oddOrEven: 'odd', pagePosition: 'rest' }), area('B', { oddOrEven: 'even', pagePosition: 'rest' }), area('C', { pagePosition: 'first' })];
    expect(seq(body(D, areas, [...three(), kid('d', 100)]))).toEqual(['C', 'B', 'A', 'B']);
  });
  it('ignores occur max under qualified pagination (p. 296, probe q14)', () => {
    expect(seq(body(S, [area('A', { max: 1 })], three()))).toEqual(['A', 'A', 'A']);
  });
  it('refuses every child, naming the state, when no page area matches (p. 304, probe q10)', () => {
    expect(refusals(body(S, [area('A', { pagePosition: 'rest' })], [kid('a', 50)]))).toEqual([
      ['a', 'no pageArea matches position=first parity=odd blank=false (XFA 3.3 p. 304)'],
    ]);
  });
  it('starts on a break target whatever its qualifiers (p. 296, 310)', () => {
    const b = body(S, [area('A', { pagePosition: 'rest' }), area('B', { pagePosition: 'first' })],
      [kid('a', 100)], { targetType: 'pageArea', target: 'A', startNew: false });
    expect(seq(b)).toEqual(['A']);
  });
  it('emits a qualified boilerplate cover page, then continues (p. 296)', () => {
    expect(seq(body(S, [area('C', { pagePosition: 'first' }, []), area('A', { pagePosition: 'rest' })], [kid('a', 100)]))).toEqual(['C', 'A']);
  });
  it('refuses a boilerplate page area that would repeat forever', () => {
    const r = refusals(body(S, [area('B', { pagePosition: 'first' }), area('X', { pagePosition: 'rest' }, [])], [kid('a', 100), kid('b', 100)]));
    expect(r[0]).toEqual(['b', 'pageArea X has no contentArea and qualifies for every later page, so it would repeat without end (XFA 3.3 p. 296)']);
  });
  it('leaves the ordered relation exactly as it was', () => {
    expect(seq(body('orderedOccurrence', [area('A', { pagePosition: 'rest', max: 1 }), area('B')], three()))).toEqual(['A', 'B', 'B']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfapage-qualified.test.ts`
Expected: FAIL — `chooseArea` is not exported.

- [ ] **Step 3: Implement `chooseArea` and the qualified mode**

In `src/xfapage.ts`, below the constants, add (set `SIMPLEX_PARITY` from `decisions.simplexEvenArea`: `'never'` → `true`, `'matches'` → `false`):

```ts
export type PaginationMode = 'ordered' | 'simplex' | 'duplex';
export interface PageState { position: 'first' | 'rest'; parity: 'odd' | 'even'; blank: boolean }

/** Probe q3: under simplex, Adobe [never | does] match an oddOrEven="even" page
 *  area. XFA 3.3 contradicts itself here -- p. 303-304 keep simplex in the odd
 *  state, p. 798 ignores oddOrEven -- and Adobe is the oracle. */
const SIMPLEX_PARITY = true;

export function chooseArea(areas: readonly XfaPageAreaModel[], s: PageState, mode: 'simplex' | 'duplex'): number | undefined {
  const i = areas.findIndex((pa) => {
    const pos = pa.pagePosition ?? 'any';
    if (pos !== 'any' && pos !== s.position) return false;
    if (mode === 'duplex' || SIMPLEX_PARITY) {
      const oe = pa.oddOrEven ?? 'any';
      if (oe !== 'any' && oe !== s.parity) return false;
    }
    if (mode === 'duplex') {
      const b = pa.blankOrNotBlank ?? 'any';
      if (b !== 'any' && (b === 'blank') !== s.blank) return false;
    }
    return true;
  });
  return i < 0 ? undefined : i;
}
```

(Write the doc comment's `[never | does]` as the one word q3 settled.)

Extend `Paginator`:

```ts
  constructor(
    private readonly ps: XfaPageSet, private readonly maxOf: readonly number[],
    private readonly heights: readonly number[][],
    readonly mode: PaginationMode = 'ordered',
    private readonly force?: ReadonlyMap<number, number>,
  ) { this.uses = ps.pageAreas.map(() => 0); }

  /** Page `i`'s parity (p. 303): the physical surface count starts at zero, so
   *  page 1 is odd; under simplex every page is a front, hence odd. */
  parityOf(i: number): 'odd' | 'even' {
    if (this.mode === 'simplex') return 'odd';
    return i % 2 === 0 ? 'odd' : 'even';
  }

  /** Consecutive boilerplate pages opened by `qualifiedNext`. */
  private boiler = 0;

  /** The next page under a qualified strategy (p. 302-304): the forced page
   *  area for a termination rerun, else `chooseArea` for this page's state. */
  qualifiedNext(blank = false): string | undefined {
    const i = this.pages.length;
    const s: PageState = { position: i === 0 ? 'first' : 'rest', parity: this.parityOf(i), blank };
    const a = this.force?.get(i) ?? chooseArea(this.ps.pageAreas, s, this.mode as 'simplex' | 'duplex');
    if (a === undefined)
      return `no pageArea matches position=${s.position} parity=${s.parity} blank=${String(s.blank)} (XFA 3.3 p. 304)`;
    if (this.ps.pageAreas[a].contentAreas.length === 0 && !blank) {
      // p. 296: boilerplate is emitted and the advance continues; with no
      // occurrence limits a rest/any boilerplate area would match forever.
      if (++this.boiler > this.ps.pageAreas.length)
        return `pageArea ${this.ps.pageAreas[a].name ?? String(a)} has no contentArea and qualifies for every later page, so it would repeat without end (XFA 3.3 p. 296)`;
    } else this.boiler = 0;
    return this.open(a, blank);
  }
```

Change `open` to `private open(a: number, blank = false)`: push `{ pageArea: a, pageSet: this.set, contentAreas: [], ...(blank ? { blank: true as const } : {}) }`, and return `blank || this.ps.pageAreas[a].contentAreas.length > 0 ? undefined : this.nextPage()` (a blank page holds nothing by design and is never advanced past by itself; the caller opens the content page).

At the top of `nextPage()` add `if (this.mode !== 'ordered') return this.qualifiedNext();`.

At the top of `toPageArea(a)` add:

```ts
    if (this.mode !== 'ordered') return this.open(a);
```

(Task 4 extends this with the parity filler and the blank-target refusal.)

In `paginate`, compute the mode after the existing checks and pass it:

```ts
  const mode: PaginationMode = ps.relation === 'simplexPaginated' ? 'simplex'
    : ps.relation === 'duplexPaginated' ? 'duplex' : 'ordered';
  const p = new Paginator(ps, maxOf, heights, mode, force);
```

and give `paginate` the parameter `force?: ReadonlyMap<number, number>` after `boxes`. The `maxOf` boilerplate warning stays ordered-only: wrap it in `mode === 'ordered' ? … : ps.pageAreas.map(() => -1)`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/xfapage-qualified.test.ts test/xfapage.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (do not commit the mutations)**

Apply each, run `npx vitest run test/xfapage-qualified.test.ts`, confirm FAIL, revert with `git checkout src/xfapage.ts` after saving the real change (or reverse the edit by hand):
1. `chooseArea`: drop the `pagePosition` test.
2. `chooseArea`: drop the duplex `blankOrNotBlank` test.
3. `parityOf`: return `i % 2 === 0 ? 'even' : 'odd'`.
4. `qualifiedNext`: remove the `boiler` bound (run with `--testTimeout=5000`; a HANG counts as red — kill orphaned vitest workers afterwards).
5. `nextPage`: remove the qualified branch.

Before running each, confirm with `git diff` that the mutation applied.

- [ ] **Step 6: Commit**

```bash
git add src/xfapage.ts test/xfapage-qualified.test.ts
git commit -m "feat(164g.9): qualified page selection (pagePosition, oddOrEven, blankOrNotBlank)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: pageEven/pageOdd breaks, parity fillers, break targets

**Files:**
- Modify: `src/xfapage.ts` (`Paginator.apply`, `Paginator.toPageArea`)
- Modify: `test/xfapage-qualified.test.ts`

**Interfaces:**
- Consumes: `qualifiedNext(blank)`, `parityOf(i)`, `decisions.simplexPageEven` (q12).
- Produces: `Paginator.toParity(want: 'odd' | 'even', startNew: boolean): string | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `test/xfapage-qualified.test.ts`:

```ts
const brk = (targetType: string, extra: Partial<XfaBreak> = {}): XfaBreak => ({ targetType, startNew: false, ...extra });

describe('paginate: pageEven and pageOdd breaks (XFA 3.3 p. 296, 305)', () => {
  it('under ordered pagination inserts a blank page to reach odd (probe q11)', () => {
    const b = body('orderedOccurrence', [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageOdd', { startNew: true }) })]);
    expect(seq(b)).toEqual(['A', 'A*', 'A']);
  });
  it('under ordered pagination reaches the next even page without a filler', () => {
    const b = body('orderedOccurrence', [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageEven') })]);
    expect(seq(b)).toEqual(['A', 'A']);
  });
  it('stays on a page of the right parity when startNew is 0', () => {
    const b = body('orderedOccurrence', [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageOdd') })]);
    expect(seq(b)).toEqual(['A']);
  });
  it('under duplex takes the filler from a blank-qualified area (probe q13)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('A', { pagePosition: 'rest', blankOrNotBlank: 'notBlank' }), area('F', { pagePosition: 'rest', blankOrNotBlank: 'blank' })];
    expect(seq(body(D, areas, [kid('a', 20), kid('b', 20, { breakBefore: brk('pageOdd', { startNew: true }) })])).slice(0, 3)).toEqual(['C', 'F*', 'A']);
  });
  it('under duplex breakAfter pageOdd fills an even page (Example 8.27, probe q4)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('A', { oddOrEven: 'odd', pagePosition: 'rest' }), area('B', { oddOrEven: 'even', pagePosition: 'rest' })];
    const b = body(D, areas, [kid('o', 100), kid('y0', 100), kid('y1', 100, { breakAfter: brk('pageOdd', { startNew: true }) }), kid('z', 100)]);
    expect(seq(b).slice(0, 5)).toEqual(['C', 'B', 'A', 'B*', 'A']);
  });
  it('under duplex inserts a filler before a break target of the other parity (p. 305)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('O', { oddOrEven: 'odd', pagePosition: 'rest' }), area('E', { oddOrEven: 'even', pagePosition: 'rest' })];
    const b = body(D, areas, [kid('a', 20), kid('b', 20, { breakBefore: brk('pageArea', { target: 'O' }) })]);
    expect(seq(b).slice(0, 3)).toEqual(['C', 'E*', 'O']);
  });
  it('refuses a break to a page area qualified blank (p. 310)', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('F', { pagePosition: 'rest', blankOrNotBlank: 'blank' })];
    expect(refusals(body(D, areas, [kid('a', 20), kid('b', 20, { breakBefore: brk('pageArea', { target: 'F' }) })]))).toEqual([
      ['b', 'break target "F" is a pageArea qualified blankOrNotBlank="blank", which no break may name (XFA 3.3 p. 310)'],
    ]);
  });
  it('treats pageEven under simplex as Adobe does (probe q12)', () => {
    const b = body(S, [area('A')], [kid('a', 20), kid('b', 20, { breakBefore: brk('pageEven') })]);
    expect(seq(b)).toEqual(SIMPLEX_PAGE_EVEN_WANT);
  });
});
```

Set at the top: `const SIMPLEX_PAGE_EVEN_WANT = …;` — `['A', 'A']` for `newPage`, `['A', 'A*', 'A']` for `filler`, `['A']` for `stays`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfapage-qualified.test.ts`
Expected: FAIL — `a break with targetType="pageOdd" is not implemented`.

- [ ] **Step 3: Implement**

Add to `Paginator` (set `SIMPLEX_PAGE_EVEN` beside `SIMPLEX_PARITY` from q12, with a one-line comment citing the probe):

```ts
  /** `pageEven`/`pageOdd` (p. 296, 305): the next page of that parity; a page
   *  of the other parity in between is a blank filler. Under simplex every page
   *  is odd, so pageEven follows probe q12. */
  toParity(want: 'odd' | 'even', startNew: boolean): string | undefined {
    const cur = this.pages.length - 1;
    if (!startNew && cur >= 0 && this.parityOf(cur) === want) return undefined;
    if (this.mode === 'simplex' && want === 'even') {
      if (SIMPLEX_PAGE_EVEN === 'stays') return undefined;
      if (SIMPLEX_PAGE_EVEN === 'filler') { const f = this.qualifiedNext(true); if (f !== undefined) return f; }
      return this.qualifiedNext();
    }
    if (this.parityOf(cur + 1) !== want) {
      const f = this.mode === 'ordered' ? this.blankOrdered() : this.qualifiedNext(true);
      if (f !== undefined) return f;
    }
    return this.nextPage();
  }

  /** An ordered filler: the natural next page, marked blank and holding nothing. */
  private blankOrdered(): string | undefined {
    const r = this.nextPage();
    if (r === undefined) this.pages[this.pages.length - 1].blank = true;
    return r;
  }
```

`blank` on `PaginatedPage` must then be writable: declare it `blank?: true` (not readonly) — it already is.

In `apply`, replace the targetType check with:

```ts
    if (b.targetType === 'pageEven' || b.targetType === 'pageOdd')
      return this.toParity(b.targetType === 'pageEven' ? 'even' : 'odd', b.startNew);
    if (b.targetType !== 'pageArea' && b.targetType !== 'contentArea')
      return `a break with targetType="${b.targetType}" is not implemented`;
```

Replace `toPageArea`'s qualified branch with:

```ts
    if (this.mode !== 'ordered') {
      const pa = this.ps.pageAreas[a];
      if (pa.blankOrNotBlank === 'blank')
        return `break target "${pa.name ?? pa.id ?? String(a)}" is a pageArea qualified blankOrNotBlank="blank", which no break may name (XFA 3.3 p. 310)`;
      // p. 305: a target of the other parity is reached through a blank filler.
      if (this.mode === 'duplex' && (pa.oddOrEven ?? 'any') !== 'any' && pa.oddOrEven !== this.parityOf(this.pages.length)) {
        const f = this.qualifiedNext(true);
        if (f !== undefined) return f;
      }
      return this.open(a);
    }
```

The same blank-target refusal applies in `start()`: before `this.open(want.area)`, when `this.mode !== 'ordered'` and that area is qualified `blank`, return the same message.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/xfapage-qualified.test.ts test/xfapage.test.ts test/xfatemplate-qualified.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Each must redden `test/xfapage-qualified.test.ts` (confirm the mutation applied with `git diff` first). The `.slice(0, 3)` in the duplex cases keeps them independent of Task 5's trailing back page:
1. `toParity`: drop the `!startNew` early return.
2. `toParity`: never insert the filler.
3. `blankOrdered`: do not mark the page blank.
4. `toPageArea`: drop the duplex filler.
5. `toPageArea`: drop the blank-target refusal.

- [ ] **Step 6: Commit**

```bash
git add src/xfapage.ts test/xfapage-qualified.test.ts
git commit -m "feat(164g.9): pageEven/pageOdd breaks and duplex parity fillers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Termination processing (`last`, `only`) and the duplex back page

**Files:**
- Modify: `src/xfapage.ts` (`paginate`, new `terminate`)
- Modify: `test/xfapage-qualified.test.ts`

**Interfaces:**
- Consumes: `paginate(body, height, boxes?, force?)`, `chooseArea`, `decisions.duplexTrailingBack` (q9).
- Produces: nothing new public; `paginate`'s qualified result now includes termination.

- [ ] **Step 1: Write the failing tests**

```ts
describe('paginate: termination (XFA 3.3 p. 306-308)', () => {
  it('redoes the final page on the last area when it fits (Example 8.28, probe q5)', () => {
    expect(seq(body(S, [area('A'), area('B', { pagePosition: 'last' })], three()))).toEqual(['A', 'A', 'B']);
  });
  it('prefers only over first for a single page (Example 8.29, probe q6)', () => {
    const areas = [area('A', { pagePosition: 'first' }), area('B'), area('C', { pagePosition: 'last' }), area('D', { pagePosition: 'only' })];
    expect(seq(body(S, areas, [kid('a', 60)]))).toEqual(['D']);
  });
  it('uses first, rest and last across several pages (probe q7)', () => {
    const areas = [area('A', { pagePosition: 'first' }), area('B'), area('C', { pagePosition: 'last' }), area('D', { pagePosition: 'only' })];
    expect(seq(body(S, areas, three()))).toEqual(['A', 'B', 'C']);
  });
  it('appends a blank last page when the content does not fit it (probe q8)', () => {
    expect(seq(body(S, [area('A'), area('B', { pagePosition: 'last' }, [ca(50)])], three()))).toEqual(['A', 'A', 'A', 'B*']);
  });
  it('appends a blank last page when the content-area counts differ (p. 306)', () => {
    expect(seq(body(S, [area('A'), area('B', { pagePosition: 'last' }, [ca(100), ca(100)])], three()))).toEqual(['A', 'A', 'A', 'B*']);
  });
  it('does not redo a final page qualified first (p. 306)', () => {
    expect(seq(body(S, [area('A', { pagePosition: 'first' }), area('B'), area('L', { pagePosition: 'last' })], [kid('a', 60)]))).toEqual(['A', 'L*']);
  });
  it('keeps the page when the only redo does not fit (p. 307)', () => {
    expect(seq(body(S, [area('A'), area('O', { pagePosition: 'only' }, [ca(50)])], [kid('a', 60)]))).toEqual(['A']);
  });
  it('does not redo a final blank filler page, and still appends last', () => {
    const areas = [area('C', { pagePosition: 'first' }), area('A', { pagePosition: 'rest' }), area('L', { pagePosition: 'last' })];
    const b = body(S, areas, [kid('a', 20, { breakAfter: brk('pageArea', { startNew: true }) })]);
    // the breakAfter opens page 2 for nothing; that page holds no content and is the final one
    expect(seq(b)).toEqual(['C', 'A', 'L*']);
  });
  it('ends a duplex document on a back page as Adobe does (probe q9)', () => {
    const areas = [area('A', { oddOrEven: 'odd' }), area('B', { oddOrEven: 'even' })];
    expect(seq(body(D, areas, three()))).toEqual(DUPLEX_END_WANT);
  });
});
```

Set at the top: `const DUPLEX_END_WANT = …;` — `['A', 'B', 'A', 'B*']` if `duplexTrailingBack` is `true`, else `['A', 'B', 'A']`.

Note on the blank-filler case: the page opened by a trailing `breakAfter` holds nothing but is NOT marked blank by `nextPage`. Implement termination's "final page holds content" test as `page.blank || page.contentAreas.length === 0`, which covers both.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfapage-qualified.test.ts -t termination`
Expected: FAIL.

- [ ] **Step 3: Implement**

Rename the body of today's `paginate` to `paginateOnce(body, height, boxes?, force?)` (unexported) and add:

```ts
/** Paginate `body` (spec section 2); a qualified page set then runs
 *  termination processing (164g.9). */
export function paginate(
  body: XfaBody, height: XfaHeight, boxes?: XfaChildBoxes, force?: ReadonlyMap<number, number>,
): Pagination {
  const first = paginateOnce(body, height, boxes, force);
  const rel = body.pageSet?.relation;
  if (force || (rel !== 'simplexPaginated' && rel !== 'duplexPaginated')) return first;
  return terminate(body, height, boxes, first, rel === 'duplexPaginated' ? 'duplex' : 'simplex');
}

/** Termination processing (XFA 3.3 p. 306-308): the final page is laid out
 *  again on the page area qualified `only` (a single page) or `last`, by
 *  rerunning pagination with that one page forced. A rerun is accepted only if
 *  it yields as many pages and refuses nothing the first run placed -- i.e. the
 *  content fits. A `last` that does not fit is appended blank; an `only` that
 *  does not fit leaves the page as it was. */
function terminate(
  body: XfaBody, height: XfaHeight, boxes: XfaChildBoxes | undefined, first: Pagination, mode: 'simplex' | 'duplex',
): Pagination {
  const areas = body.pageSet!.pageAreas;
  const n = first.pages.length;
  if (n === 0) return first;
  const k = n - 1;
  const fin = first.pages[k];
  const holds = !fin.blank && fin.contentAreas.length > 0;
  const redo = (a: number): Pagination | undefined => {
    const r = paginateOnce(body, height, boxes, new Map([[k, a]]));
    const same = r.pages.length === n && r.refused.size === first.refused.size
      && [...first.refused.keys()].every((x) => r.refused.has(x));
    return same ? r : undefined;
  };
  const find = (q: XfaPagePosition): number => areas.findIndex((pa) => pa.pagePosition === q);
  let out = first;
  const only = find('only');
  const last = find('last');
  if (n === 1 && only >= 0 && holds) out = redo(only) ?? first;
  else if (last >= 0) {
    const cur = areas[fin.pageArea];
    const ok = holds && areas[last].contentAreas.length === cur.contentAreas.length
      && cur.pagePosition !== 'first' && cur.pagePosition !== 'last';
    const r = ok ? redo(last) : undefined;
    out = r ?? { ...first, pages: [...first.pages, { pageArea: last, pageSet: 0, contentAreas: [], blank: true }] };
  }
  return mode === 'duplex' && DUPLEX_TRAILING_BACK ? backPage(areas, out) : out;
}

/** Probe q9: Adobe [does | does not] end a duplex document on a back surface.
 *  Example 8.27 (p. 306) "renders another blank page for the back of the sheet". */
const DUPLEX_TRAILING_BACK = true;

/** A blank back page after a final odd page; no matching area is a warning,
 *  since everything is already placed. */
function backPage(areas: readonly XfaPageAreaModel[], pg: Pagination): Pagination {
  if (pg.pages.length % 2 === 0) return pg;
  const a = chooseArea(areas, { position: 'rest', parity: 'even', blank: true }, 'duplex');
  if (a === undefined)
    return { ...pg, warnings: [...pg.warnings, 'no pageArea matches the blank back page that ends a duplex document (XFA 3.3 p. 306)'] };
  return { ...pg, pages: [...pg.pages, { pageArea: a, pageSet: 0, contentAreas: [], blank: true }] };
}
```

Set `DUPLEX_TRAILING_BACK` from q9 (and its comment's `[does | does not]` to the one settled answer). Update the module doc comment's first paragraph: "under `orderedOccurrence`, `simplexPaginated` and `duplexPaginated`".

- [ ] **Step 4: Run tests and the fence**

Run: `npx vitest run test/xfapage-qualified.test.ts test/xfapage.test.ts test/xfaflow.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Each must redden (confirm each applied with `git diff`):
1. `terminate`: drop the `n === 1` condition on `only`.
2. `terminate`: drop the content-area-count precondition.
3. `terminate`: drop the `first`/`last` precondition.
4. `redo`: accept on page count alone (drop the refused comparison). This one may stay GREEN — no fixture is known where a forced page refuses with the same page count. If green, record it in Task 7's CLAUDE.md entry as a guard held by reasoning, not by the suite.
5. `terminate`: append nothing when a `last` redo fails.
6. `backPage`: always return `pg`.

- [ ] **Step 6: Commit**

```bash
git add src/xfapage.ts test/xfapage-qualified.test.ts
git commit -m "feat(164g.9): last/only termination and the duplex back page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Convert the probes, compare with Adobe

**Files:**
- Create: `test/xfa-adobe-qualified-oracle.test.ts`
- Modify (only if a step below fails for a converter reason): `src/xfaconvert.ts`

**Interfaces:**
- Consumes: `QUALIFIED_PROBES`, `qualifiedGoldens()`, `loadAdobeProbe(name)` (Task 1); `Document.Open`, `ConvertXfaToAcroForm`, `Page.GetText()`.

- [ ] **Step 1: Write the oracle test**

```ts
// test/xfa-adobe-qualified-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfObject } from '../src/types.js';
import { QUALIFIED_PROBES, qualifiedGoldens, loadAdobeProbe } from './helpers/xfa-adobe.js';

/**
 * The Adobe Reader oracle for qualified pagination (164g.9): each probe in
 * test/fixtures/xfa-adobe/ converted from its template, and the page area of
 * every created page (read back from the AREA-X marker its master chrome
 * paints) and the page of every field compared with what Reader 26.1 reported.
 *
 * Its ceiling: one producer, one version, hand transcription, on-screen layout.
 */
const g = qualifiedGoldens();

for (const name of QUALIFIED_PROBES) {
  const probe = g.probes[name];
  describe(`Adobe qualified oracle: ${name}`, () => {
    const src = Document.Open(loadAdobeProbe(name));
    const report = src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());

    if (probe.expect === 'match') {
      it("lays out Adobe's page areas, page by page", () => {
        const got = doc.Pages.map((pg) => /AREA-(\w+)/.exec(pg.GetText())?.[1] ?? '?');
        expect(got).toEqual(probe.areas);
      });
      it("puts every field on Adobe's page", () => {
        const pageOf = new Map(doc.Form.Fields.map((fld) => [fld.FullName, 1 + doc.Pages.findIndex((pg) =>
          ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[]).some((a) => doc.resolve(a) === fld.Dict))]));
        const want = Object.fromEntries(Object.keys(probe.fields).map((f) => [f, pageOf.get(f)]));
        expect(want).toEqual(probe.fields);
      });
    } else {
      it(`refuses the content, citing ${String(probe.reason)}`, () => {
        const hits = report.skipped.filter((s) => s.what === 'field' && s.name?.startsWith('form1[0].item'));
        expect(hits.length).toBeGreaterThan(0);
        for (const h of hits) expect(h.reason).toContain(String(probe.reason));
      });
    }
  });
}
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/xfa-adobe-qualified-oracle.test.ts`
Expected: PASS for every probe.

If the AREA marker reads `?` on a created page: confirm with `report.chromePages` and `report.skipped` (`what: 'chrome'`) whether the marker draw was refused (font) rather than the page missing — the probes state `typeface="Arial"`, which the closed table maps to Helvetica, so it should paint. If a blank filler page is missing from `doc.Pages`, inspect `xfaconvert.ts` lines ~257-300 (`newPages` from `laid.pages`) and ~872 (the page-replacement gate): fix there so EVERY laid-out page, blank included, is created, and add a case to `test/xfaconvert-pages.test.ts` naming the blank-page rule. Any other mismatch is a pagination bug: go back to the task that owns the rule.

- [ ] **Step 3: Full fence**

Run: `npm run typecheck && npm test`
Expected: both green; `test/xfa-real.test.ts`, `test/xfa-dynamic-oracle.test.ts`, `test/xfa-master-oracle.test.ts`, `test/xfa-adobe-oracle.test.ts`, `test/xfapage.test.ts` unedited.

- [ ] **Step 4: Commit**

```bash
git add test/xfa-adobe-qualified-oracle.test.ts src/xfaconvert.ts test/xfaconvert-pages.test.ts
git commit -m "test(164g.9): qualified pagination against Adobe Reader's layout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Omit the files you did not change from `git add`.)

---

### Task 7: Docs, mutation record, close

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` → `### Added`, first entry, in the repo's style (bold lead-in, prose, what was measured, issue id). Fill the bracketed words from `decisions`:

```markdown
- **`ConvertXfaToAcroForm` paginates simplex and duplex XFA page sets.** A `<pageSet relation="simplexPaginated">` or `"duplexPaginated"` was refused outright, so such a form converted to data only. Each page now takes the first page area, in document order, whose `pagePosition`, `oddOrEven` and `blankOrNotBlank` fit it (XFA 3.3 p. 302-304); `pageEven` and `pageOdd` breaks reach the right side of the sheet, under every relation, through blank filler pages; and at the end the final page is laid out again on a page area marked `only` or `last` when it fits there, or a blank `last` page is appended when it does not. `occur` is ignored on such page sets, as the specification says. Where XFA 3.3 contradicts itself or says nothing -- whether simplex ever uses an even-only page area, what `pageEven` means in simplex, whether a duplex document ends on a back page -- Adobe Acrobat Reader 26.1 decided, through 14 probe forms whose page areas Reader reported (`test/fixtures/xfa-adobe/`): every page and field of the [N] probes we lay out lands on Reader's page area and page. Nested page sets and sibling page sets chosen by printer type are still refused by name (164g.22). (aspose-pdf-foss-for-ts-164g.9)
```

- [ ] **Step 2: CLAUDE.md**

In the `xfapage.ts` entry (search `- **xfapage.ts** — XFA pagination`), change "under `orderedOccurrence`" to "under `orderedOccurrence` and, since `164g.9`, the qualified `simplexPaginated`/`duplexPaginated`", and append:

```markdown
  **Invariant (`164g.9`):** qualified page choice has ONE owner, `chooseArea`
  -- the first page area in document order whose `pagePosition`, `oddOrEven`
  and `blankOrNotBlank` fit the page's state (p. 302-304) -- and the ordered
  path is untouched, which is what keeps every pre-164g.9 oracle unedited.
  `last` and `only` never match in normal layout; termination alone uses them.
  `occur` is ignored on a qualified page set and page area, with a warning.
  **Invariant:** parity is the PHYSICAL page index's, page 1 odd (p. 303); a
  filler page is `blank: true`, holds nothing, and is created with its master
  chrome. `pageEven`/`pageOdd` apply under the ordered relation too (p. 296).
  **Invariant:** termination RERUNS pagination with the final page forced
  (`paginate`'s `force`), never rewinds one: a rerun reuses 164g.8 and
  164g.11 splitting untouched. Accepted only with the same page count and no
  new refusal.
  **Note, Adobe overruled the spec where it is silent or contradicts itself**
  (probes q3, q9, q12 in `test/fixtures/xfa-adobe/adobe-qualified.json`):
  simplex [never matches | matches] an even-only area; simplex `pageEven`
  [is a new page | inserts a filler | stays]; a duplex document [ends | does
  not end] on a back page.
  **Note, measured:** [K] of [M] mutations redden. [Name each green one and
  why -- in particular whether the rerun's refused-set comparison is held by
  a case or by reasoning alone.]
```

Fill every bracket from Tasks 1, 3, 4, 5 results — no bracket may remain.

Add the qualified probes to the `fixtures/xfa-adobe/` row of the fixtures table: append "Since `164g.9`, 14 qualified-pagination probes (q1-q14) report each page's page area; they settled three rules XFA 3.3 leaves open."

- [ ] **Step 3: README**

In the XFA paragraph (search `a qualified pagination strategy (\`simplexPaginated\`/\`duplexPaginated\`)`), delete that item from the refusal list, change "pages are laid out as XFA's ordered pagination produces them" to "pages are laid out as XFA's ordered, simplex or duplex pagination produces them (a nested page set, or sibling page sets chosen by printer type, is refused)".

- [ ] **Step 4: Verify docs and sweep**

Run: `npx vitest run test/readme-api.test.ts && npm test`
Expected: green. Run the module sweep from CLAUDE.md:

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

Expected: empty.

- [ ] **Step 5: Commit, close, push**

```bash
git add CHANGELOG.md CLAUDE.md README.md
git commit -m "docs(164g.9): CHANGELOG, CLAUDE.md, README for qualified pagination

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-164g.9
git pull --rebase && git push && git status
```

Expected: `git status` reports up to date with origin.
