# XFA Master-Page Fields Implementation Plan (`d3mq` part 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ConvertXfaToAcroForm` creates each field on an XFA master page (`<pageArea>`) once per page that is an instance of its page area, placed from the page origin and named as Adobe names that instance.

**Architecture:** The template walk gives each named `<pageArea>` a positioned layout root at the page origin, laid out by `xfaflow.ts`'s `layoutPage` -- the one layout engine. Pagination already says which page area each page instantiates; it now also says which page-set instance. The converter lays each page area's master root out once and emits instance n of each master field on the n-th page of that page area, through the same widget-rect path body fields use.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime dependencies. pdf.js 6.3.289 in headless Chrome for one oracle generator (not run by `npm test`).

**Spec:** `docs/superpowers/specs/2026-10-12-xfa-master-page-fields-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins in `src/`.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- `buildXfaPlan` allocates nothing: a refused conversion leaves the document byte-identical.
- Master fields stay OUT of `XfaTemplate.fields`: body layout, measuring and data binding never see them.
- A master field binds ONLY through `<bind match="dataRef" ref>` (XFA 3.3 p. 271); `match="global"` is a warning naming `yy09`.
- A master field with no geometry creates nothing and is reported ONCE (spec decision 2). A field refused for its own UI KIND is reported once per instance, under the instance's name, when instances exist.
- A second page-set instance and a master `<exclGroup>` are refused (spec decisions 4, 5).
- Run `npm run typecheck` and `npm test` before closing; both green.
- CHANGELOG entry under `## [Unreleased]` in the same commit as the user-visible change (Task 6).

## Review Focus

1. **A dynamic document whose BODY placed nothing**: a master instance alone must not replace Designer's placeholder pages -- that would cut a 3-page form to one page carrying only a CUI marking. Expect: placeholder kept, master instances dropped and reported (Task 3).
2. **Converting a hybrid that already carries Adobe's master widgets** (no strip): every instance reconciles; nothing is created twice (Task 4).
3. **A page area no laid-out page uses**: its master fields create nothing and are reported once, never silently lost (Task 3).
4. **A field refused for its UI kind on a multi-page master** (the USCIS barcode): reported once per instance under Adobe's per-page names, so the report lines up with what Adobe wrote (Task 4).
5. **A page whose medium disagrees with the template**: its instances are skipped (the page is reported once), while every other page's instances are still created (Task 3).

---

### Task 1: Pagination reports page-set instances; a page area can carry a master root (`xfapage.ts`)

