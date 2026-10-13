# XFA `bind match="global"` Implementation Plan (yy09)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A field stating `<bind match="global">` binds to the datum Designer wrote for it -- its own data path first, else the first same-named data value anywhere in the data -- shared by every global field of that name, master-page instances included.

**Architecture:** `xfadata.ts` (pure) gains a `name -> first leaf value` index built in the same document-order walk as the value map, and `bindFieldValue` consults it for a global field whose own path holds nothing. `xfatemplate.ts` records each field's raw name (`dataName`) and whether its `<exclGroup>` states global. `xfaconvert.ts` threads the index to the body, master-page and measurer call sites and reports the two unmodelled shapes. A pre-existing defect the change routes more data through -- a reconciled checkbox handed a string -- is fixed in the same plan, because without it the real-data outcome is a refusal.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-xfa-global-binding-design.md`

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only. Import specifiers carry `.js`.
- XFA 3.3 citations: `xfa_spec_3_3.pdf`, SHA-256 `a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`; `match` property p. 176; Globals p. 246-247; non-record mode p. 92 and p. 136; page-area global fields p. 301; exclGroup global p. 348; config `<record>` p. 531. Cite beside the code.
- The departure from p. 247's "marking a field as global has no effect" is a STATED divergence, written beside the code.
- `xfadata.ts` stays pure over `xml.js` and never throws.
- Every catch in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- The Adobe name/rect oracles (`test/xfa-real.test.ts`), the master oracles (`test/xfa-master-oracle.test.ts`), the pdf.js oracles and the chrome fence (`test/xfa-chrome-fence.test.ts`) stay green UNEDITED.
- Mutation scripts are written with the Write tool (bash heredocs strip backslashes), and each mutation is CONFIRMED to have changed the file before its result is trusted.
- `npm run typecheck` and `npm test` green before closing.

## Review Focus

1. **A global field whose name repeats inside a repeating subform's data** (two `<row><c1>` groups): the flattened search returns the FIRST in document order for every global field named `c1`, never the second. Test in Task 2.
2. **A global field whose own data path holds an EMPTY datum** (`<c1/>`): that is still an ordinary match and wins -- an empty datum is a datum. Test in Task 2.
3. **A global field named like a data GROUP** (`<c1><x>1</x></c1>` and no leaf `c1`): no value, never the group's concatenated text. Test in Task 2.
4. **A hybrid checkbox whose datum is blank or `"0"`**: no "refused the data value" skip, and an off checkbox stays off. Test in Task 4.
5. **A dynamic form whose global choice list is bound to a datum outside its `/Opt`**: reported as a field skip, never a throw (the existing `cb07` path). Test in Task 3.

---

### Task 1: Baseline the hybrid and dynamic conversions

The spec requires measuring what the change moves on the vendored forms. This task records the BEFORE state; Task 4 compares against it. Nothing here is committed.

**Files:**
- Create (uncommitted, deleted in Task 4): `test/_tmp/baseline.test.ts`

**Interfaces:**
- Produces: `<scratchpad>/yy09-baseline.json` -- per form, `report.skipped`, `report.warnings`, and every field's `Value` after conversion.

- [ ] **Step 1: Write the capture**

```ts
// test/_tmp/baseline.test.ts -- NOT committed. Run once before Task 2, once after Task 4.
import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { Document } from '../../src/document.js';

const FORMS = ['xfa/irs-f1040.pdf', 'xfa/irs-fw9.pdf', 'xfa/uscis-i130.pdf', 'xfa/uscis-i765.pdf',
  'xfa/dod-dd1155.pdf', 'xfa/dod-dd1391.pdf', 'xfa-dynamic/opm1644.pdf',
  'xfa-dynamic/dod-dd2875.pdf', 'xfa-dynamic/dod-dd1494.pdf'];

it('captures', () => {
  const out: Record<string, unknown> = {};
  for (const f of FORMS) {
    const doc = Document.Open(new Uint8Array(readFileSync(`test/fixtures/${f}`)));
    const r = doc.ConvertXfaToAcroForm();
    const values = Object.fromEntries(doc.Form.Fields.map((x) => [x.FullName, x.Value]));
    out[f] = { skipped: r.skipped, warnings: r.warnings, values };
  }
  writeFileSync(process.env.YY09_OUT!, JSON.stringify(out, null, 1));
});
```

- [ ] **Step 2: Capture BEFORE**

Run (Bash, from the repo root; `S` is the session scratchpad):
`YY09_OUT="$S/yy09-baseline.json" npx vitest run test/_tmp/baseline.test.ts`
Expected: PASS, the file written. Record its size.

---

### Task 2: The global rule in `xfadata.ts`, the raw name in `xfatemplate.ts`

**Files:**
- Modify: `src/xfadata.ts` (new `XfaGlobals`, `parseXfaGlobals`; `bindFieldValue` gains `globals?`)
- Modify: `src/xfatemplate.ts` (`XfaField.dataName`, `XfaField.groupGlobal`; `GroupPaths.global`)
- Test: `test/xfadata-global.test.ts` (new), `test/xfatemplate.test.ts` (one case)

**Interfaces:**
- Produces:
  - `export type XfaGlobals = ReadonlyMap<string, string | string[]>;` -- element local name to the FIRST leaf value of that name in document order.
  - `export function parseXfaGlobals(root: XmlNode): XfaGlobals` -- same input as `parseXfaDatasets`.
  - `export function bindFieldValue(field: XfaField, values: XfaValues, globals?: XfaGlobals): string | string[] | undefined`
  - `XfaField.dataName?: string` -- the field's own `name` attribute (always set by `parseXfaTemplate`, optional in the type so hand-built test fields need not state it).
  - `XfaField.groupGlobal?: true` -- set on a radio member whose `<exclGroup>` states `<bind match="global">`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfadata-global.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaDatasets, parseXfaGlobals, bindFieldValue } from '../src/xfadata.js';
import type { XfaField } from '../src/xfatemplate.js';

const root = (inner: string) => parseXml(new TextEncoder().encode(`<datasets><data>${inner}</data></datasets>`));
const both = (inner: string) => { const r = root(inner); return { v: parseXfaDatasets(r), g: parseXfaGlobals(r) }; };
const global = (dataPath: string, dataName: string, extra: Partial<XfaField> = {}): XfaField => ({
  name: dataPath, dataPath, dataName, ui: 'text', readOnly: false, required: false, multiLine: false,
  layouts: [], bindMatch: 'global', ...extra,
});