**Files:**
- Modify: `src/xfapage.ts:27-34` (`XfaPageAreaModel`), `:46-50` (`PaginatedPage`), `:126-133` (`Paginator.open`), `:297` (`LaidOutPage`), `:322-328` (`layoutPages`)
- Test: `test/xfapage.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `XfaPageAreaModel.master?: LayoutNode` -- the page area's background as a positioned root at the page origin (filled by Task 2).
  - `PaginatedPage.pageSet: number` and `LaidOutPage.pageSet: number` -- the 0-based page-set instance the page belongs to.

- [ ] **Step 1: Write the failing test** -- append to `test/xfapage.test.ts`, inside the existing `describe` that holds "opens a new page-set instance to reach an EARLIER page area" (around line 186), a new case:

```ts
  it('reports each page\'s page-set instance (d3mq)', () => {
    const b = body([area([ca(100)], { name: 'P1', max: 1 }), area([ca(100)], { name: 'P2', max: 1 })], [
      kid('A', 10, { breakBefore: pb({ target: 'P1' }) }), kid('B', 10, { breakBefore: pb({ target: 'P2' }) }),
      kid('C', 10, { breakBefore: pb({ target: 'P1' }) }),
    ]);
    expect(paginate(b, height).pages.map((p) => [p.pageArea, p.pageSet])).toEqual([[0, 0], [1, 0], [0, 1]]);
    expect(layoutPages(b).pages.map((p) => [p.pageArea, p.pageSet])).toEqual([[0, 0], [1, 0], [0, 1]]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/xfapage.test.ts -t "page-set instance"`
Expected: FAIL -- `pageSet` is `undefined` in every pair.

- [ ] **Step 3: Implement**

In `XfaPageAreaModel` add, after `contentAreas`:

```ts
  /** The page area's own background -- fields, draws and subforms outside its
   *  content areas -- as a POSITIONED root at the page origin (XFA 3.3 p. 271,
   *  288). One per page area, shared by every page that instantiates it
   *  (d3mq). Absent when the template walk did not reach the page area. */
  master?: LayoutNode;
```

In `PaginatedPage` add, after `pageArea`:

```ts
  /** The 0-based page-set instance this page belongs to (p. 300). A master
   *  field's instance numbering is only settled within instance 0 (d3mq). */
  pageSet: number;
```

In `Paginator.open`, change the push to:

```ts
    this.pages.push({ pageArea: a, pageSet: this.set, contentAreas: [] });
```

Change `LaidOutPage` to:

```ts
export interface LaidOutPage { pageArea: number; pageSet: number; placed: Map<string, Placed> }
```

and in `layoutPages` return `{ pageArea: p.pageArea, pageSet: p.pageSet, placed }`.

- [ ] **Step 4: Run the file**

Run: `npx vitest run test/xfapage.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck** -- other code builds `LaidOutPage`/`PaginatedPage` literals only in `xfapage.ts`, but confirm.

Run: `npm run typecheck`
Expected: clean. If `xfaconvert.ts`'s `{ pages: [], refused: ... }` fallback errors, type it `as XfaLayoutResult` there (import the type from `./xfapage.js`).

- [ ] **Step 6: Commit**

```bash
git add src/xfapage.ts test/xfapage.test.ts
git commit -m "feat(d3mq): pagination reports each page's page-set instance; a page area may carry a master root

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The template lays a master page out from the page origin (`xfatemplate.ts`)

**Files:**
- Modify: `src/xfatemplate.ts` -- `XfaField` (add `master`, near `layouts` ~line 105), `Top` (~line 458), the `pageSet` branch of `walk` (~lines 524-541), `pageSetOf` (~line 647), `parseXfaTemplate` (~line 677)
- Test: `test/xfatemplate.test.ts` (the `describe('parseXfaTemplate: master-page fields'` block, ~line 600)

**Interfaces:**
- Consumes: `XfaPageAreaModel.master` (Task 1).
- Produces:
  - `XfaField.master?: { pageArea: number; base: string; rest: string }` -- `pageArea` indexes `XfaTemplate.body.pageSet.pageAreas`; instance n is named `` `${base}[${n}].${rest}` ``. Absent when the field's page area is not one pagination can identify (a second `<pageSet>`, an unreadable `<pageArea>`, or a page area whose name repeats -- only the first of a name is identified).
  - `pageSet.pageAreas[k].master` set to the page area's root `LayoutNode` (`kind: 'page'`, `layout: 'position'`, `geom: {}`), whose descendants carry `field` = the master field's first-instance SOM name.

- [ ] **Step 1: Write the failing tests** -- in `test/xfatemplate.test.ts`, inside `describe('parseXfaTemplate: master-page fields'`, add (the `tpl` helper and `MASTER` constant already exist there; `layoutPage` must be imported at the top: `import { layoutPage } from '../src/xfaflow.js';`):

```ts
  it('identifies each field\'s page area and how an instance is named', () => {
    const t = tpl(MASTER);
    expect(t.masterPageFields.map((f) => f.master)).toEqual([
      { pageArea: 0, base: 'form1[0].#pageSet[0].P1', rest: 'code[0]' },
      { pageArea: 0, base: 'form1[0].#pageSet[0].P1', rest: 'hdr[0].who[0]' },
      { pageArea: 1, base: 'form1[0].#pageSet[0].P2', rest: 'code[0]' },
    ]);
  });

  it('builds each page area a positioned root at the PAGE origin (XFA 3.3 p. 271, 288)', () => {
    const t = tpl(`<subform name="form1"><pageSet><pageArea name="P1">
      <contentArea x="1in" y="1in" w="6in" h="9in"/>
      <subform name="hdr" x="1in" y="0.5in"><field name="who" x="2in" y="10pt" w="1in" h="12pt"><ui><textEdit/></ui></field></subform>
      <draw name="logo" x="0" y="0" w="1in" h="1in"/>
    </pageArea></pageSet><subform name="Page1"/></subform>`);
    const root = t.body!.pageSet!.pageAreas[0].master!;
    expect(root).toMatchObject({ kind: 'page', layout: 'position' });
    expect(root.children.map((c) => c.label)).toEqual(['hdr[0]', 'logo']);
    // The subform's offset carries to its field; the contentArea adds nothing.
    expect(layoutPage(root).get('form1[0].#pageSet[0].P1[0].hdr[0].who[0]'))
      .toEqual({ box: { x: 216, y: 46, w: 72, h: 12 } });
  });

  it('identifies only the FIRST page area of a repeated name', () => {
    const t = tpl(`<subform name="form1"><pageSet>
      <pageArea name="A"><contentArea w="8in" h="10in"/><field name="f"><ui><textEdit/></ui></field></pageArea>
      <pageArea name="A"><contentArea w="8in" h="10in"/><field name="g"><ui><textEdit/></ui></field></pageArea>
    </pageSet><subform name="P"/></subform>`);
    expect(t.masterPageFields.map((f) => [f.name, f.master?.pageArea])).toEqual([
      ['form1[0].#pageSet[0].A[0].f[0]', 0],
      ['form1[0].#pageSet[0].A[1].g[0]', undefined],
    ]);
    expect(t.body!.pageSet!.pageAreas[1].master).toBeUndefined();
  });

  it('leaves a second pageSet\'s fields unidentified', () => {
    const t = tpl(`<subform name="form1"><pageSet/><pageSet><pageArea name="A">
      <field name="f"><ui><textEdit/></ui></field></pageArea></pageSet></subform>`);
    expect(t.masterPageFields.map((f) => f.master)).toEqual([undefined]);
  });
```

Note on the second case's expected box: `hdr` at x=72pt, y=36pt; `who` at x=144pt, y=10pt inside it: 72+144 = 216, 36+10 = 46. If `draw`'s label is not `'logo'` in `nodeOf` (it passes `partial` for a named draw), adjust only that literal after reading `nodeOf`'s draw branch -- the assertion's point is that the draw IS in the tree.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/xfatemplate.test.ts -t "master-page fields"`
Expected: the four new cases FAIL (`master` undefined, no `master` root); the three existing ones PASS.

- [ ] **Step 3: Implement**

(a) Add to `XfaField`, after `layouts`:

```ts
  /** A MASTER-page field's page area and how an instance is named (d3mq):
   *  instance n -- the n-th page instantiating page area `pageArea` -- is
   *  `${base}[${n}].${rest}`, which is what LiveCycle writes into a hybrid's
   *  /AcroForm (`form1[0].#pageSet[0].Page1[11].PDF417BarCode1[0]` on USCIS
   *  I-130's twelfth page). Absent when pagination cannot identify the page
   *  area: a second `<pageSet>`, an unreadable `<pageArea>`, or a page area
   *  whose name repeats an earlier one's. */
  master?: { pageArea: number; base: string; rest: string };
```

(b) Add to `Top`:

```ts
  /** The paginated page set's page areas by ELEMENT, with their index in
   *  `pageSet.pageAreas`. By identity, never by position: `pageSetOf` drops
   *  an unreadable page area while the walk drops an unnamed one, so the two
   *  orders can differ. */
  masters?: Map<XmlNode, { index: number; area: XfaPageAreaModel }>;
```

(c) `pageSetOf` gains a third parameter `masters: Map<XmlNode, { index: number; area: XfaPageAreaModel }>` and records each kept area:

```ts
    const a = pageAreaOf(c);
    if (typeof a === 'string') { refusal ??= a; continue; }
    masters.set(c, { index: areas.length, area: a });
    areas.push(a);
```

(d) `parseXfaTemplate`:

```ts
  const masters = new Map<XmlNode, { index: number; area: XfaPageAreaModel }>();
  const pageSet = rootEl ? pageSetOf(root, rootEl, masters) : undefined;
  const top: Top = {
    ...(rootEl ? { rootEl } : {}),
    hasCa: pageSet?.pageAreas.some((p) => p.contentAreas.length > 0) ?? false,
    masters,
  };
```

(`XfaPageAreaModel` must be imported as a type from `./xfapage.js` if it is not already.)

(e) Replace the page-area loop inside `walk`'s `pageSet` branch:

```ts
      for (const pa of c.children) {
        const n = pa.attrs.get('name');
        if (pa.name !== 'pageArea' || n === undefined || n === '') continue;
        const idx = psScope.byName.get(n) ?? 0;
        const at = [...ps, `${n}[${String(idx)}]`];
        psScope.byName.set(n, idx + 1);
        // d3mq: the page area's background is laid out from the PAGE ORIGIN,
        // positioned (XFA 3.3 p. 271, 288), copied onto every page that
        // instantiates it. Walked with a root of its own as the parent, so its
        // fields, draws and subforms build a layout tree exactly as body
        // content does. A <contentArea> is not content and adds no node.
        const root: LayoutNode = { kind: 'page', label: `<pageArea ${n}>`, layout: 'position', geom: {}, children: [] };
        const before = master.length;
        walk(pa, at, [], undefined, { layouts: ['position'], inPage: true }, master, root,
          newScope(), master, undefined, { hasCa: false });
        // Only the FIRST page area of a name is identified: the instance
        // numbering of a repeated name is something no oracle settles.
        const model = top.masters?.get(pa);
        if (model === undefined || idx !== 0) continue;
        model.area.master = root;
        const prefix = `${somName(at)}.`;
        for (const f of master.slice(before)) {
          if (f.name.startsWith(prefix))
            f.master = { pageArea: model.index, base: somName([...ps, n]), rest: f.name.slice(prefix.length) };
        }
      }
```

(The recursive call passes `{ hasCa: false }` with no `masters`, so a nested page set inside a page area -- invalid -- is never identified.)

- [ ] **Step 4: Run the file**

Run: `npx vitest run test/xfatemplate.test.ts`
Expected: PASS, including the three pre-existing master-page cases unchanged.

- [ ] **Step 5: Run the XFA suites** -- master fields gained `layouts: ['position']`, which nothing reads, and every body test must be unmoved.

Run: `npx vitest run test/xfatemplate.test.ts test/xfapage.test.ts test/xfaflow.test.ts test/xfaconvert.test.ts test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/xfatemplate.ts test/xfatemplate.test.ts
git commit -m "feat(d3mq): a master page is a positioned layout root at the page origin; each master field knows its page area and instance name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The converter creates one instance per page (`xfaconvert.ts`)

**Files:**
- Modify: `src/xfaconvert.ts` -- `PlanEntry` (add `master`), stage 5 (extract `baseEntry`/`valueFor`), stage 5b (replace with `planMasterFields`), `geometryFor` (extract `widgetBox`), `convertXfaToAcroForm`'s page-replacement guard (~line 634)
- Test: `test/xfaconvert-master.test.ts` (create); `test/xfaconvert.test.ts:627-655` (replace the part-1 block)

**Interfaces:**
- Consumes: `XfaField.master`, `XfaPageAreaModel.master`, `LaidOutPage.pageSet` (Tasks 1, 2); `layoutPage(root, measure, warnings)` from `./xfaflow.js`; `bindFieldValue` from `./xfadata.js`.
- Produces:
  - `PlanEntry.master?: true` -- the entry is a master-page instance.
  - `report.fields` entries for master instances, `route: 'positioned'`, `page` set, named `` `${base}[${n}].${rest}` ``.
  - `function widgetBox(f: XfaField, box: XfaBox): XfaBox | { reason: string }` (module-private) -- the caption/margin/check-button reduction, shared by body and master.

- [ ] **Step 1: Write the failing tests** -- create `test/xfaconvert-master.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm, buildXfaPlan } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

// d3mq part 2. A master page (<pageArea>) is laid out from the PAGE origin
// (XFA 3.3 p. 271, 288); instance n of a field is on the n-th page that
// instantiates its page area.

const LETTER = '<medium short="8.5in" long="11in"/>';

/** Pages P1, P1, P2: P1 may occur twice, each body subform fills a content
 *  area, so the third falls through to P2 (XFA 3.3 p. 298-300) -- all within
 *  ONE page-set instance. (Going BACK from P2 to P1 would open a second
 *  page-set instance, which master fields refuse; 164g.3 pins that rule.)
 *  Per-page-area numbering names the P2 instance P2[0]; a page index would say
 *  P2[2]. P1 carries a text field 'stamp' at x=1in y=10in; P2 carries 'mark' at
 *  x=2in y=0.5in. */
const P1_P1_P2 = (o: { p1Max?: string; p2Max?: string; psMax?: string; kids?: number } = {}) => `<template><subform name="form1" layout="tb">
  <pageSet>${o.psMax !== undefined ? `<occur max="${o.psMax}"/>` : ''}
    <pageArea name="P1"><occur max="${o.p1Max ?? '2'}"/>${LETTER}<contentArea x="0.5in" y="0.5in" w="7.5in" h="9in"/>
      <field name="stamp" x="1in" y="10in" w="2in" h="20pt"><ui><textEdit/></ui></field></pageArea>
    <pageArea name="P2">${o.p2Max !== undefined ? `<occur max="${o.p2Max}"/>` : ''}${LETTER}<contentArea x="0.5in" y="1in" w="7.5in" h="9in"/>
      <field name="mark" x="2in" y="0.5in" w="1in" h="12pt"><ui><textEdit/></ui></field></pageArea>
  </pageSet>
  ${['A', 'B', 'C', 'D'].slice(0, o.kids ?? 3).map((k) => `<subform name="${k}" w="7.5in" h="9in"/>`).join('\n  ')}
  </subform></template>`;
const ALTERNATING = P1_P1_P2();

const convert = (template: string, o: { pages?: number; datasets?: string; mediaBox?: [number, number, number, number] } = {}) => {
  const doc = Document.Open(buildXfaPdf({ template, ...o }));
  return { doc, r: convertXfaToAcroForm(doc, { removeXfa: false }) };
};
const rect = (doc: Document, n: string) => doc.resolve(doc.Form.Get(n)!.Dict.get('Rect')) as number[];

describe('ConvertXfaToAcroForm: master-page fields, one instance per page (d3mq)', () => {
  it('numbers instances per PAGE AREA, not per page', () => {
    const { doc, r } = convert(ALTERNATING, { pages: 3 });
    const master = r.fields.filter((f) => f.name.includes('#pageSet')).map((f) => [f.name, f.page]);
    expect(master).toEqual([
      ['form1[0].#pageSet[0].P1[0].stamp[0]', 1],
      ['form1[0].#pageSet[0].P1[1].stamp[0]', 2],
      ['form1[0].#pageSet[0].P2[0].mark[0]', 3],
    ]);
    // From the PAGE origin, not the content area: x = 72, top = 792 - 720.
    expect(rect(doc, 'form1[0].#pageSet[0].P1[1].stamp[0]')).toEqual([72, 52, 216, 72]);
    expect(rect(doc, 'form1[0].#pageSet[0].P2[0].mark[0]')).toEqual([144, 744, 216, 756]);
  });

  it('creates nothing for a field the layout refuses, and reports it ONCE', () => {
    const T = ALTERNATING.replace('<field name="stamp"', '<field name="stamp" presence="hidden"');
    const { doc, r } = convert(T, { pages: 3 });
    expect(r.fields.some((f) => f.name.includes('stamp'))).toBe(false);
    const s = r.skipped.filter((x) => x.name?.includes('stamp'));
    expect(s.map((x) => x.name)).toEqual(['form1[0].#pageSet[0].P1[0].stamp[0]']);
    expect(s[0].reason).toMatch(/presence="hidden".*no instance is created/);
    expect(doc.Form.Fields.some((f) => f.FullName.includes('stamp'))).toBe(false);
  });

  it('reports a field refused for its UI kind once PER INSTANCE, by the instance name', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><ui><textEdit/></ui>',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><ui><barcode type="pdf417"/></ui>');
    const { r } = convert(T, { pages: 3 });
    expect(r.skipped.filter((x) => x.name?.includes('stamp')).map((x) => x.name)).toEqual([
      'form1[0].#pageSet[0].P1[0].stamp[0]', 'form1[0].#pageSet[0].P1[1].stamp[0]',
    ]);
  });

  it('carries a subform\'s offset to the field inside it', () => {
    const T = ALTERNATING.replace('<field name="mark" x="2in" y="0.5in" w="1in" h="12pt"><ui><textEdit/></ui></field>',
      '<subform name="Footer" x="1in" y="10in"><field name="mark" x="2in" y="6pt" w="1in" h="12pt"><ui><textEdit/></ui></field></subform>');
    const { doc } = convert(T, { pages: 3 });
    // x = 72 + 144; top = 720 + 6 from the page top.
    expect(rect(doc, 'form1[0].#pageSet[0].P2[0].Footer[0].mark[0]')).toEqual([216, 54, 288, 66]);
  });

  it('binds an explicit dataRef, every instance sharing the one value (XFA 3.3 p. 271)', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt">',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><bind match="dataRef" ref="$data.form1.hdr.code"/>');
    const { doc } = convert(T, { pages: 3, datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><hdr><code>X-7</code></hdr></form1></xfa:data></xfa:datasets>' });
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].stamp[0]')!.Value).toBe('X-7');
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[1].stamp[0]')!.Value).toBe('X-7');
  });

  it('does NOT bind by name: a page-background field needs an explicit reference (p. 271)', () => {
    const { doc } = convert(ALTERNATING, { pages: 3, datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><stamp>no</stamp></form1></xfa:data></xfa:datasets>' });
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].stamp[0]')!.Value).toBe('');
  });

  it('warns that match="global" waits on yy09, and still creates the instances', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt">',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><bind match="global"/>');
    const { r } = convert(T, { pages: 3 });
    expect(r.warnings).toContainEqual(expect.stringMatching(/stamp\[0\]: bind match="global".*yy09/));
    expect(r.fields.filter((f) => f.name.includes('stamp'))).toHaveLength(2);
  });

  it('refuses a radio group on a master page, once', () => {
    const T = ALTERNATING.replace('<field name="mark" x="2in" y="0.5in" w="1in" h="12pt"><ui><textEdit/></ui></field>',
      `<exclGroup name="g" x="2in" y="0.5in"><field name="a" w="10pt" h="10pt"><ui><checkButton shape="round"/></ui><items><text>1</text></items></field></exclGroup>`);
    const { r } = convert(T, { pages: 3 });
    const s = r.skipped.filter((x) => x.name?.includes('.g[0].'));
    expect(s.map((x) => x.reason)).toEqual([expect.stringMatching(/exclGroup.*master page/)]);
  });

  it('reports a page area no page instantiates, once', () => {
    // Two pages, both P1: P2 is never instantiated.
    const { r } = convert(P1_P1_P2({ kids: 2 }), { pages: 2 });
    expect(r.skipped.filter((x) => x.name?.includes('mark'))).toEqual([{
      what: 'field', name: 'form1[0].#pageSet[0].P2[0].mark[0]',
      reason: expect.stringMatching(/no laid-out page is an instance of its <pageArea>/) as unknown as string,
    }]);
  });

  it('refuses every master field when pagination opens a second page-set instance', () => {
    // P1 once, P2 once, then the third page needs a NEW page-set instance.
    const { r } = convert(P1_P1_P2({ p1Max: '1', p2Max: '1', psMax: '2' }), { pages: 3 });
    expect(r.fields.some((f) => f.name.includes('#pageSet'))).toBe(false);
    expect(r.skipped.filter((x) => x.name?.includes('#pageSet')).map((x) => x.reason))
      .toEqual([expect.stringMatching(/second page-set instance/), expect.stringMatching(/second page-set instance/)]);
  });

  it('skips a page whose medium disagrees, and keeps every other page\'s instances', () => {
    // Every page of this PDF is A4; the template says Letter. Only the medium
    // check can fail here, so the case asserts the per-page skip directly via
    // the plan, where each page's medium is compared on its own.
    const doc = Document.Open(buildXfaPdf({ template: ALTERNATING, pages: 3, mediaBox: [0, 0, 595.28, 841.89] }));
    const p = buildXfaPlan(doc, {});
    expect(p.report.skipped.filter((x) => x.what === 'page')).toHaveLength(3);
    expect(p.entries.filter((e) => e.master)).toEqual([]);
  });

  it('does not let master instances alone replace a dynamic document\'s placeholder pages', () => {
    // The body places nothing (its only field is hidden), so the placeholder is
    // kept, and the master instance is dropped and reported.
    const T = `<template><subform name="form1" layout="tb">
      <pageSet><pageArea name="P1">${LETTER}<contentArea w="8.5in" h="11in"/>
        <field name="cui" x="1in" y="0.2in" w="2in" h="12pt"><ui><textEdit/></ui></field></pageArea></pageSet>
      <subform name="Page1" w="8.5in" h="11in"><field name="body" presence="hidden" x="1in" y="1in" w="1in" h="12pt"><ui><textEdit/></ui></field></subform>
      </subform></template>`;
    const doc = Document.Open(buildXfaPdf({ template: T, pages: 1, needsRendering: true }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(0);
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].cui[0]')).toBeUndefined();
    expect(r.skipped).toContainEqual(expect.objectContaining({
      name: 'form1[0].#pageSet[0].P1[0].cui[0]', reason: expect.stringMatching(/placeholder/) as unknown as string,
    }));
  });
});
```

Notes for the implementer:
- The medium case has three PDF pages that are all A4 against a Letter `<medium>`; `buildXfaPdf`'s `mediaBox` applies to every page. A case with ONE bad page among good ones cannot be built with `buildXfaPdf` (one box for all pages), so the medium rule's per-page granularity is held by the code path (`badPages.has(i)` checked per instance) and by Task 6's mutation sweep, not by a mixed fixture. Record that in CLAUDE.md in Task 6.
- In the dynamic-guard case, if `presence="hidden"` makes the body child refused at PAGINATION (so `laid.pages` is empty), the master field instead reports "no laid-out page is an instance" -- still not created. If that happens, change the body field to `presence="visible"` with a `<ui><signature/></ui>` (refused for its kind, so nothing placed) and keep the assertions.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/xfaconvert-master.test.ts`
Expected: FAIL -- master fields are only reported (part 1).

- [ ] **Step 3: Extract the shared helpers** in `src/xfaconvert.ts`.

Add, next to `geometryFor` (import `type XfaBox` from `./xfageom.js`):

```ts
/** A field's WIDGET box inside its laid-out box: the caption reserve and the
 *  field's own margin come off, and a check button is sized and aligned
 *  inside what is left. Shared by body and master fields -- one rule. */
function widgetBox(f: XfaField, box: XfaBox): XfaBox | { reason: string } {
  const edit = editRegion(box, f.caption, f.margin);
  if ('reason' in edit) return edit;
  // A check button's widget is the BUTTON, not the edit region it sits in. Only
  // this UI kind states a size of its own, so every other field takes the box
  // unchanged.
  if (f.ui !== 'checkButton') return edit;
  return buttonBox(edit, {
    ...(f.buttonSize !== undefined ? { size: f.buttonSize } : {}),
    ...(f.para?.hAlign !== undefined ? { hAlign: f.para.hAlign } : {}),
    ...(f.para?.vAlign !== undefined ? { vAlign: f.para.vAlign } : {}),
    ...(f.caption?.placement !== undefined ? { captionPlacement: f.caption.placement } : {}),
  });
}
```

and rewrite the tail of `geometryFor` (from `const box = editRegion(...)` to the end) as:

```ts
  const wb = widgetBox(f, p.box);
  if ('reason' in wb) return `${wb.reason}, so the field carries no geometry`;
  entry.page = w.page + 1;
  entry.rect = rectFromBox(wb, crops[w.page]);
  return undefined;
```

Extract stage 5's entry construction into:

```ts
/** A field's data value as a plan carries it. An EMPTY datum on a choice list
 *  is no selection, not an option named '' (cb07). */
function valueFor(f: XfaField, bound: string | string[] | undefined): string | string[] | undefined {
  return f.ui === 'choiceList' && bound === '' ? undefined : bound;
}

/** Everything a plan entry carries except geometry. */
function baseEntry(f: XfaField, t: { ft: string; ff: number }, value: string | string[] | undefined): PlanEntry {
  let ff = t.ff;
  if (f.readOnly) ff |= FF_READONLY;
  if (f.required) ff |= FF_REQUIRED;
  // The item list is TRANSCRIBED, never run through normalizeOptions: that is
  // the validator for options a CALLER authors, and a document's list is data.
  // /Opt may legally repeat an export or hold '' -- Adobe's own /Opt on i-130
  // does both -- so refusing either refused the whole conversion (cb07).
  const options: NormalizedOption[] | undefined = f.items && f.ui === 'choiceList'
    ? f.items.map((i) => (i.display === undefined || i.display === i.export
      ? { export: i.export }
      : { export: i.export, display: i.display }))
    : undefined;
  return {
    name: f.name,
    type: classify(t.ft, ff),
    ft: t.ft,
    ff,
    ...(value !== undefined ? { value } : {}),
    ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
    ...(options ? { options } : {}),
    ...(f.maxChars !== undefined ? { maxLen: f.maxChars } : {}),
    ...(f.tooltip !== undefined ? { tooltip: f.tooltip } : {}),
    ...(f.onState !== undefined ? { onState: f.onState } : {}),
    reconcile: false,
  };
}
```

and stage 5's body loop becomes:

```ts
    const entry = baseEntry(f, t, valueFor(f, bindFieldValue(f, values)));
```

(removing the moved lines). Add to `PlanEntry`:

```ts
  /** A master-page instance (d3mq). Placing one does not, on its own, justify
   *  replacing a dynamic document's placeholder pages. */
  master?: true;
```

- [ ] **Step 4: Run the existing converter suites to prove the extraction moved nothing**

Run: `npx vitest run test/xfaconvert.test.ts test/xfaconvert-choice-data.test.ts test/xfaconvert-measure.test.ts test/xfaconvert-occur.test.ts test/xfaconvert-pages.test.ts test/xfa-real.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace stage 5b** with a call, `planMasterFields(tpl, laid, pageSet, noGeometry, badPages, crops, values, measure, report, entries);`, and add the function (imports: `layoutPage` from `./xfaflow.js`; `type XfaLayoutResult, type XfaPageSet` from `./xfapage.js`):

```ts
/**
 * Fields on a MASTER page (d3mq): one instance per page that instantiates the
 * field's page area, placed from the PAGE origin (XFA 3.3 p. 271, 288) and
 * named as Adobe names that instance -- `Page1[n]` is the n-th page of
 * `Page1`, counted per PAGE AREA, not per page.
 *
 * A field with no geometry creates NOTHING and is reported once: a per-page
 * instance exists only as a place on a page, and Adobe writes nothing for a
 * hidden counter or a button in an inactive subform. A field refused for its
 * UI KIND is reported per instance, under the name Adobe gives it.
 *
 * Data: only an explicit `<bind match="dataRef" ref>` binds a page-background
 * field (p. 271); every instance shares the value. `match="global"` is yy09's.
 */
function planMasterFields(
  tpl: XfaTemplate, laid: XfaLayoutResult, pageSet: XfaPageSet | undefined,
  noGeometry: boolean, badPages: ReadonlySet<number>, crops: readonly number[][],
  values: XfaValues, measure: XfaMeasure, report: XfaConvertReport, entries: PlanEntry[],
): void {
  // Each page area's background is laid out ONCE: every page instantiating it
  // carries the same boxes.
  const laidOut = new Map<number, Map<string, Placed>>();
  const placedIn = (k: number): Map<string, Placed> => {
    let m = laidOut.get(k);
    if (m === undefined) {
      const root = pageSet?.pageAreas[k]?.master;
      m = root ? layoutPage(root, measure, report.warnings) : new Map<string, Placed>();
      laidOut.set(k, m);
    }
    return m;
  };
  const secondSet = laid.pages.some((p) => p.pageSet > 0);
  const skip = (name: string, reason: string): void => {
    report.skipped.push({ what: 'field', name, reason });
  };
  for (const f of tpl.masterPageFields) {
    const t = typeOf(f);
    const kind = `a <${f.ui}> field is refused rather than synthesized`;
    const m = f.master;
    // Document-level reasons first; a field refused for its own sake says so.
    if (m === undefined || pageSet === undefined) {
      skip(f.name, t ? 'its <pageArea> is not one pagination can identify -- a second <pageSet>, '
        + 'an unreadable <pageArea>, or one whose name repeats an earlier one\'s' : kind);
      continue;
    }
    if (noGeometry) {
      skip(f.name, t ? 'the document carries no page geometry, so no instance can be placed' : kind);
      continue;
    }
    if (secondSet) {
      skip(f.name, t ? 'pagination opened a second page-set instance, whose master-page '
        + 'numbering no oracle settles, so no instance is created' : kind);
      continue;
    }
    if (f.group !== undefined) {
      skip(f.name, 'a radio group (<exclGroup>) on a master page is not converted');
      continue;
    }
    const p = placedIn(m.pageArea).get(f.name);
    if (p === undefined || 'reason' in p) {
      skip(f.name, t ? `${p?.reason ?? 'the field is not in its page area\'s layout'}, so no instance is created` : kind);
      continue;
    }
    const wb = t ? widgetBox(f, p.box) : undefined;
    if (wb !== undefined && 'reason' in wb) {
      skip(f.name, `${wb.reason}, so no instance is created`);
      continue;
    }
    if (t && f.bindMatch === 'global')
      report.warnings.push(`${f.name}: bind match="global" is not implemented yet (yy09), so its instances carry no data value`);
    const value = t && f.bindMatch === 'dataRef' && (f.bindRef ?? '') !== ''
      ? valueFor(f, bindFieldValue(f, values)) : undefined;
    let n = 0;
    laid.pages.forEach((pg, i) => {
      if (pg.pageArea !== m.pageArea) return;
      const name = `${m.base}[${String(n)}].${m.rest}`;
      n += 1;
      if (!t || wb === undefined) { skip(name, kind); return; }
      // A page whose medium disagrees was reported once, as a page.
      if (badPages.has(i)) return;
      entries.push({ ...baseEntry(f, t, value), name, page: i + 1, rect: rectFromBox(wb, crops[i]), master: true });
    });
    if (n === 0)
      skip(f.name, t ? 'no laid-out page is an instance of its <pageArea>, so no instance is created' : kind);
  }
}
```

- [ ] **Step 6: The dynamic-document guard** -- in `convertXfaToAcroForm`, the placeholder replacement (currently `if (plan.newPages && (plan.entries.some((e) => !e.reconcile && e.rect !== undefined) || plan.groups.some((g) => !g.reconcile)))`) must count BODY placements only. Change the entry test to `plan.entries.some((e) => !e.reconcile && e.rect !== undefined && !e.master)`. Then, immediately after that `if` block, when `plan.newPages` is set but pages were NOT replaced, drop the master instances and report each:

```ts
  if (plan.newPages && !replaced) {
    // A dynamic document's own pages are Designer's placeholder. Master
    // instances alone do not justify replacing them -- a form whose body was
    // refused would come out cut to the pages its background fills -- so they
    // are dropped, each reported (d3mq).
    for (const e of plan.entries.filter((x) => x.master)) {
      plan.report.skipped.push({
        what: 'field', name: e.name,
        reason: 'the document\'s pages are a placeholder and no body content was placed, so the master-page instance is not created',
      });
    }
    plan.entries = plan.entries.filter((x) => !x.master);
    plan.report.fields = plan.report.fields.filter((x) => !x.name.includes('#pageSet'));
  }
```

`replaced` is a boolean set true inside the existing replacement block; read that block first and introduce it there. `plan.entries` and `plan.report.fields` must be assignable (change `XfaPlan.entries` from `readonly` if it is). If `report.fields` is filled before this point (it is, in `buildXfaPlan` stage 8), the filter above keeps it consistent; recompute `report.dataOnly` after filtering with the same expression stage 8 uses.

- [ ] **Step 7: Replace the part-1 test** -- in `test/xfaconvert.test.ts`, replace the whole `describe('ConvertXfaToAcroForm: master-page fields are reported', ...)` block with:

```ts
// d3mq: a master-page field is created once per page; one refused for its UI
// kind is reported per instance. The full rule matrix is xfaconvert-master.test.ts.
describe('ConvertXfaToAcroForm: master-page fields', () => {
  const MASTER = `<template><subform name="form1" layout="tb">
    <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
      <contentArea x="0.25in" y="0.25in" w="8in" h="10in"/>
      <field name="code" x="1in" y="10.5in" w="3in" h="0.25in"><ui><barcode type="pdf417"/></ui></field>
      <field name="who" x="5in" y="10.5in" w="2in" h="0.25in"><ui><textEdit/></ui></field>
    </pageArea></pageSet>
    <subform name="Page1" layout="position">
      <field name="f1_01" x="1in" y="2in" w="3in" h="20pt"><ui><textEdit/></ui></field>
    </subform></subform></template>`;

  it('creates a placeable one and reports a refused kind', () => {
    const doc = Document.Open(buildXfaPdf({ template: MASTER }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.fields.map((f) => [f.name, f.route, f.page])).toEqual([
      ['form1[0].Page1[0].f1_01[0]', 'positioned', 1],
      ['form1[0].#pageSet[0].P1[0].who[0]', 'positioned', 1],
    ]);
    const master = r.skipped.filter((s) => s.name?.includes('#pageSet'));
    expect(master.map((s) => s.name)).toEqual(['form1[0].#pageSet[0].P1[0].code[0]']);
    expect(master[0].reason).toMatch(/<barcode>.*refused/);
    // x = 5in, bottom = 792 - 10.75in.
    expect(doc.resolve(doc.Form.Get('form1[0].#pageSet[0].P1[0].who[0]')!.Dict.get('Rect')))
      .toEqual([360, 18, 504, 36]);
  });
});
```

- [ ] **Step 8: Run**

Run: `npx vitest run test/xfaconvert-master.test.ts test/xfaconvert.test.ts`
Expected: PASS. If the P1, P1, P2 case's page order differs, read the actual `report.fields` and the pagination (`layoutPages(tpl.body).pages`) before changing expectations: a 9in subform in a 9in content area must fill it, P1's max of 2 must then hand page 3 to P2 (XFA 3.3 p. 298-300), and every page must be page-set instance 0.

- [ ] **Step 9: Run every XFA suite**

Run: `npx vitest run test/xfa`
Expected: PASS except `test/xfa-real.test.ts`'s part-1 case "master-page fields are reported by the name Adobe writes (d3mq)", which Task 4 rewrites. If any OTHER case fails, stop and diagnose; the body path must be unmoved.

- [ ] **Step 10: Commit**

```bash
git add src/xfaconvert.ts test/xfaconvert-master.test.ts test/xfaconvert.test.ts
git commit -m "feat(d3mq): ConvertXfaToAcroForm creates each master-page field once per page that instantiates its page area

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Adobe oracle -- DD 1391, DD 1155 and the USCIS barcode names (`test/xfa-real.test.ts`)

**Files:**
- Create: `test/fixtures/xfa/dod-dd1391.pdf`, `test/fixtures/xfa/dod-dd1155.pdf`
- Modify: `test/fixtures/xfa/PROVENANCE.md`, `test/xfa-real.test.ts:300-325` (replace the part-1 block)

**Interfaces:**
- Consumes: Task 3's master instances.
- Produces: nothing for later tasks.

- [ ] **Step 1: Vendor the two forms** (US federal works, public domain). Download each into a fresh directory, verify the hash, then copy:

```bash
mkdir -p /tmp/dd && cd /tmp/dd
curl -sL -A "Mozilla/5.0" -o dd1391.pdf https://www.esd.whs.mil/Portals/54/Documents/DD/forms/dd/dd1391.pdf
curl -sL -A "Mozilla/5.0" -o dd1155.pdf https://www.esd.whs.mil/Portals/54/Documents/DD/forms/dd/dd1155.pdf
sha256sum dd1391.pdf dd1155.pdf
```

Expected (as scanned 2026-10-12):
- `dd1391.pdf` 49,311 bytes, `1cc33c0949c8e8cc21c0d013afe92b725ac12cddfb7e75875f70bee9b5fe12f2`
- `dd1155.pdf` 85,219 bytes, `005699455b6c3a1c4cb61ee0af8145cf45c9e4b7d7214982085e6a2b4c1b679e`

If a hash differs, DoD has republished the form: re-run the Step 3 probe on the new bytes and record the new hash; do not silently keep the old numbers. Copy to `test/fixtures/xfa/dod-dd1391.pdf` and `test/fixtures/xfa/dod-dd1155.pdf`.

- [ ] **Step 2: PROVENANCE** -- in `test/fixtures/xfa/PROVENANCE.md`, add two rows to the file table in its existing column shape (file, URL, pages, AcroForm field count, has XFA, kind): `dod-dd1391.pdf` / `https://www.esd.whs.mil/Portals/54/Documents/DD/forms/dd/dd1391.pdf` / 1 / 62 / yes / **hybrid**, master-page fields; `dod-dd1155.pdf` / `.../dd1155.pdf` / 1 / 90 / yes / **hybrid**, master-page Reset button. Then add a section:

```markdown
## DoD DD 1391 and DD 1155 (d3mq)

US Department of Defense forms, US federal works, fetched 2026-10-12 from
`https://www.esd.whs.mil/Portals/54/Documents/DD/forms/dd/`. SHA-256 recorded
above. Producer: Adobe LiveCycle Designer (each file's own `/Info`).

**What they show:** the only FILLABLE master-page field found in 92 federal
forms scanned. DD 1391's `NumericField1` ("PAGE NO.", a visible `numericEdit`
with a caption reserve, `bind match="none"`, no script) and both forms' Reset
buttons sit on a `<pageArea>`, and Adobe wrote each as
`form1[0].#pageSet[0].Page1[0].<name>[0]`. Converted from the template alone,
every one lands on Adobe's name and rect -- measured from the PAGE origin, not a
content area. Adobe writes NO Save or Print button: they sit in a
`presence="inactive"` subform.

**What they do NOT show:** a master field repeated across pages (both forms are
one page; the USCIS barcode names pin multi-instance numbering), and anything
about their BODY fields, which are refused today ("wraps after a line of mixed
heights") -- tracked as `bkdi`. That refusal is also why the three-page DD 1610
and DD 2952, which carry master Reset buttons on two page areas, are NOT
vendored: their body lays out one page against three, so no field on them can be
placed.
```

- [ ] **Step 3: Write the failing tests** -- in `test/xfa-real.test.ts`, replace the `describe('master-page fields are reported by the name Adobe writes (d3mq)', ...)` block with:

```ts
// d3mq: master-page fields, one instance per page. DD 1391 and DD 1155 carry
// the only FILLABLE master-page fields found; the USCIS forms carry a barcode
// on every page, which is refused for its kind but reported under every name
// Adobe gives it.
describe('master-page fields, against Adobe (d3mq)', () => {
  for (const file of ['dod-dd1391.pdf', 'dod-dd1155.pdf']) {
    it(`${file}: creates every master-page field Adobe wrote, on Adobe's page and rect`, () => {
      const bytes = load(file);
      const src = Document.Open(bytes);
      const adobe = new Map(src.Form.Fields.filter((f) => f.FullName.includes('#pageSet'))
        .map((f) => [f.FullName, src.resolve(f.Dict.get('Rect')) as number[]]));
      const doc = stripAcroFields(bytes);
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      const made = report.fields.filter((f) => f.name.includes('#pageSet'));
      expect(made.map((f) => f.name).sort()).toEqual([...adobe.keys()].sort());
      let exact = 0;
      let worst = 0;
      for (const f of made) {
        expect(f.page, f.name).toBe(1);
        const got = rectOf(doc, f.name);
        const want = adobe.get(f.name)!;
        const d = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(got[i] - want[i])));
        if (d <= 0.01) exact += 1;
        worst = Math.max(worst, d);
      }
      // EXACT, not a 1pt bound: a bound accepted a nearly-right inset rule once (mw1m).
      expect(exact, `exact of ${String(made.length)}`).toBe(made.length);
      expect(worst).toBeLessThanOrEqual(0.01);
      // Adobe writes no Save/Print: they sit in a presence="inactive" subform.
      expect(made.some((f) => /SaveButton|PrintButton/.test(f.name))).toBe(false);
    });

    it(`${file}: the hybrid as published reconciles its master fields and creates none`, () => {
      const doc = Document.Open(load(file));
      const before = doc.Form.Fields.length;
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      expect(report.fields.filter((f) => f.name.includes('#pageSet') && f.route !== 'reconciled')).toEqual([]);
      expect(doc.Form.Fields.length).toBe(before);
    });
  }

  for (const [file, pages] of [['uscis-i130.pdf', 12], ['uscis-i765.pdf', 7]] as const) {
    it(`${file}: reports the barcode under every one of Adobe's ${String(pages)} instance names`, () => {
      const adobe = Document.Open(load(file)).Form.Fields.map((f) => f.FullName)
        .filter((n) => n.includes('#pageSet')).sort();
      expect(adobe).toHaveLength(pages);
      const doc = stripAcroFields(load(file));
      const report = doc.ConvertXfaToAcroForm({ removeXfa: false });
      const barcode = report.skipped.filter((s) => s.name?.includes('PDF417BarCode1'));
      expect(barcode.map((s) => s.name).sort()).toEqual(adobe);
      for (const s of barcode) expect(s.reason).toMatch(/<barcode>/);
      // The two hidden counters, which Adobe does not write, are reported once each.
      expect(report.skipped.filter((s) => /CurrentPagep1|PageCountp1/.test(s.name ?? '')).map((s) => s.name)).toEqual([
        'form1[0].#pageSet[0].Page1[0].CurrentPagep1[0]',
        'form1[0].#pageSet[0].Page1[0].PageCountp1[0]',
      ]);
      expect(report.fields.some((f) => f.name.includes('#pageSet'))).toBe(false);
    });
  }
});
```

Before trusting the dd1155 name list, run Step 4 once and read its `made` names: if DD 1155 has a master field Adobe did NOT write (a hidden counter is reported, not created, so it should not appear), the sort-equality will say so -- investigate rather than filter.

- [ ] **Step 4: Run**

Run: `npx vitest run test/xfa-real.test.ts`
Expected: PASS. If `NumericField1`'s rect misses by a few points, the cause is the field's `<margin>` or caption reserve: compare `editRegion`'s inputs with the template (`<caption reserve="14.9536mm">`), do NOT loosen the bound.

- [ ] **Step 5: Run the oracle suites** -- the fdq3 and paginated-hybrid cases filter `#pageSet` out of body comparisons and must still pass.

Run: `npx vitest run test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts test/xfaconvert-master.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/xfa/dod-dd1391.pdf test/fixtures/xfa/dod-dd1155.pdf test/fixtures/xfa/PROVENANCE.md test/xfa-real.test.ts
git commit -m "test(d3mq): Adobe oracle -- DD 1391 and DD 1155 master fields on Adobe's names and rects; USCIS barcode under every instance name

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The pdf.js oracle -- DD 2875 and DD 1494 master layouts across pages

**Files:**
- Create: `test/fixtures/xfa-dynamic/dod-dd2875.pdf`, `test/fixtures/xfa-dynamic/dod-dd1494.pdf`, `test/fixtures/xfa-dynamic/master-goldens.json` (generated), `test/xfa-master-oracle.test.ts`
- Modify: `test/helpers/xfa-dynamic.ts`, `scripts/gen-xfa-goldens.ts`, `test/fixtures/xfa-dynamic/PROVENANCE.md`

**Interfaces:**
- Consumes: `parseXfaTemplate`, `XfaField.master`, `XfaPageAreaModel.master` (Task 2); `layoutPage` from `src/xfaflow.ts`; `xfaMeasurer` from `src/xfaconvert.ts`.
- Produces: `MASTER_FILES`, `loadMasterPdf(file)`, `masterGoldens()` in `test/helpers/xfa-dynamic.ts`.

Why the comparison is the LAYOUT box, not the converted widget: both forms' BODY is refused today (`bkdi`), so our pagination produces one page where pdf.js produces several. A page area's background is laid out from the page origin independent of the body, so each pdf.js page's master boxes can be compared with our master layout of that page area regardless. Converting these forms end to end waits on `bkdi`.

- [ ] **Step 1: Vendor** -- download as in Task 4 Step 1:

- `dd2875.pdf` 56,896 bytes, `e7247a22dac5633d00e761724f169d32186853300b9eec6d870df35103401885`
- `dd1494.pdf` 117,948 bytes, `16bb17a7ccffa46989e2e454fb964010ab9fdfc8f8ee0b7bd045f542e7ee7d41`

Copy to `test/fixtures/xfa-dynamic/dod-dd2875.pdf` and `dod-dd1494.pdf`.

- [ ] **Step 2: The helper** -- append to `test/helpers/xfa-dynamic.ts`:

```ts
/** d3mq: dynamic DoD forms with FILLABLE master-page fields, laid out by pdf.js.
 *  Their master boxes are the oracle; see PROVENANCE. */
export const MASTER_FILES = ['dod-dd2875.pdf', 'dod-dd1494.pdf'] as const;
export type MasterFile = (typeof MASTER_FILES)[number];

export interface MasterGoldens {
  meta: Record<string, string>;
  /** Per file: pages pdf.js laid out, each page's pageArea name, and every
   *  node pdf.js named under a page area (`som` starts `#pageArea[<name>].`). */
  files: Record<MasterFile, { pages: number; sha256: string; nodes: GoldenNode[] }>;
}

export function loadMasterPdf(file: MasterFile): Uint8Array {
  return new Uint8Array(readFileSync(fixture(file)));
}

export function masterGoldens(): MasterGoldens {
  return JSON.parse(readFileSync(fixture('master-goldens.json'), 'utf8')) as MasterGoldens;
}
```

- [ ] **Step 3: The generator** -- in `scripts/gen-xfa-goldens.ts`, import `MASTER_FILES, loadMasterPdf, type MasterGoldens` from the helper, and after the variants loop (before `await browser.close()`) add:

```ts
// d3mq: the master-page oracle. Only nodes pdf.js names under a page area are
// kept -- the body of these forms is bkdi's and is not compared.
const masterFiles = {} as MasterGoldens['files'];
for (const file of MASTER_FILES) {
  const bytes = loadMasterPdf(file);
  current = bytes;
  const { pages, nodes } = await collect();
  masterFiles[file] = {
    pages,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    nodes: nodes.filter((n) => n.som.startsWith('#pageArea[')),
  };
  console.log(`${file}: ${String(pages)} pages, ${String(masterFiles[file].nodes.length)} page-area nodes`);
}
```

and after writing `goldens.json`:

```ts
const masterOut: MasterGoldens = {
  meta: { pdfjsDist: VERSION, pdfjsIntegrity: INTEGRITY, pdfjsGitHead: pkg.gitHead, chrome },
  files: masterFiles,
};
writeFileSync(join(OUT, 'master-goldens.json'), `${JSON.stringify(masterOut, null, 1)}\n`);
```

Update the file's header comment to say it also writes `master-goldens.json` (d3mq).

- [ ] **Step 4: Generate**

```bash
npm i --no-save puppeteer
npm run gen:xfa
```

Expected: the three OPM variant lines unchanged, plus a line per DD file with pages > 1 and a non-zero page-area node count. Then confirm `git diff --stat test/fixtures/xfa-dynamic/goldens.json` shows NO change (the OPM goldens are pinned; a change there means pdf.js or Chrome moved and must be investigated, not committed).

**Decision point, recorded either way:** read `master-goldens.json`.
- If each page's master field nodes appear under `#pageArea[<name>].` with `[0]`-based indexes per page, proceed.
- If indexes climb across pages (`cui_list[0]` on page 1, `cui_list[1]` on page 2), pdf.js gave each page-area copy a fresh element id; normalize in the test by comparing per page with the trailing index of the FIRST segment dropped, and say so in PROVENANCE.
- If pdf.js renders no page-area FIELD at all for a file, drop that file from `MASTER_FILES`, record why in PROVENANCE, and keep the other.

- [ ] **Step 5: Write the test** -- create `test/xfa-master-oracle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { decodeStream } from '../src/filters.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { parseXfaDatasets, parseXfaDataGroups } from '../src/xfadata.js';
import { layoutPage } from '../src/xfaflow.js';
import { xfaMeasurer } from '../src/xfaconvert.js';
import { isDict } from '../src/types.js';
import { MASTER_FILES, loadMasterPdf, masterGoldens } from './helpers/xfa-dynamic.js';

// d3mq: pdf.js lays these two dynamic DoD forms out across several pages and
// copies each page area's background onto every page that instantiates it
// (XFA 3.3 p. 288). Our master layout of that page area must put each field
// where pdf.js put it, on every page. The BODY is not compared: it is refused
// today (bkdi), which is also why this compares layout boxes rather than a
// converted document.
//
// Precision: Chrome holds lengths in 1/64 px, so a box comes back within
// ~0.02pt of the exact sum (164g.6).
const TOL = 0.05;

describe('master-page layout, against pdf.js (d3mq)', () => {
  const g = masterGoldens();
  for (const file of MASTER_FILES) {
    it(`${file}: every page-area field pdf.js placed is where our master layout puts it`, () => {
      const bytes = loadMasterPdf(file);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(g.files[file].sha256);
      const doc = Document.Open(bytes);
      const acro = doc.resolve(doc.catalog().get('AcroForm'));
      const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
      if ('reason' in set) throw new Error(set.reason);
      const datasets = set.packets.get('datasets');
      const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(datasets));
      const values = datasets ? parseXfaDatasets(datasets) : new Map<string, string | string[]>();
      const areas = tpl.body!.pageSet!.pageAreas;
      const measure = xfaMeasurer(doc, tpl, values);
      const laid = new Map(areas.map((a, k) => [k, a.master ? layoutPage(a.master, measure, []) : new Map()]));

      let compared = 0;
      for (const node of g.files[file].nodes) {
        if (node.kind !== 'field') continue;
        const m = /^#pageArea\[([^\]]+)\]\.(.+)$/.exec(node.som)!;
        const k = areas.findIndex((a) => a.name === m[1]);
        expect(k, `${node.som}: page area`).toBeGreaterThanOrEqual(0);
        const f = tpl.masterPageFields.find((x) => x.master?.pageArea === k && x.master.rest === m[2]);
        expect(f, `${node.som}: no master field of ours by that name`).toBeDefined();
        const p = laid.get(k)!.get(f!.name);
        expect(p && 'box' in p, `${node.som} on page ${String(node.page)}: ${p && 'reason' in p ? p.reason : 'not laid out'}`).toBe(true);
        const b = (p as { box: { x: number; y: number; w: number; h: number } }).box;
        for (const [ours, theirs, what] of [[b.x, node.x, 'x'], [b.y, node.y, 'y'], [b.w, node.w, 'w'], [b.h, node.h, 'h']] as const)
          expect(Math.abs(ours - theirs), `${node.som} p${String(node.page)} ${what}`).toBeLessThanOrEqual(TOL);
        compared += 1;
      }
      // Several pages, each carrying its page area's fields: the multi-instance claim.
      expect(g.files[file].pages).toBeGreaterThan(1);
      expect(compared).toBeGreaterThan(g.files[file].pages - 1);
    });
  }
});
```

If Step 4 found climbing indexes, insert the normalization there (strip the first segment's `[i]` and compare with `x.master.rest` stripped the same way, matching the i-th same-named field on that page).

- [ ] **Step 6: Run**

Run: `npx vitest run test/xfa-master-oracle.test.ts`
Expected: PASS. A box off by more than TOL is a finding: read the field's template (`npx tsx` a one-off dump of its `<pageArea>`), identify which rule disagrees (a container margin, an `anchorType`, a measured height), and fix the RULE in `xfaflow.ts`/`xfatemplate.ts` with a builder test -- never widen TOL. If the disagreement is a measured (growable) height, record it and stop: that is `164g.7`'s measurer, not this issue.

- [ ] **Step 7: PROVENANCE** -- add to `test/fixtures/xfa-dynamic/PROVENANCE.md` a section "DoD DD 2875 and DD 1494 (d3mq)": URLs, sizes and SHA-256 (Step 1); US federal works; dynamic (`/NeedsRendering`, no AcroForm); what `master-goldens.json` holds (pdf.js 6.3.289's box for every node it names under a page area, per page); the Step 4 decision-point outcome verbatim; that the BODY is not compared because `bkdi` refuses it; that the master fields bind `match="global"` (`yy09`) and values are not compared; and pdf.js is a reimplementation -- evidence, not Adobe conformance.

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/xfa-dynamic/dod-dd2875.pdf test/fixtures/xfa-dynamic/dod-dd1494.pdf test/fixtures/xfa-dynamic/master-goldens.json test/fixtures/xfa-dynamic/PROVENANCE.md test/helpers/xfa-dynamic.ts scripts/gen-xfa-goldens.ts test/xfa-master-oracle.test.ts
git commit -m "test(d3mq): pdf.js oracle -- DD 2875 and DD 1494 master layouts on every page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Mutation sweep, docs, gates, close

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: Mutation sweep.** For each mutation: apply it, VERIFY it applied (`git diff --stat` shows the file changed), run the named test files with `npx vitest run <files>`, record red/green, revert with `git checkout -- src/`. A run that does not load every named test file is not green: confirm the summary lists each. Kill orphaned vitest workers (by start time) before trusting a timing-sensitive run.

| # | Mutation | Expected red in |
|---|---|---|
| 1 | `planMasterFields`: name instances by PAGE index `i` instead of the per-page-area count `n` | `xfaconvert-master.test.ts` ("numbers instances per PAGE AREA", via P2 on page 3) -- NOT the USCIS case, where every page is `Page1` and the two agree, nor `stamp`, whose P1 pages are 0 and 1 |
| 2 | walk: master root walked with `{ layouts: [], inPage: false }` (no tree) | `xfatemplate.test.ts` (positioned root), every master creation case |
| 3 | `pageSetOf`: index areas by element position among ALL `<pageArea>` children rather than kept ones | needs a case with an unreadable page area BEFORE a readable one -- add it to `xfatemplate.test.ts` if green |
| 4 | walk: drop the `idx !== 0` guard (identify a repeated name's later page area) | `xfatemplate.test.ts` ("identifies only the FIRST page area of a repeated name") |
| 5 | `planMasterFields`: drop the `secondSet` refusal | `xfaconvert-master.test.ts` ("second page-set instance") |
| 6 | `planMasterFields`: bind by implicit name (`bindFieldValue` regardless of `match`) | `xfaconvert-master.test.ts` ("does NOT bind by name") |
| 7 | `planMasterFields`: report a kind refusal once (under `f.name`) instead of per instance | `xfaconvert-master.test.ts` (per-instance barcode), `xfa-real.test.ts` (USCIS) |
| 8 | `planMasterFields`: report a LAYOUT refusal per instance instead of once | `xfaconvert-master.test.ts` ("reports it ONCE"), `xfa-real.test.ts` (USCIS counters) |
| 9 | `planMasterFields`: skip `widgetBox` (use the raw layout box) | `xfa-real.test.ts` (DD 1391 `NumericField1` rect, caption reserve) |
| 10 | `convertXfaToAcroForm`: count master entries toward replacing placeholder pages | `xfaconvert-master.test.ts` ("does not let master instances alone replace") |
| 11 | `planMasterFields`: ignore `badPages` | `xfaconvert-master.test.ts` ("medium disagrees") |
| 12 | `planMasterFields`: lay the page area out per PAGE instead of once | none expected -- a COST rule; record as uncovered if green |
| 13 | `Paginator.open`: `pageSet: 0` always | `xfapage.test.ts` ("page-set instance"), `xfaconvert-master.test.ts` (second instance) |

Any mutation that stays GREEN: add the case that reddens it (and say so), or record why it cannot (equivalent mutant, redundant defence) -- measured, not assumed -- for CLAUDE.md.

- [ ] **Step 2: CHANGELOG.md** -- under `## [Unreleased]` → `### Added`, as the FIRST entry:

```markdown
- **`ConvertXfaToAcroForm` creates XFA master-page fields, one per page.** A field on a `<pageArea>` -- LiveCycle's master page, XFA's "page background" -- appears on every page that page area lays out, and Adobe writes one AcroForm field per page (`form1[0].#pageSet[0].Page1[n]...`). They were reported and never created. Each is now laid out from the PAGE origin by the same engine as body content (XFA 3.3 p. 271, 288) and created once per page, instance n on the n-th page of its page area. Data binds only through an explicit `<bind match="dataRef" ref>`, which XFA requires of a page-background field, every instance sharing the value; `match="global"` is reported in `warnings` and waits on its own issue. A hidden or inactive master field creates nothing, as Adobe writes none; a refused kind (a barcode) is reported once per instance under Adobe's name. Converted from the template alone, DoD DD 1391 and DD 1155 -- the only fillable master-page fields found in 92 federal forms -- land every master field on Adobe's name and rect, and DD 2875 and DD 1494's master pages lay out where pdf.js lays them on every page. A dynamic document's placeholder pages are not replaced on the strength of master fields alone. (aspose-pdf-foss-for-ts-d3mq)
```

- [ ] **Step 3: README.md** -- in the XFA limitation paragraph (search `XFA converts to AcroForm`), add the sentence: `Fields on a master page (\`<pageArea>\`) are created once per page; one bound \`match="global"\` carries no data value yet, and a master-page radio group is not converted.` Run `npx vitest run test/readme-api.test.ts` -- PASS (no new export).

- [ ] **Step 4: CLAUDE.md** -- in the XFA entry (`xfapacket.ts`, ... `xfaconvert.ts`), replace the `**Invariant (`d3mq`, part 1):**` paragraph with a part-2 paragraph covering: a page area's background is a positioned root at the page origin, built by the same walk with a root parent (`XfaPageAreaModel.master`); `XfaField.master` (`pageArea`, `base`, `rest`) and only the first page area of a name identified; page areas matched by element identity; instance n counted per page area (the USCIS-only fixture cannot tell this from a page index -- the P1, P1, P2 builder case does, through P2); `LaidOutPage.pageSet` and the second-instance refusal; binding only by `dataRef` (p. 271), `global` → `yy09`; no geometry → nothing created, reported once; a kind refusal reported per instance; master instances never justify replacing a dynamic document's placeholder; the medium rule's per-page granularity held by the code path and the sweep, not by a mixed fixture (one `mediaBox` for every page in `buildXfaPlan`'s builder); and the Step 1 mutation results. In the `fixtures/xfa/` table row add "DoD DD 1391 and DD 1155: Adobe's master-page fields"; in the `fixtures/xfa-dynamic/` row add "DD 2875 and DD 1494: pdf.js master-page layouts per page (body refused, bkdi)". Then run the module-entry sweep; it must print nothing:

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 5: Gates.** `npm run typecheck` (clean) and `npm test` (all green). Record the file and test counts.

- [ ] **Step 6: Commit, remember, close, push.**

```bash
git add CHANGELOG.md CLAUDE.md README.md
git commit -m "docs(d3mq): XFA master-page fields in CHANGELOG, CLAUDE.md, README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bd remember --key xfa-master-oracle "xfa-master-oracle (d3mq): fillable XFA master-page fields found only in DoD DD forms (esd.whs.mil/Portals/54/Documents/DD/forms/dd/<name>.pdf, US federal works; index refuses scripts). Vendored DD 1391/1155 (hybrids, Adobe names+rects) and DD 2875/1494 (dynamic, pdf.js master-goldens.json). Their BODY is refused by the lr-tb mixed-heights rule (bkdi), which also blocks 3-page DD 1610/2952. Master fields bind only via match=dataRef (XFA 3.3 p. 271); global is yy09."
bd close aspose-pdf-foss-for-ts-d3mq
git pull --rebase --autostash && git push && git status
```

`git status` must say "up to date with 'origin/main'".