// XFA 3.3 p. 246-247: "If a global field ... can not be matched directly, a
// match is sought among global data values ... as though [the Data DOM] was
// completely flattened." Designer writes the datum under the outermost group.
describe('bind match="global" (yy09)', () => {
  it('binds a datum stored at the record root, whatever the field depth', () => {
    const { v, g } = both('<top><c1_8>2</c1_8><Page1><Box/></Page1></top>');
    expect(bindFieldValue(global('top[0].Page1[0].Box[0].c1_8[0]', 'c1_8'), v, g)).toBe('2');
  });

  it('prefers the ordinary match at its own data path', () => {
    const { v, g } = both('<top><c1>root</c1><P><c1>own</c1></P></top>');
    expect(bindFieldValue(global('top[0].P[0].c1[0]', 'c1'), v, g)).toBe('own');
  });

  // Review Focus 2: an empty datum is a datum.
  it('takes an EMPTY datum at its own path over a filled one elsewhere', () => {
    const { v, g } = both('<top><c1>root</c1><P><c1/></P></top>');
    expect(bindFieldValue(global('top[0].P[0].c1[0]', 'c1'), v, g)).toBe('');
  });

  // Review Focus 1: the record-0 pick, p. 247.
  it('takes the FIRST same-named value in document order, depth ignored', () => {
    const { v, g } = both('<top><row><c1>a</c1></row><row><c1>b</c1></row><c1>c</c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v, g)).toBe('a');
  });

  // Review Focus 3: a data group is not a value.
  it('never binds a data GROUP of that name', () => {
    const { v, g } = both('<top><c1><x>1</x></c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v, g)).toBeUndefined();
  });

  // p. 247: "Attributes of global data elements can not bind to fields."
  it('never binds an attribute of that name', () => {
    const { v, g } = both('<top c1="attr"><other/></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v, g)).toBeUndefined();
  });

  it('gives every global field of a name the same value', () => {
    const { v, g } = both('<top><cui>2</cui></top>');
    const a = bindFieldValue(global('A[0].cui[0]', 'cui'), v, g);
    const b = bindFieldValue(global('B[0].C[0].cui[0]', 'cui'), v, g);
    expect([a, b]).toEqual(['2', '2']);
  });

  it('does nothing for a field that is not global', () => {
    const { v, g } = both('<top><c1>root</c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1', { bindMatch: undefined }), v, g)).toBeUndefined();
  });

  it('binds as before when no index is passed', () => {
    const { v } = both('<top><c1>root</c1></top>');
    expect(bindFieldValue(global('top[0].X[0].c1[0]', 'c1'), v)).toBeUndefined();
  });

  it('carries a multi-select value whole', () => {
    const { v, g } = both('<top><ls><value>a</value><value>b</value></ls></top>');
    expect(bindFieldValue(global('top[0].X[0].ls[0]', 'ls'), v, g)).toEqual(['a', 'b']);
  });
});
```

Add to `test/xfatemplate.test.ts` (inside its existing top-level `describe`; reuse that file's own template-parsing helper -- read the file's first 30 lines to find its name, and the existing `parseXfaTemplate` import):

```ts
  // yy09: the global search is by the field's OWN name, never a re-split of
  // its data path (an XML name may hold a dot).
  it('records a field\'s raw name and whether its exclGroup is global', () => {
    const tpl = parseXfaTemplate(parseXml(new TextEncoder().encode(`<template><subform name="form1" layout="tb">
      <pageSet><pageArea name="P"><contentArea x="0" y="0" w="8in" h="10in"/></pageArea></pageSet>
      <subform name="S" layout="position" w="8in" h="10in">
        <field name="a.b" x="0" y="0" w="1in" h="12pt"><ui><textEdit/></ui></field>
        <exclGroup name="g"><bind match="global"/>
          <field name="r" w="10pt" h="10pt"><ui><checkButton shape="round"/></ui><items><text>1</text></items></field>
        </exclGroup></subform></subform></template>`)));
    const byName = new Map(tpl.fields.map((f) => [f.name, f]));
    expect([...byName.values()].map((f) => f.dataName)).toEqual(['a.b', 'r']);
    expect(tpl.fields.find((f) => f.dataName === 'r')!.groupGlobal).toBe(true);
    expect(tpl.fields.find((f) => f.dataName === 'a.b')!.groupGlobal).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfadata-global.test.ts test/xfatemplate.test.ts`
Expected: FAIL -- `parseXfaGlobals` is not exported; `dataName` undefined.

- [ ] **Step 3: Implement `parseXfaGlobals` and the global branch**

In `src/xfadata.ts`, after `parseXfaDatasets`:

```ts
/** Element local name to the FIRST leaf value of that name (yy09). */
export type XfaGlobals = ReadonlyMap<string, string | string[]>;

/**
 * The index `bind match="global"` searches (yy09): every data VALUE by its
 * element name, the FIRST in document order winning.
 *
 * XFA 3.3 p. 247: the search "treats the Data DOM as though it was completely
 * flattened", and of several matches picks "the one with the same index as the
 * current record number" -- record 0 here, since record mode is not modelled.
 * A data GROUP is not a value and an ATTRIBUTE never binds ("Attributes of
 * global data elements can not bind to fields"); `collect`'s leaf rule gives
 * both for free, and walking the SAME tree in the SAME order is what keeps the
 * two maps from disagreeing about which datum is first.
 */
export function parseXfaGlobals(root: XmlNode): XfaGlobals {
  const out = new Map<string, string | string[]>();
  const walk = (el: XmlNode): void => {
    for (const c of el.children) {
      if (c.children.some((g) => g.name !== 'value')) walk(c);
      else if (!out.has(c.name)) out.set(c.name, leafValue(c));
    }
  };
  const data = root.name === 'data' ? root : root.children.find((c) => c.name === 'data');
  if (data) walk(data);
  return out;
}
```

Replace the tail of `bindFieldValue` -- the signature and the final `return values.get(field.dataPath);`:

```ts
export function bindFieldValue(
  field: XfaField, values: XfaValues, globals?: XfaGlobals,
): string | string[] | undefined {
```

```ts
  // The DATA path, never the SOM name: an unnamed container is transparent to
  // data binding and has no element in the datasets packet (fdq3).
  const own = values.get(field.dataPath);
  if (own !== undefined || field.bindMatch !== 'global' || globals === undefined) return own;
  // yy09, XFA 3.3 p. 246-247: a global field that does not match directly takes
  // a global datum of its name, shared by every global field so named.
  // STATED DIVERGENCE: p. 247 says that "in non-record mode ... marking a field
  // as global has no effect", and no vendored form enables record mode (no
  // config <record>, p. 531). Read literally, all 175 of the corpus's global
  // fields would bind nothing -- yet Designer stores each such datum once,
  // under the outermost data group, and pdf.js 6.3.289
  // (_findDataByNameToConsume) applies the flattened search regardless. We do
  // the same. Record mode itself is not modelled.
  return field.dataName === undefined ? undefined : globals.get(field.dataName);
```

Note the `match="none"` and explicit-`ref` branches above it are unchanged and return before this point.

- [ ] **Step 4: Record `dataName` and `groupGlobal` in `src/xfatemplate.ts`**

In `interface XfaField`, after `bindMatch?: string;`:

```ts
  /** The field's own `name` attribute: what `bind match="global"` searches the
   *  data for (yy09). Never re-split from a path -- an XML name may hold a dot. */
  dataName?: string;
  /** Its `<exclGroup>` states `<bind match="global">` (yy09) -- reported, not
   *  modelled: p. 176 and p. 348 disagree on whether that is allowed. */
  groupGlobal?: true;
```

Change `interface GroupPaths { som: string; data: string }` to:

```ts
interface GroupPaths { som: string; data: string; global?: true }
```

In `walk`, where a group's paths are built (`c.name === 'exclGroup' ? { som: somName(sub), data: somName(dsub) } : group`), replace with:

```ts
        c.name === 'exclGroup'
          ? { som: somName(sub), data: somName(dsub),
            ...(child(c, 'bind')?.attrs.get('match') === 'global' ? { global: true as const } : {}) }
          : group,
```

In `fieldOf`'s returned object, after `...(bindMatch !== undefined ? { bindMatch } : {}),`:

```ts
    dataName: partial,
    ...(group?.global ? { groupGlobal: true as const } : {}),
```

- [ ] **Step 5: Run the tests, then every xfadata/template test**

Run: `npx vitest run test/xfadata-global.test.ts test/xfadata.test.ts test/xfatemplate.test.ts test/xfatemplate-*.test.ts`
Expected: PASS. (If `test/xfatemplate-*.test.ts` matches nothing on this shell, drop it.)

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/xfadata.ts src/xfatemplate.ts test/xfadata-global.test.ts test/xfatemplate.test.ts
git commit -m "feat(yy09): XFA bind match=global binds the first same-named datum, flattened"
```

---

### Task 3: Wire the converter -- body, master pages, measurer, reports

**Files:**
- Modify: `src/xfaconvert.ts`
- Modify: `test/xfaconvert-master.test.ts` (the yy09-warning case is replaced)
- Test: `test/xfaconvert-global.test.ts` (new)

**Interfaces:**
- Consumes: `parseXfaGlobals`, `XfaGlobals`, `bindFieldValue(field, values, globals?)`, `XfaField.dataName`, `XfaField.groupGlobal` (Task 2).
- Produces: `export function xfaMeasurer(doc: Document, tpl: XfaTemplate, values: XfaValues, globals?: XfaGlobals): XfaMeasure`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfaconvert-global.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const LETTER = '<medium short="8.5in" long="11in"/>';
const DATA = (inner: string) => `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>${inner}</xfa:data></xfa:datasets>`;
const TPL = (body: string, master = '') => `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><occur max="2"/>${LETTER}<contentArea x="0.5in" y="0.5in" w="7.5in" h="9in"/>${master}</pageArea></pageSet>
  <subform name="A" layout="position" w="7.5in" h="9in">${body}</subform>
  <subform name="B" layout="position" w="7.5in" h="9in"/></subform></template>`;
const TEXT = (n: string, bind = '<bind match="global"/>') =>
  `<field name="${n}" x="1in" y="1in" w="2in" h="20pt">${bind}<ui><textEdit/></ui></field>`;
const convert = (template: string, datasets?: string) => {
  const doc = Document.Open(buildXfaPdf({ template, pages: 2, ...(datasets ? { datasets } : {}) }));
  return { doc, r: convertXfaToAcroForm(doc, { removeXfa: false }) };
};

describe('ConvertXfaToAcroForm: bind match="global" (yy09)', () => {
  it('binds a body field to a datum stored at the record root', () => {
    const { doc } = convert(TPL(TEXT('who')), DATA('<form1><who>Ada</who><A/></form1>'));
    expect(doc.Form.Get('form1[0].A[0].who[0]')!.Value).toBe('Ada');
  });

  it('gives every master-page instance the one global value', () => {
    const { doc, r } = convert(TPL('', TEXT('stamp').replace('y="1in"', 'y="10in"')),
      DATA('<form1><stamp>CUI</stamp></form1>'));
    const names = r.fields.filter((f) => f.name.includes('#pageSet')).map((f) => f.name);
    expect(names).toEqual(['form1[0].#pageSet[0].P1[0].stamp[0]', 'form1[0].#pageSet[0].P1[1].stamp[0]']);
    expect(names.map((n) => doc.Form.Get(n)!.Value)).toEqual(['CUI', 'CUI']);
    expect(r.warnings.join('\n')).not.toMatch(/yy09/);
  });

  it('leaves a master-page field with neither dataRef nor global unbound', () => {
    const { doc } = convert(TPL('', TEXT('stamp', '').replace('y="1in"', 'y="10in"')),
      DATA('<form1><stamp>CUI</stamp></form1>'));
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].stamp[0]')!.Value).toBe('');
  });

  it('warns once for a name that is global on one field and ordinary on another', () => {
    const { r } = convert(TPL(TEXT('n') + TEXT('n', '').replace('y="1in"', 'y="3in"')), DATA('<form1><n>x</n></form1>'));
    expect(r.warnings.filter((w) => /"n".*global on some fields and ordinary on others/.test(w))).toHaveLength(1);
  });

  it('warns once for an exclGroup stating match="global", and binds it by its own path', () => {
    const group = `<exclGroup name="g" x="1in" y="4in"><bind match="global"/>
      <field name="r1" w="10pt" h="10pt"><ui><checkButton shape="round"/></ui><items><text>1</text></items></field>
      <field name="r2" x="20pt" w="10pt" h="10pt"><ui><checkButton shape="round"/></ui><items><text>2</text></items></field></exclGroup>`;
    const { r } = convert(TPL(group), DATA('<form1><A><g>2</g></A></form1>'));
    expect(r.warnings.filter((w) => /exclGroup.*match="global"/.test(w))).toHaveLength(1);
  });

  // Review Focus 5: a global choice list bound outside its /Opt is reported, never thrown.
  it('reports a global choice-list datum its /Opt lacks', () => {
    const list = `<field name="pick" x="1in" y="5in" w="2in" h="20pt"><bind match="global"/><ui><choiceList/></ui>
      <items><text>One</text><text>Two</text></items></field>`;
    expect(() => convert(TPL(list), DATA('<form1><pick>Nine</pick></form1>'))).not.toThrow();
  });

  it('measures a growable global field with the value it will carry', () => {
    const grow = `<field name="note" x="1in" y="6in" w="2in" minH="12pt"><bind match="global"/><font typeface="Arial" size="10pt"/><ui><textEdit multiLine="1"/></ui></field>`;
    const long = 'word '.repeat(60).trim();
    const short = convert(TPL(grow), DATA('<form1><note>a</note></form1>'));
    const tall = convert(TPL(grow), DATA(`<form1><note>${long}</note></form1>`));
    const h = (d: Document) => { const r = d.resolve(d.Form.Get('form1[0].A[0].note[0]')!.Dict.get('Rect')) as number[]; return r[3] - r[1]; };
    expect(h(tall.doc)).toBeGreaterThan(h(short.doc));
  });
});
```

In `test/xfaconvert-master.test.ts`, replace the case `'warns that match="global" waits on yy09, and still creates the instances'` with:

```ts
  it('binds match="global" instances and no longer warns about yy09', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt">',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><bind match="global"/>');
    const { doc, r } = convert(T, { pages: 3, datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><stamp>S</stamp></form1></xfa:data></xfa:datasets>' });
    expect(r.warnings.join('\n')).not.toMatch(/yy09/);
    const stamps = r.fields.filter((f) => f.name.includes('stamp')).map((f) => f.name);
    expect(stamps).toHaveLength(2);
    expect(stamps.map((n) => doc.Form.Get(n)!.Value)).toEqual(['S', 'S']);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfaconvert-global.test.ts test/xfaconvert-master.test.ts`
Expected: FAIL -- the body field is unbound, the instances carry `''`, the yy09 warning is present, no mixture or exclGroup warning.

- [ ] **Step 3: Build the index and pass it everywhere**

In `src/xfaconvert.ts`, the import:

```ts
import { parseXfaDatasets, parseXfaDataGroups, parseXfaGlobals, bindFieldValue, type XfaValues, type XfaGlobals } from './xfadata.js';
```

After `const values: XfaValues = ...`:

```ts
  // yy09: the index `bind match="global"` falls back to (xfadata.ts).
  const globals: XfaGlobals = datasetsNode
    ? parseXfaGlobals(datasetsNode) : new Map<string, string | string[]>();
  reportGlobalShapes(tpl, report);
```

Change `const measure = xfaMeasurer(doc, tpl, values);` to `const measure = xfaMeasurer(doc, tpl, values, globals);`.

Change the body binding `baseEntry(f, t, valueFor(f, bindFieldValue(f, values)))` to `baseEntry(f, t, valueFor(f, bindFieldValue(f, values, globals)))`.

Change the `planMasterFields(...)` call to pass `globals` after `values`, and its signature to `values: XfaValues, globals: XfaGlobals, report: XfaConvertReport, ...`.

In `planMasterFields`, replace

```ts
    if (t && f.bindMatch === 'global')
      report.warnings.push(`${f.name}: bind match="global" is not implemented yet (yy09), so its instances carry no data value`);
    const value = t && f.bindMatch === 'dataRef' && (f.bindRef ?? '') !== ''
      ? valueFor(f, bindFieldValue(f, values)) : undefined;
```

with

```ts
    // p. 271: a page-background field binds only by an explicit data
    // reference -- and, by p. 301, to global data (yy09). Anything else stays
    // unbound; every instance shares what binds.
    const binds = (f.bindMatch === 'dataRef' && (f.bindRef ?? '') !== '') || f.bindMatch === 'global';
    const value = t && binds ? valueFor(f, bindFieldValue(f, values, globals)) : undefined;
```

and update the doc comment above `layoutMasters` that ends "`match="global"` is yy09's." to end: "`match="global"` binds by the flattened global search (yy09, p. 301)."

In `xfaMeasurer`, change the signature to `export function xfaMeasurer(doc: Document, tpl: XfaTemplate, values: XfaValues, globals?: XfaGlobals): XfaMeasure` and its call `bindFieldValue(f, values)` to `bindFieldValue(f, values, globals)`.

- [ ] **Step 4: Add `reportGlobalShapes`**

Beside `styleFor` in `src/xfaconvert.ts`:

```ts
/**
 * What `bind match="global"` does not model, reported once each (yy09).
 *
 * - p. 247: "Fields in the template sharing the same name must either be all
 *   global or all non-global. A mixture ... is not supported." Each field still
 *   follows its own rule.
 * - An `<exclGroup>` stating global: p. 176 allows global on a field only,
 *   p. 348 on an exclusion group too, and no vendored form has one. The group
 *   binds by its own data path, as before.
 */
function reportGlobalShapes(tpl: XfaTemplate, report: XfaConvertReport): void {
  const kinds = new Map<string, Set<boolean>>();
  for (const f of [...tpl.fields, ...tpl.masterPageFields]) {
    if (f.dataName === undefined) continue;
    const s = kinds.get(f.dataName) ?? new Set<boolean>();
    s.add(f.bindMatch === 'global');
    kinds.set(f.dataName, s);
  }
  for (const [name, s] of kinds)
    if (s.size > 1)
      report.warnings.push(`fields named "${name}" are global on some fields and ordinary on others, `
        + 'which XFA 3.3 p. 247 does not support; each binds by its own rule');
  const groups = new Set(tpl.fields.filter((f) => f.groupGlobal && f.group !== undefined).map((f) => f.group!));
  for (const g of groups)
    report.warnings.push(`${g}: an <exclGroup> with bind match="global" binds by its own data path; `
      + 'XFA 3.3 p. 176 and p. 348 disagree on whether a group may be global');
}
```

- [ ] **Step 5: Run the new and every converter test**

Run: `npx vitest run test/xfaconvert-global.test.ts test/xfaconvert-master.test.ts test/xfaconvert*.test.ts test/xfa-real.test.ts test/xfa-master-oracle.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-chrome-oracle.test.ts test/xfa-chrome-fence.test.ts`
Expected: PASS. If an ORACLE file fails, stop: that is a result, not a fixture to edit -- investigate and report it.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/xfaconvert.ts test/xfaconvert-global.test.ts test/xfaconvert-master.test.ts
git commit -m "feat(yy09): global binding for body and master-page fields; report mixtures and global exclGroups"
```

---

### Task 4: A reconciled checkbox takes its datum as a boolean; real-data checks; baseline diff

`applyReconcile` hands every datum to the field's `Value` setter as a string, and a checkbox's setter accepts only a boolean -- so every reconciled checkbox datum fails today (I-130 already reports 75 "refused the data value (checkbox value must be a boolean)" skips, all on blank data). Global binding routes f1040's and fw9's checkbox data down the same path, so the real-data outcome is a refusal until this is fixed.

**Files:**
- Modify: `src/xfaconvert.ts` (`valueFor`, `applyReconcile`)
- Modify: `test/helpers/xfa-dynamic.ts` (export `editPacket`)
- Test: `test/xfaconvert-global-real.test.ts` (new)

**Interfaces:**
- Consumes: Task 3's wiring.
- Produces: `export function editPacket(doc: Document, name: string, re: RegExp, f: (m: string) => string): void` in `test/helpers/xfa-dynamic.ts` -- the existing private `once` + `edit` pair, exported.

- [ ] **Step 1: Export the packet editor**

In `test/helpers/xfa-dynamic.ts`, after `function edit(...)`:

```ts
/** Replace the ONE match of `re` in a packet, or throw (yy09 uses it on the
 *  hybrids' datasets, which are blank as vendored). */
export function editPacket(doc: Document, name: string, re: RegExp, f: (m: string) => string): void {
  edit(doc, name, (s) => once(s, re, f));
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/xfaconvert-global-real.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { editPacket } from './helpers/xfa-dynamic.js';

const open = (f: string) => Document.Open(new Uint8Array(readFileSync(`test/fixtures/${f}`)));

describe('global binding on real forms (yy09)', () => {
  // IRS f1040 (Designer 6.5, hybrid). Five checkboxes named c1_8 share one
  // global datum, written once as topmostSubform.c1_8 -- not at any field's
  // own path. On-states 1..5; the vendored datum is "0" (none checked).
  it('f1040: the c1_8 checkbox whose on-state is the datum is the one checked', () => {
    const doc = open('xfa/irs-f1040.pdf');
    editPacket(doc, 'datasets', /<c1_8\s*>0<\/c1_8\s*>/, () => '<c1_8>2</c1_8>');
    const r = doc.ConvertXfaToAcroForm();
    const P = 'topmostSubform[0].Page1[0].';
    const names = [`${P}Checkbox_ReadOrder[0].c1_8[0]`, `${P}Checkbox_ReadOrder[0].c1_8[1]`,
      `${P}Checkbox_ReadOrder[0].c1_8[2]`, `${P}c1_8[0]`, `${P}c1_8[1]`];
    expect(names.map((n) => doc.Form.Get(n)!.Value)).toEqual([false, true, false, false, false]);
    expect(r.skipped.filter((s) => /refused the data value/.test(s.reason))).toEqual([]);
  });

  // Review Focus 4.
  it('hybrids: a blank or "0" checkbox datum is no refusal, and leaves the box off', () => {
    for (const f of ['xfa/irs-f1040.pdf', 'xfa/irs-fw9.pdf', 'xfa/uscis-i130.pdf', 'xfa/uscis-i765.pdf']) {
      const doc = open(f);
      const r = doc.ConvertXfaToAcroForm();
      expect(r.skipped.filter((s) => /checkbox value must be a boolean/.test(s.reason)), f).toEqual([]);
    }
  });

  // OPM 1644 (dynamic). checkbox1[0] and [1] (on VA, OR) share the global
  // datum OF1644.checkbox1, "Off" as vendored. pdf.js 6.3.289's rule names the
  // same datum: no ordinary match within three data levels of the field, so
  // the first checkbox1 anywhere -- derived from the transcribed rule, not by
  // running pdf.js.
  it('OPM 1644: the global checkbox1 pair binds the root datum', () => {
    const doc = open('xfa-dynamic/opm1644.pdf');
    editPacket(doc, 'datasets', /<checkbox1\s*>Off<\/checkbox1\s*>/, () => '<checkbox1>OR</checkbox1>');
    doc.ConvertXfaToAcroForm();
    const B = 'OF1644[0].Page1[0].SectionIIIpt2[0].Row4[0].Subformc1[0].#subform[0].';
    expect([`${B}checkbox1[0]`, `${B}checkbox1[1]`].map((n) => doc.Form.Get(n)!.Value)).toEqual([false, true]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/xfaconvert-global-real.test.ts`
Expected: FAIL -- f1040 reports "checkbox value must be a boolean" refusals and every box stays false; i130 reports 75. (OPM 1644 is a DYNAMIC form, whose fields are CREATED through `specFor`, which already compares the datum with the on-state -- that case may pass already; it pins Task 3's wiring.)

- [ ] **Step 4: Fix `valueFor` and `applyReconcile`**

In `valueFor`, replace the body with:

```ts
function valueFor(f: XfaField, bound: string | string[] | undefined): string | string[] | undefined {
  // An EMPTY datum on a choice list, or on a check box, is no value: no
  // selection, and no state to set (cb07, yy09).
  return (f.ui === 'choiceList' || f.ui === 'checkButton') && bound === '' ? undefined : bound;
}
```

and extend its doc comment with: "A blank check-box datum is the same nothing: I-130's datasets bind `''` to 75 of them."

In `applyReconcile`, replace `f.Value = e.value;` with:

```ts
    // A check box's Value is a BOOLEAN: on exactly when the datum is its
    // on-state. Handed the datum string, the setter refused every one (yy09).
    // `specFor` makes the same comparison for a field it creates.
    f.Value = f.Type === 'checkbox' && typeof e.value === 'string' && e.onState !== undefined
      ? e.value === e.onState : e.value;
```

Before relying on `f.Type`, confirm the accessor's name in `src/formfield.ts` (`grep -n "get Type" src/formfield.ts`); if it is named otherwise, use that name.

- [ ] **Step 5: Run the new and every converter test**

Run: `npx vitest run test/xfaconvert-global-real.test.ts test/xfaconvert*.test.ts test/xfa-real.test.ts test/xfa-master-oracle.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-chrome-oracle.test.ts test/xfa-chrome-fence.test.ts`
Expected: PASS, oracles unedited.

- [ ] **Step 6: Diff against the baseline**

Run: `YY09_OUT="$S/yy09-after.json" npx vitest run test/_tmp/baseline.test.ts`, then compare the two JSON files with a node script (written with the Write tool) that prints, per form: skips removed, skips added, warnings removed and added, and every field whose `Value` changed. Expected: the 75 I-130 checkbox refusals removed; global fields gaining blank values (`''` or `false`) where they had none; the yy09 warnings removed from DD 2875 and DD 1494; NO other change. Every difference outside that list is investigated and either explained in the CHANGELOG entry or fixed before continuing. Then delete `test/_tmp/`.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/xfaconvert.ts test/helpers/xfa-dynamic.ts test/xfaconvert-global-real.test.ts
git commit -m "fix(yy09): a reconciled XFA checkbox takes its datum as a boolean; global binding on f1040 and OPM 1644"
```

---

### Task 5: Mutation sweep, documentation, close

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Full gates**

```bash
npm run typecheck
npm test
```

Expected: green. Record file and test counts.

- [ ] **Step 2: Mutation sweep**

Apply each with a node script (Write tool), confirm the file changed, run the named tests, restore. Kill orphaned vitest workers after any hang.

| # | Mutation | Expected red in |
|---|---|---|
| 1 | `bindFieldValue` consults `globals` BEFORE the own-path value | `xfadata-global` (prefers ordinary; empty datum) |
| 2 | `parseXfaGlobals` lets a later value overwrite (`out.set` without `!out.has`) | `xfadata-global` (first in document order) |
| 3 | `parseXfaGlobals` records a data group's `text` instead of recursing | `xfadata-global` (never a group) |
| 4 | global branch ignores `bindMatch` (any field falls back) | `xfadata-global` (not global) |
| 5 | `planMasterFields` binds only `dataRef` again | `xfaconvert-global`, `xfaconvert-master` |
| 6 | `xfaMeasurer` drops `globals` | `xfaconvert-global` (measures) |
| 7 | `reportGlobalShapes` not called | `xfaconvert-global` (two warnings) |
| 8 | `applyReconcile` passes the string again | `xfaconvert-global-real` |
| 9 | `valueFor` drops the check-box blank rule | `xfaconvert-global-real` (Review Focus 4) |
| 10 | `dataName` set from `somName(path)` instead of `partial` | `xfatemplate`, `xfadata-global` via converter |

A mutation that stays green gets a case in its task's test file, or is recorded in CLAUDE.md as an equivalent mutant or redundant defence with the reason.

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]`, in `### Added`:

```markdown
- **`ConvertXfaToAcroForm` binds `<bind match="global">` fields.** Designer marks a field global when one datum belongs in several places -- a name repeated on every page of a USCIS form, a group of IRS check boxes that act as one choice, a CUI marking on every page of a DoD form -- and stores that datum once, directly under the outermost data group, whatever the field's own depth. Such a field was bound only at its own data path, found nothing there, and converted with no value; on a master page every instance was created empty and a warning said so. A global field now takes a datum at its own path when there is one, and otherwise the first data value of its name anywhere in the data, which every global field of that name shares, master-page instances included (XFA 3.3 p. 246-247, 301). XFA 3.3 p. 247 says global binding has no effect without record mode, which none of the 175 global fields found in the vendored forms enables; we follow Designer's data layout and pdf.js's binder instead, and say so beside the code. A name that is global on some fields and ordinary on others, and an `<exclGroup>` stating global, are reported in `warnings`. (aspose-pdf-foss-for-ts-yy09)
```

In `### Fixed`:

```markdown
- **An XFA hybrid's check boxes now take their data.** Converting a hybrid form handed each check box's datum to the field as a string, which a check box refuses, so every one was reported "refused the data value" and kept whatever state it had -- 75 such reports on a blank USCIS I-130 alone. A check box is now on exactly when its datum is its on-state, and a blank datum sets nothing. (aspose-pdf-foss-for-ts-yy09)
```

- [ ] **Step 4: CLAUDE.md**

Under the `xfapacket.ts`, `xfatemplate.ts`, `xfadata.ts` … entry, after the `c3jq` paragraph, add:

```markdown
  **Invariant (`yy09`):** `bind match="global"` binds the field's OWN data
  path first and, only when that holds nothing, the FIRST data value of the
  field's name anywhere in the data (`parseXfaGlobals`, built in the same
  document-order walk as the value map), shared by every global field so named
  -- body and master-page instances alike (p. 246-247, 301). An empty datum at
  the own path is still a match; a data GROUP and an attribute never are.
  **Note, a STATED DIVERGENCE:** p. 247 says global has "no effect" without
  record mode, and no vendored form has a config `<record>` (p. 531). Designer
  nevertheless writes every global datum once under the outermost group, and
  pdf.js 6.3.289's binder applies the flattened search regardless; read
  literally, all 175 global fields in the corpus would bind nothing. Record
  mode itself is not modelled. pdf.js never binds a `<pageArea>` field, so it
  corroborates the body half only.
  **Invariant:** the search is by `XfaField.dataName`, the raw `name`
  attribute, never a re-split of a data path -- an XML name may hold a dot.
  **Note:** a name global on some fields and ordinary on others (p. 247: "not
  supported"), and an `<exclGroup>` stating global (p. 176 and p. 348
  disagree), are each one warning; neither changes binding.
  **Invariant (`yy09`, `applyReconcile`):** a reconciled check box's `Value`
  is a BOOLEAN, on exactly when the datum is its on-state -- the comparison
  `specFor` already makes for a created field. Handed the datum string, the
  setter refused every check box on every hybrid, silently but for a skip.
  A blank check-box datum sets nothing, as a blank choice-list datum does.
  **Note, measured:** <the sweep's result -- N of 10 redden, and any recorded
  equivalent or redundant mutant with its reason>.
```

Replace `<the sweep's result ...>` with the actual Step 2 outcome before committing. Also replace "`match="global"` is reported in `warnings` and waits on its own issue" in the `d3mq` paragraph with "`match="global"` binds by the flattened global search (`yy09`)".

- [ ] **Step 5: README**

In the "Convert an XFA Form to an AcroForm" section, after the sentence about hybrid reconciliation, add: "A field marked `<bind match="global">` takes the one datum Designer stores for it, shared by every field of its name, master-page instances included." Run `npx vitest run test/readme-api.test.ts`.

- [ ] **Step 6: Final gates, close, push**

```bash
npm run typecheck
npm test
git add CHANGELOG.md CLAUDE.md README.md
git commit -m "docs(yy09): CHANGELOG, CLAUDE.md, README"
bd close yy09 --reason "bind match=global binds own path, else the first same-named datum anywhere, shared by every global field (body and master instances); stated divergence from XFA 3.3 p. 247 recorded; reconciled checkboxes take their datum as a boolean (I-130's 75 refusals gone)."
git pull --rebase
git push
git status
```

Expected: `git status` shows up to date with origin. The beads export (`.beads/interactions.jsonl`) is committed and pushed too.
