# XMP Value-Type Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ValidatePdfA` reports an XMP property whose value does not match its predefined or described type (`XmpValueType`, parts 1–3), and `ConvertToPdfA` repairs lossless shape mismatches.

**Architecture:** the generator replays veraPDF's registration sequence, closed-choice OFF, into typed data tables. `src/xmptypes.ts` ports `ValidatorsContainer` over the `xmprdf.ts` model. `src/pdfavaluetypes.ts` resolves each top-level property's type (own extension schemas → catalog's → predefined), reports mismatches and proposes shape repairs. `pdfavalidate.ts` gains the rule; `pdfaconvert.ts` gains a pass whose document side lives in `pdfaextfix.ts`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest, node (generator).

**Spec:** `docs/superpowers/specs/2026-09-24-xmp-value-types-design.md`

## Global Constraints

- No runtime dependencies. Every `catch` in `src/` calls `rethrowLimit(e)` first.
- veraPDF pin stays `60f8f1dc236adb536c3a935488cd6a56a650c941`; the generator reads only the six files it already caches under `verapdf/<commit>/`.
- Closed-choice checking is OFF (the validator's constructors): restricted fields register their OPEN type.
- Report once: a property with no resolved type is never reported by `XmpValueType`.
- Divergences, stated: XPath accepts any simple value; Date is XMPCore's `ISO8601Converter.parse` grammar, empty string valid.
- Rule only at parts 1–3, citing `ISO 19005-1 §6.7.9` / `ISO 19005-{2,3} §6.6.2.3.1`.
- New `ConvertCategory` `'xmpValueTypes'`; a repair is kept only if the result validates.
- Every export from `index.ts` needs a README row (`test/readme-api.test.ts`); the new `ConvertCategory` value needs no new export.
- CHANGELOG **Added** citing `(o6uu.10)`; commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before closing: `npm run typecheck` and `npm test` green; `test/import-cycles.test.ts` green.

## Review Focus

1. A predefined property redefined by an extension schema must validate against the EXTENSION's type, not the predefined one. Pinned in Task 3.
2. A packet that fails to parse must not throw from the rule or the pass; it is skipped. Pinned in Task 3 (rule) and Task 4 (pass).
3. A property named `constructor` or `__proto__` in a known namespace must not resolve a type through `Object.prototype`. Pinned in Task 3.
4. A repair must not change the TEXT a Lang Alt title reads back as, nor /Info's mirror. Pinned in Task 4.
5. The vendored Acrobat and calibre packets must produce no `XmpValueType` issue. Pinned in Task 3.

---

### Task 1: Generator — typed tables

**Files:**
- Modify: `scripts/gen-xmp-schemas.mjs`, `src/xmpschemadata.ts` (regenerated)
- Test: `test/xmpschemadata.test.ts`

**Interfaces:**
- Produces in `src/xmpschemadata.ts`:
  - `PROPERTY_TYPES_2004`, `PROPERTY_TYPES_2005`: `Readonly<Record<string, Readonly<Record<string, string>>>>` (namespace → name → type)
  - `STRUCT_TYPES_2004`, `STRUCT_TYPES_2005`: `Readonly<Record<string, { readonly ns: string; readonly fields: Readonly<Record<string, string>> }>>`
  - `SIMPLE_PATTERNS_2004`, `SIMPLE_PATTERNS_2005`: `Readonly<Record<string, string>>` (simplified type → Java regex source, unescaped)
  - `PREDEFINED_*`, `BASE_VALUE_TYPES`, `VALUE_TYPES_*`: unchanged names and shapes.

- [ ] **Step 1: Write the failing test**

```ts
// test/xmpschemadata.test.ts
import { describe, it, expect } from 'vitest';
import {
  PROPERTY_TYPES_2004, PROPERTY_TYPES_2005, STRUCT_TYPES_2004, STRUCT_TYPES_2005,
  SIMPLE_PATTERNS_2004, SIMPLE_PATTERNS_2005, PREDEFINED_2004, PREDEFINED_2005, VALUE_TYPES_2004, VALUE_TYPES_2005,
} from '../src/xmpschemadata.js';
import { isKnownValueType } from '../src/xmpschemas.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const PDFAID = 'http://www.aiim.org/pdfa/ns/id/';
const TIFF = 'http://ns.adobe.com/tiff/1.0/';

describe('generated type tables', () => {
  it('carry veraPDF\'s property types', () => {
    for (const t of [PROPERTY_TYPES_2004, PROPERTY_TYPES_2005]) {
      expect(t[DC].title).toBe('lang alt');
      expect(t[DC].creator).toBe('seq propername');
      expect(t[DC].contributor).toBe('bag propername');
      expect(t[XMP].CreateDate).toBe('date');
      expect(t[XMP].Thumbnails).toBe('alt thumbnail');
      expect(t[PDFAID].part).toBe('integer');
      expect(t[PDFAID].conformance).toBe('text');       // closed choice OFF: the open type
      expect(t[TIFF].Compression).toBe('integer');
      expect(t[TIFF].YCbCrSubSampling).toBe('seq integer');
    }
    expect(PROPERTY_TYPES_2004[PDFAID].corr).toBeUndefined();
    expect(PROPERTY_TYPES_2005[PDFAID].corr).toBe('text');
  });

  it('name exactly the predefined properties, every one with a known type', () => {
    for (const [types, names, known] of [[PROPERTY_TYPES_2004, PREDEFINED_2004, VALUE_TYPES_2004],
      [PROPERTY_TYPES_2005, PREDEFINED_2005, VALUE_TYPES_2005]] as const) {
      expect(Object.keys(types).sort()).toEqual(Object.keys(names).sort());
      for (const ns of Object.keys(names)) expect(Object.keys(types[ns]).sort()).toEqual([...names[ns]].sort());
      const set = new Set(known);
      for (const ns of Object.keys(types))
        for (const type of Object.values(types[ns])) expect(isKnownValueType(type, set), type).toBe(true);
    }
  });

  it('carry the structured types, restricted fields merged under their open types', () => {
    const dims = STRUCT_TYPES_2004.dimensions;
    expect(dims.ns).toMatch(/Dimensions#$/);
    expect(dims.fields).toEqual({ w: 'real', h: 'real', unit: 'text' });
    expect(STRUCT_TYPES_2005.thumbnail.fields).toEqual({ height: 'integer', width: 'integer', image: 'text', format: 'text' });
    expect(STRUCT_TYPES_2004.colorant).toBeUndefined();
    expect(STRUCT_TYPES_2005.colorant).toBeDefined();
  });

  it('carry the simple patterns, GPSCoordinate differing by era', () => {
    expect(SIMPLE_PATTERNS_2004.boolean).toBe('^True$|^False$');
    expect(SIMPLE_PATTERNS_2004.integer).toBe('^[+-]?\\d+$');
    expect(SIMPLE_PATTERNS_2004.text).toBe('(?s)(^.*$)');
    expect(SIMPLE_PATTERNS_2004.gpscoordinate).not.toBe(SIMPLE_PATTERNS_2005.gpscoordinate);
    expect(SIMPLE_PATTERNS_2005.locale).toBe('(?s)(^.*$)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/xmpschemadata.test.ts`
Expected: FAIL — `PROPERTY_TYPES_2004` is not exported.

- [ ] **Step 3: Extend the generator**

In `scripts/gen-xmp-schemas.mjs`:

(a) After `literal`, add a Java-string unescape, an expression evaluator and a call walker:

```js
const unescapeJava = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));

/** Balanced-paren argument list of every call to one of `names` in `body`,
 *  in textual order. */
function* callsIn(body, names) {
  const re = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'g');
  for (let m = re.exec(body); m; m = re.exec(body)) {
    let depth = 1; let i = re.lastIndex; const start = i;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '"') { i++; while (body[i] !== '"') i += body[i] === '\\' ? 2 : 1; }
      else if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    yield { fn: m[1], args: tokens(body.slice(start, i - 1)) };
  }
}
```

(b) Inside `main`, after `nsOf`, add the evaluator (it needs `strConst`, `tableOf`, `nsUri`):

```js
  /** A Java String expression: literals and constants joined by `+`. */
  const evalString = (expr) => expr.split('+').map((part) => {
    const p = part.trim();
    if (p.startsWith('"')) return unescapeJava(literal(p));
    const c = p.replace(/^XMPConstants\./, '');
    return strConst.get(c) ?? fail(`constant ${p} not found`);
  }).join('');
  /** A call argument: a namespace constant, a local table element, or a string. */
  const argOf = (tok, locals) => {
    let m = /^XMPConst\.(\w+)$/.exec(tok);
    if (m) return nsUri.get(m[1]) ?? fail(`XMPConst.${m[1]}`);
    m = /^(\w+)\[(\d+)\]$/.exec(tok);
    if (m) { const el = (locals.get(m[1]) ?? fail(`local ${m[1]}`))[Number(m[2])]; return /^XMPConst\./.test(el) ? nsOf(el) : evalString(el); }
    return evalString(tok);
  };
  /** veraPDF's isKnownType against a known set. */
  const ARR = ['bag', 'seq', 'alt'];
  const simplify = (type) => {
    let res = type.toLowerCase().replace(/(open |closed )?(choice |choice$)(of )?/g, '').trim();
    if (res === '') return 'text';
    if (res.endsWith('lang alt')) return res;
    for (const a of ARR) if (res.endsWith(a)) { res += ' text'; break; }
    return res;
  };
  const isKnown = (type, known) => {
    let t = simplify(type);
    for (let peeled = true; peeled;) { peeled = false; for (const a of ARR) if (t.startsWith(`${a} `)) { t = t.slice(a.length + 1); peeled = true; break; } }
    return known.has(t);
  };
```

(c) Replace `propertiesOf` with a typed replay (keep `basic`/`era` names working by deriving them), placed AFTER `t2004`/`t2005` are computed — move the value-type block (`EMPTY_VALIDATORS_CONTAINER` check through `t2005`) above it:

```js
  /** (ns, name, type) registrations a creator method makes, in order. */
  function registrationsOf(method) {
    const body = methodBody(text.creator, method);
    const locals = new Map();
    for (const m of body.matchAll(/String\[\]\s+(\w+)\s*=\s*XMPConstants\.(get\w+)\(\)/g)) locals.set(m[1], tableOf(m[2]));
    const out = [];
    for (const { fn, args } of callsIn(body, ['registerStructureTypeForSchema', 'registerRestrictedSimpleFieldForSchema',
      'registerSeqChoiceFieldForSchema', 'registerRestrictedSeqTextFieldForSchema'])) {
      if (fn === 'registerStructureTypeForSchema' || fn === 'registerRestrictedSimpleFieldForSchema') {
        const g = /^XMPConstants\.(get\w+)\(\)$/.exec(args[0]) ?? fail(`${fn}(${args[0]})`);
        const t = tableOf(g[1]);
        const stride = fn === 'registerStructureTypeForSchema' ? 2 : 3;
        const ns = nsOf(t[0]);
        for (let i = 1; i < t.length; i += stride) out.push([ns, literal(t[i]), evalString(t[i + 1])]);
      } else {
        // registerSeqChoiceFieldForSchema(ns, name, choices, TYPE, …) and
        // registerRestrictedSeqTextFieldForSchema(ns, name, regex, TYPE, …):
        // closed-choice OFF registers argument 3, the open type.
        out.push([argOf(args[0], locals), argOf(args[1], locals), argOf(args[3], locals)]);
      }
    }
    if (out.length === 0) fail(`${method} registered nothing`);
    return out;
  }
  /** veraPDF's SchemasDefinition.registerProperty: unknown types and repeats dropped. */
  const replay = (method, known) => {
    const map = new Map();
    const unfiltered = new Map();
    for (const [ns, n, type] of [...registrationsOf('createBasicSchemasDefinition'), ...registrationsOf(method)]) {
      if (!unfiltered.has(ns)) unfiltered.set(ns, new Set());
      unfiltered.get(ns).add(n);
      if (!isKnown(type, known)) continue;
      if (!map.has(ns)) map.set(ns, new Map());
      if (!map.get(ns).has(n)) map.get(ns).set(n, type);
    }
    // Fence: the o6uu.6 name set must be exactly what veraPDF registers.
    for (const [ns, names] of unfiltered) for (const n of names)
      if (!map.get(ns)?.has(n)) fail(`${method}: ${ns} ${n} is named but not registered (unknown type or repeat)`);
    return map;
  };
  const types2004 = replay('createPredefinedPDFA_1SchemasDefinition', t2004);
  const types2005 = replay('createPredefinedPDFA_2_3SchemasDefinition', t2005);
  const namesOf = (types) => new Map([...types].map(([ns, m]) => [ns, new Set(m.keys())]));
  const p2004 = namesOf(types2004);
  const p2005 = namesOf(types2005);
```

(d) Structured types and patterns, after the replay:

```js
  /** Structured types a ValidatorsContainerCreator method registers. */
  function structsOf(method) {
    const out = new Map();
    for (const { fn, args } of callsIn(methodBody(text.validators, method),
      ['registerStructureTypeForContainer', 'registerStructureTypeWithRestrictedSimpleFieldsForContainer'])) {
      const name = simplify(typeName(/^XMPConstants\.(\w+)$/.exec(args[0])?.[1] ?? fail(`struct ${args[0]}`)));
      const table = (tok) => tableOf((/^XMPConstants\.(get\w+)\(\)$/.exec(tok) ?? fail(`table ${tok}`))[1]);
      const main = table(fn === 'registerStructureTypeForContainer' ? args[1] : args[2]);
      const fields = {};
      for (let i = 1; i < main.length; i += 2) fields[literal(main[i])] = evalString(main[i + 1]);
      if (fn !== 'registerStructureTypeForContainer') {
        const closed = table(args[3]);
        for (let i = 0; i < closed.length; i += 3) fields[literal(closed[i])] = evalString(closed[i + 1]);
      }
      out.set(name, { ns: nsOf(main[0]), fields });
    }
    return out;
  }
  const structsBasic = structsOf('createBasicValidatorsContainer');
  const structs2004 = new Map([...structsBasic, ...structsOf('createValidatorsContainerPredefinedForPDFA_1')]);
  const structs2005 = new Map([...structsBasic, ...structsOf('createValidatorsContainerPredefinedForPDFA_2_3')]);

  const simplePatterns = new Map();
  for (const m of text.simple.matchAll(/\b[A-Z_]+\(\s*XMPConstants\.(\w+)\s*,\s*("(?:[^"\\]|\\.)*")\s*\)/g))
    simplePatterns.set(typeName(m[1]), unescapeJava(literal(m[2])));
  const eraPatterns = (method) => {
    const out = new Map(simplePatterns);
    for (const m of methodBody(text.validators, method)
      .matchAll(/registerSimpleValidator\(\s*XMPConstants\.(\w+)\s*,\s*Pattern\.compile\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*\)/g))
      out.set(typeName(m[1]), unescapeJava(literal(m[2])));
    return out;
  };
  const pat2004 = eraPatterns('createValidatorsContainerPredefinedForPDFA_1');
  const pat2005 = eraPatterns('createValidatorsContainerPredefinedForPDFA_2_3');
  // Fence: every simple-pattern and struct name must be a known type of its era.
  for (const [k, set] of [[pat2004, t2004], [pat2005, t2005], [structs2004, t2004], [structs2005, t2005]])
    for (const n of k.keys()) if (!set.has(n)) fail(`${n} is registered but not a known type`);
```

(e) Emit the new tables. Add these helpers beside `table`:

```js
  const obj = (m) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
  const typesTable = (map) => `{\n${[...map.keys()].sort().map((ns) => `  ${JSON.stringify(ns)}: ${JSON.stringify(obj(map.get(ns)))},`).join('\n')}\n}`;
  const structTable = (map) => `{\n${[...map.keys()].sort().map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify({ ns: map.get(n).ns, fields: map.get(n).fields })},`).join('\n')}\n}`;
```

and append to the `out` template, after `VALUE_TYPES_2005`:

```js
/** Predefined property TYPES for PDF/A-1 (XMP 2004), as veraPDF registers them
 *  with closed-choice checking OFF — a restricted field carries its open type. */
export const PROPERTY_TYPES_2004: Readonly<Record<string, Readonly<Record<string, string>>>> = ${typesTable(types2004)};

/** Predefined property TYPES for PDF/A-2 and -3 (XMP 2005). */
export const PROPERTY_TYPES_2005: Readonly<Record<string, Readonly<Record<string, string>>>> = ${typesTable(types2005)};

/** Structured value types for PDF/A-1: simplified name → field namespace and field types. */
export const STRUCT_TYPES_2004: Readonly<Record<string, { readonly ns: string; readonly fields: Readonly<Record<string, string>> }>> = ${structTable(structs2004)};

/** Structured value types for PDF/A-2 and -3. */
export const STRUCT_TYPES_2005: Readonly<Record<string, { readonly ns: string; readonly fields: Readonly<Record<string, string>> }>> = ${structTable(structs2005)};

/** Simple types for PDF/A-1: simplified name → Java regex source (whole-value match). */
export const SIMPLE_PATTERNS_2004: Readonly<Record<string, string>> = ${JSON.stringify(obj(pat2004), null, 2)};

/** Simple types for PDF/A-2 and -3. */
export const SIMPLE_PATTERNS_2005: Readonly<Record<string, string>> = ${JSON.stringify(obj(pat2005), null, 2)};
```

Update the header comment's source list (add nothing — same six files) and the console summary to also print struct and pattern counts.

- [ ] **Step 4: Regenerate and check the committed name tables did not move**

Run: `npm run gen:xmpschemas && git diff --stat src/xmpschemadata.ts && git diff src/xmpschemadata.ts | grep '^[-+]export const PREDEFINED' | head`
Expected: the generator prints its counts and exits 0; the diff touches only the new tables (no `PREDEFINED_`/`VALUE_TYPES`/`BASE_VALUE_TYPES` line changes). If the fence in (c) fails, a name o6uu.6 treats as predefined is one veraPDF drops — stop and ledger a ruling: the filtered set is veraPDF's truth, `PREDEFINED_*` follows it, and CHANGELOG gains a **Fixed** line.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/xmpschemadata.test.ts test/xmpschemas.test.ts test/pdfaext.test.ts test/pdfa-extension-validate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-xmp-schemas.mjs src/xmpschemadata.ts test/xmpschemadata.test.ts
git commit -m "feat(o6uu.10): generate XMP property types, struct types and simple patterns"
```

---

### Task 2: `src/xmptypes.ts` — the validator

**Files:**
- Create: `src/xmptypes.ts`
- Test: `test/xmptypes.test.ts`

**Interfaces:**
- Consumes: Task 1's `STRUCT_TYPES_*`, `SIMPLE_PATTERNS_*`; `xmpschemas.ts`'s `simplifyValueType`, `XmpEra`, `VALUE_TYPES_*`.
- Produces:
  - `class XmpTypeRegistry { static forEra(era: XmpEra): XmpTypeRegistry; extend(valueTypes: RdfValue | undefined): XmpTypeRegistry; isKnownType(type: string): boolean; validate(value: RdfValue, type: string): boolean; knownTypes(): string[] }`
  - `isXmpDate(s: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// test/xmptypes.test.ts
import { describe, it, expect } from 'vitest';
import { XmpTypeRegistry, isXmpDate } from '../src/xmptypes.js';
import { VALUE_TYPES_2004, VALUE_TYPES_2005 } from '../src/xmpschemadata.js';
import type { RdfValue } from '../src/xmprdf.js';

const S = (value: string): RdfValue => ({ kind: 'simple', value });
const A = (form: 'Bag' | 'Seq' | 'Alt', ...items: (RdfValue | [RdfValue, string])[]): RdfValue =>
  ({ kind: 'array', form, items: items.map((i) => (Array.isArray(i) ? { value: i[0], lang: i[1] } : { value: i })) });
const DIM = 'http://ns.adobe.com/xap/1.0/sType/Dimensions#';
const St = (ns: string, f: Record<string, RdfValue>): RdfValue =>
  ({ kind: 'struct', fields: Object.entries(f).map(([name, value]) => ({ ns, name, value })) });
const r04 = XmpTypeRegistry.forEra('2004');
const r05 = XmpTypeRegistry.forEra('2005');

describe('isXmpDate — XMPCore ISO8601Converter.parse', () => {
  it.each(['', '2024', '-0044', '2024-06', '2024-06-03', '2024-06-03T12', '2024-06-03T12:30', '2024-06-03T12Z',
    '2024-06-03T12:30:45Z', '2024-06-03T12:30:45.123+02:00', '2024-13-40T99:99', '2024-06-03T12:30+0200'])('accepts %j', (s) =>
    expect(isXmpDate(s)).toBe(true));
  it.each(['yesterday', '2024/06/03', '2024-06-03 12:30', '2024-06-03X', '2024-06-03T', '2024-06-03T12:30:45Zjunk',
    '2024-06-03T12:30:45+02-00', '2024-06-03T12:30:45.', '2024-06-03T12.5', 'T12', '2024-'])('refuses %j', (s) =>
    expect(isXmpDate(s)).toBe(false));
});

describe('XmpTypeRegistry', () => {
  it('knows exactly its era\'s types', () => {
    expect(r04.knownTypes().sort()).toEqual([...VALUE_TYPES_2004].sort());
    expect(r05.knownTypes().sort()).toEqual([...VALUE_TYPES_2005].sort());
    expect(r05.isKnownType('Seq ProperName')).toBe(true);
    expect(r05.isKnownType('closed Choice of Integer')).toBe(true);
    expect(r05.isKnownType('Nonsense')).toBe(false);
  });

  it('matches simple patterns against the WHOLE value', () => {
    expect(r05.validate(S('+12'), 'Integer')).toBe(true);
    expect(r05.validate(S('1.5'), 'Integer')).toBe(false);
    for (const v of ['1.', '.5', '-3.25', '7']) expect(r05.validate(S(v), 'Real'), v).toBe(true);
    for (const v of ['abc', '', '1.2.3']) expect(r05.validate(S(v), 'Real'), v).toBe(false);
    expect(r05.validate(S('True'), 'Boolean')).toBe(true);
    expect(r05.validate(S('true'), 'Boolean')).toBe(false);
    expect(r05.validate(S('application/pdf'), 'MIMEType')).toBe(true);
    expect(r05.validate(S('pdf'), 'MIMEType')).toBe(false);
    expect(r05.validate(S('a\nb'), 'Text')).toBe(true);           // (?s)
    expect(r05.validate(A('Bag', S('x')), 'Text')).toBe(false);    // simple only
  });

  it('checks GPSCoordinate by era', () => {
    expect(r04.validate(S('52,31.47N'), 'GPSCoordinate')).toBe(true);
    expect(r04.validate(S('152,31.4789N'), 'GPSCoordinate')).toBe(false);
    expect(r05.validate(S('152,31.4789N'), 'GPSCoordinate')).toBe(true);
  });

  it('checks dates, URIs, URLs and XPath', () => {
    expect(r05.validate(S('2024-06-03'), 'Date')).toBe(true);
    expect(r05.validate(S('soon'), 'Date')).toBe(false);
    expect(r05.validate({ kind: 'simple', value: 'x', uri: true }, 'URI')).toBe(true);
    expect(r05.validate(S('not a url'), 'URL')).toBe(true);
    expect(r05.validate(S('//['), 'XPath')).toBe(true);            // divergence: simple only
    expect(r05.validate(A('Seq'), 'URI')).toBe(false);
  });

  it('checks array forms and item types', () => {
    expect(r05.validate(A('Seq', S('a'), S('b')), 'Seq ProperName')).toBe(true);
    expect(r05.validate(A('Bag', S('a')), 'Seq ProperName')).toBe(false);
    expect(r05.validate(A('Alt', S('a')), 'Seq Text')).toBe(false);
    expect(r05.validate(A('Bag', S('1'), S('x')), 'Bag Integer')).toBe(false);
    expect(r05.validate(A('Bag', S('a')), 'bag')).toBe(true);      // bare array = of Text
    expect(r05.validate(A('Seq', A('Bag', S('1'))), 'Seq Bag Integer')).toBe(true);
  });

  it('checks Lang Alt: some item with a language, or empty', () => {
    expect(r05.validate(A('Alt', [S('T'), 'x-default']), 'Lang Alt')).toBe(true);
    expect(r05.validate(A('Alt'), 'Lang Alt')).toBe(true);
    expect(r05.validate(A('Alt', S('T')), 'Lang Alt')).toBe(false);
    expect(r05.validate(S('T'), 'Lang Alt')).toBe(false);
    expect(r05.validate(A('Seq', [S('T'), 'en']), 'Lang Alt')).toBe(false);
  });

  it('checks structs: declared fields, in the type namespace, each valid', () => {
    expect(r05.validate(St(DIM, { w: S('10'), h: S('2.5'), unit: S('mm') }), 'Dimensions')).toBe(true);
    expect(r05.validate(St(DIM, { w: S('wide') }), 'Dimensions')).toBe(false);
    expect(r05.validate(St(DIM, { depth: S('1') }), 'Dimensions')).toBe(false);
    expect(r05.validate(St('http://other/', { w: S('1') }), 'Dimensions')).toBe(false);
    expect(r05.validate(S('10x2'), 'Dimensions')).toBe(false);
  });

  it('treats any as always valid and an unknown type as invalid', () => {
    expect(r05.validate(A('Bag'), 'any')).toBe(true);
    expect(r05.validate(S('x'), 'Nonsense')).toBe(false);
  });

  it('extends with a schema\'s own value types, without touching the base', () => {
    const T = 'http://www.aiim.org/pdfa/ns/type#';
    const F = 'http://www.aiim.org/pdfa/ns/field#';
    const vt = (type: string, ns?: string, fields: [string, string][] = []): RdfValue => St(T, {
      type: S(type),
      ...(ns !== undefined ? { namespaceURI: S(ns) } : {}),
      ...(fields.length ? { field: A('Seq', ...fields.map(([n, t]) => St(F, { name: S(n), valueType: S(t) }))) } : {}),
    });
    const ext = r05.extend(A('Seq', vt('Point', 'http://acme/pt#', [['x', 'Integer'], ['y', 'Integer']]), vt('Code')));
    const PT = 'http://acme/pt#';
    expect(ext.validate(St(PT, { x: S('1'), y: S('2') }), 'Point')).toBe(true);
    expect(ext.validate(St(PT, { x: S('a') }), 'Point')).toBe(false);
    expect(ext.validate(S('anything'), 'Code')).toBe(true);        // no fields: Text
    expect(r05.isKnownType('Point')).toBe(false);
    expect(r05.extend(A('Seq', vt('NoNs', undefined, [['a', 'Text']]))).isKnownType('NoNs')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/xmptypes.test.ts`
Expected: FAIL — cannot resolve `../src/xmptypes.js`.

- [ ] **Step 3: Implement `src/xmptypes.ts`**

```ts
import type { RdfValue } from './xmprdf.js';
import {
  STRUCT_TYPES_2004, STRUCT_TYPES_2005, SIMPLE_PATTERNS_2004, SIMPLE_PATTERNS_2005,
} from './xmpschemadata.js';
import { simplifyValueType, type XmpEra } from './xmpschemas.js';

/** XMP value-type validation (`o6uu.10`): veraPDF's `ValidatorsContainer` with
 *  closed-choice checking OFF, which is how its validator runs. A pure leaf over
 *  the `xmprdf.ts` model and the generated tables; it never throws.
 *
 *  veraPDF's `isSimple` is `kind === 'simple'` (a URI included, qualifiers
 *  ignored); a struct's children are its `fields`. */

const PDFA_TYPE = 'http://www.aiim.org/pdfa/ns/type#';
const PDFA_FIELD = 'http://www.aiim.org/pdfa/ns/field#';
const ARRAYS = [['bag', 'Bag'], ['seq', 'Seq'], ['alt', 'Alt']] as const;

type Validator =
  | { kind: 'pattern'; re: RegExp }
  | { kind: 'date' } | { kind: 'langalt' } | { kind: 'simple' }
  | { kind: 'struct'; ns: string; fields: ReadonlyMap<string, string> };

/** A Java regex as a whole-value JavaScript one: `matches()` is anchored, and
 *  a leading `(?s)` is the `s` flag. */
function compile(src: string): RegExp {
  const dotAll = src.startsWith('(?s)');
  return new RegExp(`^(?:${dotAll ? src.slice(4) : src})$`, dotAll ? 's' : '');
}

const TEXT: Validator = { kind: 'pattern', re: compile('(?s)(^.*$)') };

function eraValidators(era: XmpEra): Map<string, Validator> {
  const out = new Map<string, Validator>([
    ['date', { kind: 'date' }], ['lang alt', { kind: 'langalt' }],
    ['uri', { kind: 'simple' }], ['url', { kind: 'simple' }], ['xpath', { kind: 'simple' }],
  ]);
  for (const [name, src] of Object.entries(era === '2004' ? SIMPLE_PATTERNS_2004 : SIMPLE_PATTERNS_2005))
    out.set(name, { kind: 'pattern', re: compile(src) });
  for (const [name, t] of Object.entries(era === '2004' ? STRUCT_TYPES_2004 : STRUCT_TYPES_2005))
    out.set(name, { kind: 'struct', ns: t.ns, fields: new Map(Object.entries(t.fields)) });
  return out;
}

const simpleText = (v: RdfValue | undefined): string | undefined => (v?.kind === 'simple' ? v.value : undefined);
const field = (v: RdfValue, ns: string, name: string): RdfValue | undefined =>
  v.kind === 'struct' ? v.fields.find((f) => f.ns === ns && f.name === name)?.value : undefined;

export class XmpTypeRegistry {
  private static readonly cache = new Map<XmpEra, XmpTypeRegistry>();
  private constructor(private readonly validators: ReadonlyMap<string, Validator>) {}

  /** The container a registered schema starts from in `era`. */
  static forEra(era: XmpEra): XmpTypeRegistry {
    let r = XmpTypeRegistry.cache.get(era);
    if (r === undefined) { r = new XmpTypeRegistry(eraValidators(era)); XmpTypeRegistry.cache.set(era, r); }
    return r;
  }

  /** A COPY extended by a schema's `pdfaSchema:valueType` array
   *  (`ValidatorsContainerCreator.registerTypeNode`): a type with fields and a
   *  namespace is a struct type, one with no fields is Text. */
  extend(valueTypes: RdfValue | undefined): XmpTypeRegistry {
    const out = new Map(this.validators);
    if (valueTypes?.kind === 'array') {
      for (const { value: vt } of valueTypes.items) {
        const name = simpleText(field(vt, PDFA_TYPE, 'type'));
        if (name === undefined) continue;
        const ns = simpleText(field(vt, PDFA_TYPE, 'namespaceURI'));
        const fieldsNode = field(vt, PDFA_TYPE, 'field');
        const fields = new Map<string, string>();
        if (fieldsNode?.kind === 'array') {
          for (const { value: f } of fieldsNode.items) {
            const n = simpleText(field(f, PDFA_FIELD, 'name'));
            const t = simpleText(field(f, PDFA_FIELD, 'valueType'));
            if (n !== undefined && t !== undefined) fields.set(n, t);
          }
        }
        if (fields.size === 0) out.set(simplifyValueType(name), TEXT);
        else if (ns !== undefined) out.set(simplifyValueType(name), { kind: 'struct', ns, fields });
      }
    }
    return new XmpTypeRegistry(out);
  }

  /** Every simplified type name this registry validates. */
  knownTypes(): string[] { return [...this.validators.keys()]; }

  /** veraPDF's `isKnownType`: simplify, peel array prefixes, look up. */
  isKnownType(type: string): boolean {
    let t = simplifyValueType(type);
    for (let peeled = true; peeled;) {
      peeled = false;
      for (const [a] of ARRAYS) if (t.startsWith(`${a} `)) { t = t.slice(a.length + 1); peeled = true; break; }
    }
    return this.validators.has(t);
  }

  /** veraPDF's `ValidatorsContainer.validate`. */
  validate(value: RdfValue, typeName: string): boolean {
    const type = simplifyValueType(typeName);
    if (type === 'any') return true;
    for (const [a, form] of ARRAYS) {
      if (type.startsWith(`${a} `)) {
        if (value.kind !== 'array' || value.form !== form) return false;
        const item = type.slice(a.length + 1);
        return value.items.every((i) => this.validate(i.value, item));
      }
    }
    const v = this.validators.get(type);
    return v !== undefined && this.check(value, v);
  }

  private check(value: RdfValue, v: Validator): boolean {
    switch (v.kind) {
      case 'pattern': return value.kind === 'simple' && v.re.test(value.value);
      case 'date': return value.kind === 'simple' && isXmpDate(value.value);
      case 'simple': return value.kind === 'simple';
      case 'langalt':
        return value.kind === 'array' && value.form === 'Alt'
          && (value.items.length === 0 || value.items.some((i) => i.lang !== undefined));
      case 'struct':
        return value.kind === 'struct' && value.fields.every((f) =>
          f.ns === v.ns && v.fields.has(f.name) && this.validate(f.value, v.fields.get(f.name)!));
    }
  }
}

/** XMPCore's `ISO8601Converter.parse`, as a predicate. Its `gatherInt` CLAMPS a
 *  number to its range rather than refusing it, so only the SHAPE can fail —
 *  `2024-13-40` is a valid date there, and so is the empty string. */
export function isXmpDate(s: string): boolean {
  if (s.length === 0) return true;
  let pos = 0;
  const has = () => pos < s.length;
  const ch = () => (pos < s.length ? s[pos] : '');
  const digits = (): boolean => { const start = pos; while (ch() >= '0' && ch() <= '9') pos++; return pos > start; };
  const isTz = (c: string) => c === 'Z' || c === '+' || c === '-';
  if (s[0] === '-') pos++;
  if (!digits()) return false;                                      // year
  if (has() && ch() !== '-') return false;
  if (!has()) return true;
  pos++;
  if (!digits()) return false;                                      // month
  if (has() && ch() !== '-') return false;
  if (!has()) return true;
  pos++;
  if (!digits()) return false;                                      // day
  if (has() && ch() !== 'T') return false;
  if (!has()) return true;
  pos++;
  if (!digits()) return false;                                      // hour
  if (!has()) return true;
  if (ch() === ':') {
    pos++;
    if (!digits()) return false;                                    // minute
    if (has() && ch() !== ':' && !isTz(ch())) return false;
  }
  if (!has()) return true;
  if (ch() === ':') {
    pos++;
    if (!digits()) return false;                                    // seconds
    if (has() && ch() !== '.' && !isTz(ch())) return false;
    if (ch() === '.') {
      pos++;
      if (!digits()) return false;                                  // fraction
      if (has() && !isTz(ch())) return false;
    }
  } else if (!isTz(ch())) return false;
  if (!has()) return true;
  if (ch() === 'Z') pos++;
  else {
    pos++;                                                          // + or -
    if (!digits()) return false;                                    // tz hour
    if (has()) {
      if (ch() !== ':') return false;
      pos++;
      if (!digits()) return false;                                  // tz minute
    }
  }
  return !has();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/xmptypes.test.ts test/import-cycles.test.ts`
Expected: PASS. If a date case disagrees, re-read `verapdf/<commit>/more/ISO8601Converter.java` (fetched during design) rather than the test — the grammar is the anchor; a wrong EXPECTATION is a ledgered ruling.

- [ ] **Step 5: Commit**

```bash
git add src/xmptypes.ts test/xmptypes.test.ts
git commit -m "feat(o6uu.10): XMP value-type validator over the RDF model"
```

---

### Task 3: Resolution, the rule, and wiring

**Files:**
- Create: `src/pdfavaluetypes.ts`
- Modify: `src/pdfaext.ts` (export `clause`), `src/validatectx.ts` (`metadataStreams` moves here), `src/pdfavalidate.ts` (use it; add `xmpValueTypeRule`)
- Test: `test/pdfavaluetypes.test.ts`

**Interfaces:**
- Consumes: Task 2's `XmpTypeRegistry`; `pdfaext.ts`'s `PacketUnderTest`, `extensionContainer`, `childOf`, `textOf`, `PDFA_*_NS`, `PdfaPart`, `clause`.
- Produces:
  - `src/pdfavaluetypes.ts`: `interface SchemaDef { registry: XmpTypeRegistry; types: Map<string, string> }`; `extensionDefinitions(packet: RdfPacket, era: XmpEra, seed?: ReadonlyMap<string, SchemaDef>): Map<string, SchemaDef>`; `interface TypeMismatch { property: RdfProperty; type: string; registry: XmpTypeRegistry }`; `typeMismatches(packet: RdfPacket, part: PdfaPart, main?: RdfPacket): TypeMismatch[]`; `valueTypeIssues(packets: readonly PacketUnderTest[], part: PdfaPart): ValidationIssue[]`
  - `src/validatectx.ts`: `metadataStreams(ctx: Pick<Ctx, 'catalog' | 'R'>): [PdfRef, PdfStream][]`

- [ ] **Step 1: Write the failing test**

```ts
// test/pdfavaluetypes.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { valueTypeIssues, typeMismatches } from '../src/pdfavaluetypes.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:acme="http://acme.example/ns/1.0/"'
  + ' xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
  + ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"'
  + ' xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"';
const text = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string) => parseRdfPacket(enc(text(inner)));
const prop = (n: string, vt: string) => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaProperty:name>${n}</pdfaProperty:name><pdfaProperty:valueType>${vt}</pdfaProperty:valueType>`
  + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>';
const schema = (ns: string, props: string) => '<rdf:li rdf:parseType="Resource"><pdfaSchema:schema>S</pdfaSchema:schema>'
  + `<pdfaSchema:namespaceURI>${ns}</pdfaSchema:namespaceURI><pdfaSchema:prefix>p</pdfaSchema:prefix>`
  + `<pdfaSchema:property><rdf:Seq>${props}</rdf:Seq></pdfaSchema:property></rdf:li>`;
const ext = (schemas: string) => `<pdfaExtension:schemas><rdf:Bag>${schemas}</rdf:Bag></pdfaExtension:schemas>`;
const ACME = 'http://acme.example/ns/1.0/';
const DC = 'http://purl.org/dc/elements/1.1/';
const rules = (inner: string, part: 1 | 2 | 3 = 2) => valueTypeIssues([{ packet: pkt(inner), main: true }], part).map((i) => i.rule);

describe('XmpValueType', () => {
  it('reports a mistyped predefined property, citing each part\'s clause', () => {
    const inner = '<dc:rights>All rights</dc:rights>';                    // Lang Alt expected
    const i1 = valueTypeIssues([{ packet: pkt(inner), main: true }], 1);
    expect(i1).toMatchObject([{ rule: 'XmpValueType', severity: 'error', clause: 'ISO 19005-1 §6.7.9' }]);
    expect(i1[0].message).toContain('dc:rights');
    expect(i1[0].message).toContain('Lang Alt');
    expect(valueTypeIssues([{ packet: pkt(inner), main: true }], 3)[0].clause).toBe('ISO 19005-3 §6.6.2.3.1');
  });

  it('passes well-typed predefined properties', () => {
    expect(rules('<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">R</rdf:li></rdf:Alt></dc:rights>'
      + '<tiff:ImageWidth>640</tiff:ImageWidth><xmp:CreateDate>2024-06-03T12:00:00Z</xmp:CreateDate>')).toEqual([]);
  });

  it('does not report an undescribed property — o6uu.6 already does', () => {
    expect(rules('<acme:Batch><rdf:Bag><rdf:li>x</rdf:li></rdf:Bag></acme:Batch>')).toEqual([]);
  });

  it('uses a described type, which outranks the predefined one', () => {
    expect(rules(`<acme:Count>abc</acme:Count>${ext(schema(ACME, prop('Count', 'Integer')))}`)).toEqual(['XmpValueType']);
    expect(rules(`<acme:Count>12</acme:Count>${ext(schema(ACME, prop('Count', 'Integer')))}`)).toEqual([]);
    // dc:rights redefined as Text: plain text now validates.
    expect(rules(`<dc:rights>R</dc:rights>${ext(schema(DC, prop('rights', 'Text')))}`)).toEqual([]);
  });

  it('drops a registration with an unknown type and the first registration wins', () => {
    expect(rules(`<dc:rights>R</dc:rights>${ext(schema(DC, prop('rights', 'Nonsense')))}`)).toEqual(['XmpValueType']);
    expect(rules(`<acme:C>abc</acme:C>${ext(schema(ACME, prop('C', 'Integer') + prop('C', 'Text')))}`)).toEqual(['XmpValueType']);
  });

  it('lets an object packet use the catalog packet\'s types at parts 2-3 only', () => {
    const main = pkt(ext(schema(ACME, prop('Count', 'Integer'))));
    const obj = pkt('<acme:Count>abc</acme:Count>');
    expect(typeMismatches(obj, 2, main).map((m) => m.type)).toEqual(['Integer']);
    expect(typeMismatches(obj, 1, main)).toEqual([]);                    // part 1: undescribed, skipped
  });

  it('never resolves a type through Object.prototype', () => {
    expect(rules('<dc:constructor>x</dc:constructor><dc:__proto__>y</dc:__proto__>')).toEqual([]);
  });

  it('finds no type error in the vendored real-world packets', () => {
    for (const f of ['acrobat-tutorial-sample.xmp', 'calibre-identifiers.xmp']) {
      const packet = parseRdfPacket(readFileSync(`test/fixtures/xmp/${f}`));
      for (const part of [1, 2] as const)
        expect(valueTypeIssues([{ packet, main: true }], part), `${f} part ${part}`).toEqual([]);
    }
  });
});

describe('ValidatePdfA wiring', () => {
  const withXmp = (inner: string) => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc(text(inner)) }));
    return d;
  };
  const rulesAt = (d: Document, level: '1b' | '2b' | '4') => d.ValidatePdfA(level).Issues.map((i) => i.rule);

  it('reports at parts 1-3 and is silent at part 4', () => {
    const d = withXmp('<dc:rights>R</dc:rights>');
    expect(rulesAt(d, '2b')).toContain('XmpValueType');
    expect(rulesAt(d, '1b')).toContain('XmpValueType');
    expect(rulesAt(d, '4')).not.toContain('XmpValueType');
  });

  it('checks an object-level metadata stream', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.Pages[0].Dict.set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc(text('<dc:rights>R</dc:rights>')) }));
    expect(d.ValidatePdfA('2b').Issues.find((i) => i.rule === 'XmpValueType')?.object).toBeDefined();
  });

  it('skips a packet that will not parse', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc('<x:xmpmeta') }));
    expect(() => d.ValidatePdfA('2b')).not.toThrow();
    expect(rulesAt(d, '2b')).not.toContain('XmpValueType');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavaluetypes.test.ts`
Expected: FAIL — cannot resolve `../src/pdfavaluetypes.js`.

- [ ] **Step 3: Export `clause` from `src/pdfaext.ts`**

Change `const clause = (part: PdfaPart, …` to `export const clause = (part: PdfaPart, …`.

- [ ] **Step 4: Move `metadataStreams` to `src/validatectx.ts`**

Cut the `metadataStreams` function (and its doc comment, if any) from `src/pdfavalidate.ts` and add to `src/validatectx.ts`, changing its signature to `export function metadataStreams(ctx: Pick<Ctx, 'catalog' | 'R'>): [PdfRef, PdfStream][]` (body unchanged; add `PdfStream` to the `./types.js` import there). In `src/pdfavalidate.ts` add `metadataStreams` to the `./validatectx.js` import. Doc comment:

```ts
/** Every stream a dictionary REACHABLE from the catalog names by `/Metadata`
 *  — never the object map, which still holds packets a write superseded
 *  (`o6uu.6`'s final review). Shared by the PDF/A rules and the converter. */
```

- [ ] **Step 5: Implement `src/pdfavaluetypes.ts`**

```ts
import type { RdfPacket, RdfProperty, RdfValue } from './xmprdf.js';
import type { ValidationIssue } from './validation.js';
import { PROPERTY_TYPES_2004, PROPERTY_TYPES_2005 } from './xmpschemadata.js';
import { eraOf, simplifyValueType, type XmpEra } from './xmpschemas.js';
import { XmpTypeRegistry } from './xmptypes.js';
import {
  PDFA_EXTENSION_NS, PDFA_SCHEMA_NS, PDFA_PROPERTY_NS, extensionContainer, childOf, textOf, clause,
  type PacketUnderTest, type PdfaPart,
} from './pdfaext.js';

/** Every XMP property's VALUE matches its type (ISO 19005-1 6.7.9 test 3,
 *  -2/-3 6.6.2.3.1 test 2; `o6uu.10`) — veraPDF's `isValueTypeCorrect`.
 *  Pure over `RdfPacket`.
 *
 *  A property's type is the first found in: this packet's extension schemas;
 *  at parts 2–3 the catalog packet's; the era's predefined set
 *  (`AXLXMPProperty.getSchemasDefinition`). An extension schema therefore
 *  outranks a predefined type. A property with NO type is not reported here —
 *  `o6uu.6`'s rule already names it (a stated divergence: veraPDF's
 *  `null == true` reports it twice). */

export interface SchemaDef { registry: XmpTypeRegistry; types: Map<string, string> }

const itemsOf = (v: RdfValue | undefined): RdfValue[] => (v?.kind === 'array' ? v.items.map((i) => i.value) : []);
const isArray = (p: RdfProperty | undefined) => p?.value.kind === 'array';

/** veraPDF's `createExtendedSchemasDefinition`: namespace → its registry and
 *  property types. Each schema starts from `seed`'s registry for its namespace
 *  (the catalog packet's, for an object packet at parts 2–3) or a fresh era
 *  one, extended by its own `valueType`s. A registration naming an unknown
 *  type is dropped and the first per name wins; a later schema for a
 *  namespace REPLACES an earlier one. */
export function extensionDefinitions(packet: RdfPacket, era: XmpEra, seed?: ReadonlyMap<string, SchemaDef>): Map<string, SchemaDef> {
  const out = new Map<string, SchemaDef>();
  const c = extensionContainer(packet);
  if (c === undefined || c.value.kind !== 'array') return out;
  for (const schema of itemsOf(c.value)) {
    const ns = textOf(childOf(schema, PDFA_SCHEMA_NS, 'namespaceURI'));
    const props = childOf(schema, PDFA_SCHEMA_NS, 'property');
    if (ns === undefined || !isArray(props)) continue;
    const vts = childOf(schema, PDFA_SCHEMA_NS, 'valueType');
    const registry = (seed?.get(ns)?.registry ?? XmpTypeRegistry.forEra(era)).extend(isArray(vts) ? vts!.value : undefined);
    const types = new Map<string, string>();
    for (const p of itemsOf(props!.value)) {
      const n = textOf(childOf(p, PDFA_PROPERTY_NS, 'name'));
      const vt = textOf(childOf(p, PDFA_PROPERTY_NS, 'valueType'));
      if (n !== undefined && vt !== undefined && registry.isKnownType(vt) && !types.has(n)) types.set(n, vt);
    }
    out.set(ns, { registry, types });
  }
  return out;
}

const PREDEFINED = { '2004': PROPERTY_TYPES_2004, '2005': PROPERTY_TYPES_2005 } as const;

/** The predefined type, probed with `hasOwn`: names come from the document,
 *  and `constructor` must not find `Object.prototype`'s. */
function predefinedType(era: XmpEra, ns: string, name: string): string | undefined {
  const table = PREDEFINED[era];
  if (!Object.hasOwn(table, ns)) return undefined;
  return Object.hasOwn(table[ns], name) ? table[ns][name] : undefined;
}

export interface TypeMismatch { property: RdfProperty; type: string; registry: XmpTypeRegistry }

/** Top-level properties whose value does not match their resolved type. */
export function typeMismatches(packet: RdfPacket, part: PdfaPart, main?: RdfPacket): TypeMismatch[] {
  const era = eraOf(part);
  const mainDefs = part === 1 || main === undefined ? undefined : extensionDefinitions(main, era);
  const own = extensionDefinitions(packet, era, mainDefs);
  const out: TypeMismatch[] = [];
  for (const property of packet.properties) {
    if (property.ns === PDFA_EXTENSION_NS && property.name === 'schemas') continue;
    let resolved: { type: string; registry: XmpTypeRegistry } | undefined;
    for (const defs of [own, mainDefs]) {
      const d = defs?.get(property.ns);
      const type = d?.types.get(property.name);
      if (d !== undefined && type !== undefined) { resolved = { type, registry: d.registry }; break; }
    }
    if (resolved === undefined) {
      const type = predefinedType(era, property.ns, property.name);
      if (type !== undefined) resolved = { type, registry: XmpTypeRegistry.forEra(era) };
    }
    if (resolved !== undefined && !resolved.registry.validate(property.value, resolved.type))
      out.push({ property, ...resolved });
  }
  return out;
}

/** A type as a reader writes it: `seq propername` → `Seq ProperName` is not
 *  recoverable from the simplified form, so the message keeps the table's. */
const shown = (type: string) => simplifyValueType(type).replace(/\b\w/g, (c) => c.toUpperCase());

/** Every `XmpValueType` issue for these packets at `part`. */
export function valueTypeIssues(packets: readonly PacketUnderTest[], part: PdfaPart): ValidationIssue[] {
  const main = packets.find((t) => t.main)?.packet;
  const out: ValidationIssue[] = [];
  for (const t of packets) {
    for (const m of typeMismatches(t.packet, part, t.main ? undefined : main)) {
      out.push({
        rule: 'XmpValueType', severity: 'error', clause: clause(part, '6.7.9', '6.6.2.3.1'),
        message: `XMP property ${t.packet.prefixes.get(m.property.ns) ?? m.property.ns}:${m.property.name} `
          + `does not match its type ${shown(m.type)}.`,
        ...(t.object !== undefined ? { object: t.object } : {}),
      });
    }
  }
  return out;
}
```

Note `shown('lang alt')` is `Lang Alt`, which is what the first test asserts.

- [ ] **Step 6: Wire the rule in `src/pdfavalidate.ts`**

Extract the packet collection out of `extensionSchemaRule` into a memoized helper and add the new rule beside it:

```ts
/** Every reachable metadata packet that parses, the catalog's marked `main`. */
const metadataPackets = (ctx: Ctx): PacketUnderTest[] => memo(ctx, 'pdfa:metadataPackets', () => {
  const mainRef = ctx.catalog.get('Metadata');
  const packets: PacketUnderTest[] = [];
  for (const [ref, obj] of metadataStreams(ctx)) {
    const main = isRef(mainRef) && mainRef.num === ref.num;
    try {
      const packet = parseRdfPacket(inflateStream(obj), ctx.doc.loadLimits);
      packets.push(main ? { packet, main } : { packet, main, object: ref });
    } catch (e) {
      rethrowLimit(e);
    }
  }
  return packets;
});

const extensionSchemaRule: Rule = (ctx) =>
  (ctx.part === 4 ? [] : extensionSchemaIssues(metadataPackets(ctx), ctx.part));

/** Every XMP property's value matches its predefined or described type
 *  (ISO 19005-1 6.7.9-3, -2/-3 6.6.2.3.1-2; `o6uu.10`). Part 4 has no such
 *  rule. */
const xmpValueTypeRule: Rule = (ctx) =>
  (ctx.part === 4 ? [] : valueTypeIssues(metadataPackets(ctx), ctx.part));
```

Add `import { valueTypeIssues } from './pdfavaluetypes.js';`, and in the rule list change `extensionSchemaRule,` to `extensionSchemaRule, xmpValueTypeRule,`. (`memo` is already imported from `./validatectx.js`; confirm with `grep -n "memo" src/pdfavalidate.ts | head -2`.)

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run test/pdfavaluetypes.test.ts test/pdfaext.test.ts test/pdfa-extension-validate.test.ts test/pdfavalidate.test.ts test/pdfaconvert.test.ts test/import-cycles.test.ts`
Expected: PASS. If a vendored packet reports, the finding is real: read which property and type, decide whether our reading or the packet is wrong, and ledger a ruling before changing either.

- [ ] **Step 8: Commit**

```bash
git add src/pdfavaluetypes.ts src/pdfaext.ts src/validatectx.ts src/pdfavalidate.ts test/pdfavaluetypes.test.ts
git commit -m "feat(o6uu.10): ValidatePdfA checks XMP property value types"
```

---

### Task 4: `ConvertToPdfA` repairs shape mismatches

**Files:**
- Modify: `src/pdfavaluetypes.ts` (`repairShape`), `src/pdfaextfix.ts` (`repairXmpValueTypes`), `src/pdfaconvert.ts` (category + pass), `README.md`, `CHANGELOG.md`
- Test: `test/pdfavaluetypes-convert.test.ts`

**Interfaces:**
- Consumes: Task 3's `typeMismatches`, `TypeMismatch`; `validatectx.ts`'s `metadataStreams`.
- Produces: `repairShape(value: RdfValue, type: string, registry: XmpTypeRegistry): RdfValue | undefined`; `repairXmpValueTypes(doc: Document, part: PdfaPart): ConvertAction[]`; `ConvertCategory` gains `'xmpValueTypes'`.

- [ ] **Step 1: Write the failing test**

```ts
// test/pdfavaluetypes-convert.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS, parseRdfPacket } from '../src/xmprdf.js';
import { repairShape } from '../src/pdfavaluetypes.js';
import { XmpTypeRegistry } from '../src/xmptypes.js';
import { inflateStream } from '../src/flate.js';
import { isStream } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"';
const text = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const DC = 'http://purl.org/dc/elements/1.1/';
const stream = (inner: string) => {
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
  return { kind: 'stream' as const, dict, raw: enc(text(inner)) };
};
const withXmp = (inner: string) => {
  const d = Document.New();
  d.AddPage(PageFormat.A4);
  d.catalog().set('Metadata', d.allocObject(stream(inner)));
  return d;
};
const r = XmpTypeRegistry.forEra('2005');
const S = (value: string) => ({ kind: 'simple' as const, value });

describe('repairShape', () => {
  it('wraps a simple value as the Lang Alt x-default item', () => {
    expect(repairShape(S('R'), 'lang alt', r)).toEqual({ kind: 'array', form: 'Alt', items: [{ value: S('R'), lang: 'x-default' }] });
  });
  it('wraps a simple value as a one-item array of the expected form', () => {
    expect(repairShape(S('Ann'), 'bag propername', r)).toEqual({ kind: 'array', form: 'Bag', items: [{ value: S('Ann') }] });
  });
  it('swaps Bag and Seq, keeping item order', () => {
    const bag = { kind: 'array' as const, form: 'Bag' as const, items: [{ value: S('a') }, { value: S('b') }] };
    expect(repairShape(bag, 'seq propername', r)).toEqual({ ...bag, form: 'Seq' });
  });
  it('turns a one-item Seq into an Alt, but not a two-item one', () => {
    const one = { kind: 'array' as const, form: 'Seq' as const, items: [{ value: S('a') }] };
    expect(repairShape(one, 'alt text', r)).toEqual({ ...one, form: 'Alt' });
    expect(repairShape({ ...one, items: [...one.items, { value: S('b') }] }, 'alt text', r)).toBeUndefined();
  });
  it('declines what it cannot make valid', () => {
    expect(repairShape(S('abc'), 'integer', r)).toBeUndefined();
    expect(repairShape(S('abc'), 'seq integer', r)).toBeUndefined();   // the item itself fails
  });
});

describe('ConvertToPdfA xmpValueTypes pass', () => {
  it('repairs shapes, keeps the text, and passes the rule', () => {
    const d = withXmp('<dc:rights>All rights</dc:rights><dc:contributor><rdf:Seq><rdf:li>A</rdf:li></rdf:Seq></dc:contributor>');
    const report = d.ConvertToPdfA('2b');
    expect(report.applied.filter((a) => a.rule === 'XmpValueType')).toHaveLength(2);
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpValueType');
    expect(d.GetXmpValue(DC, 'rights')!.asText()).toBe('All rights');
    expect(d.GetXmpValue(DC, 'contributor')!.raw).toMatchObject({ kind: 'array', form: 'Bag' });
  });

  it('leaves an unrepairable value as written and reports it', () => {
    const d = withXmp('<tiff:ImageWidth>wide</tiff:ImageWidth>');
    const report = d.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).toContain('XmpValueType');
    expect(d.GetXmpValue('http://ns.adobe.com/tiff/1.0/', 'ImageWidth')!.asText()).toBe('wide');
  });

  it('repairs an object-level packet in its own stream', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.Pages[0].Dict.set('Metadata', d.allocObject(stream('<dc:rights>R</dc:rights>')));
    d.ConvertToPdfA('2b');
    const md = d.resolve(d.Pages[0].Dict.get('Metadata'));
    expect(isStream(md)).toBe(true);
    const packet = parseRdfPacket(inflateStream(md as never));
    expect(packet.properties.find((p) => p.name === 'rights')!.value).toMatchObject({ kind: 'array', form: 'Alt' });
  });

  it('is declined by preserve: [\'xmpValueTypes\']', () => {
    const d = withXmp('<dc:rights>R</dc:rights>');
    const report = d.ConvertToPdfA('2b', { preserve: ['xmpValueTypes'] });
    expect(report.unresolved.map((i) => i.rule)).toContain('XmpValueType');
    expect(d.GetXmpValue(DC, 'rights')!.raw).toEqual(S('R'));
  });

  it('does nothing to a packet that will not parse', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.Pages[0].Dict.set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc('<x:xmpmeta') }));
    expect(() => d.ConvertToPdfA('2b')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfavaluetypes-convert.test.ts`
Expected: FAIL — `repairShape` is not exported.

- [ ] **Step 3: `repairShape` in `src/pdfavaluetypes.ts`**

```ts
const FORMS = [['bag', 'Bag'], ['seq', 'Seq'], ['alt', 'Alt']] as const;

/** A lossless reshaping of `value` that satisfies `type`, or undefined. Tried
 *  in order and kept only if it VALIDATES: a simple value → the Lang Alt
 *  `x-default` item, or a one-item array of the expected form; Bag ↔ Seq,
 *  items in order; a one-item Bag/Seq → Alt. Nothing here invents or drops a
 *  value — anything else is the author's to fix. */
export function repairShape(value: RdfValue, type: string, registry: XmpTypeRegistry): RdfValue | undefined {
  const t = simplifyValueType(type);
  const candidates: RdfValue[] = [];
  if (t === 'lang alt' && value.kind === 'simple' && value.uri !== true)
    candidates.push({ kind: 'array', form: 'Alt', items: [{ value, lang: 'x-default' }] });
  for (const [a, form] of FORMS) {
    if (!t.startsWith(`${a} `)) continue;
    if (value.kind === 'simple') candidates.push({ kind: 'array', form, items: [{ value }] });
    else if (value.kind === 'array' && value.form !== form) {
      const swap = form !== 'Alt' ? value.form !== 'Alt' : value.items.length === 1;
      if (swap) candidates.push({ ...value, form });
    }
  }
  return candidates.find((c) => registry.validate(c, type));
}
```

- [ ] **Step 4: `repairXmpValueTypes` in `src/pdfaextfix.ts`**

Add imports: `import { name, isRef, type PdfDict, type PdfObject } from './types.js';` (merge with the existing `./types.js` import), `import { metadataStreams } from './validatectx.js';`, `import { typeMismatches, repairShape } from './pdfavaluetypes.js';`. Then:

```ts
/** Repair the XMP value-type mismatches `repairShape` can (`o6uu.10`), in every
 *  reachable metadata packet — the catalog's through `installXmpText`, an
 *  object-level one written back into its own stream. A packet that will not
 *  parse is left alone. The catalog packet is read FIRST, since an object
 *  packet resolves types through it at parts 2–3. */
export function repairXmpValueTypes(doc: Document, part: PdfaPart): ConvertAction[] {
  const R = (o: PdfObject | undefined) => doc.resolve(o);
  const mainRef = doc.catalog().get('Metadata');
  const parsed: { ref: PdfRef; main: boolean; packet: RdfPacket }[] = [];
  for (const [ref, s] of metadataStreams({ catalog: doc.catalog(), R })) {
    try {
      parsed.push({ ref, main: isRef(mainRef) && mainRef.num === ref.num, packet: parseRdfPacket(inflateStream(s), doc.loadLimits) });
    } catch (e) {
      rethrowLimit(e);
    }
  }
  const main = parsed.find((p) => p.main)?.packet;
  const actions: ConvertAction[] = [];
  for (const p of parsed) {
    let changed = false;
    for (const m of typeMismatches(p.packet, part, p.main ? undefined : main)) {
      const fixed = repairShape(m.property.value, m.type, m.registry);
      if (fixed === undefined) continue;
      m.property.value = fixed;
      changed = true;
      actions.push({ rule: 'XmpValueType', action: `Rewrote ${p.packet.prefixes.get(m.property.ns) ?? m.property.ns}:${m.property.name} as ${m.type}.` });
    }
    if (!changed) continue;
    const textOut = writeXmpPacket(p.packet);
    if (p.main) doc.installXmpText(textOut);
    else {
      const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
      doc.replaceObject(p.ref.num, { kind: 'stream', dict, raw: new TextEncoder().encode(textOut) });
    }
  }
  return actions;
}
```

(`PdfRef` joins the `./types.js` import as a type.) Note the catalog packet's mismatches are computed on the packet as parsed, BEFORE it is rewritten — an object packet reads the catalog's extension schemas, which this pass never changes.

- [ ] **Step 5: The pass in `src/pdfaconvert.ts`**

Change the `ConvertCategory` union's last line to `| 'postScript' | 'info' | 'formActions' | 'deviceColor' | 'transparency' | 'extensionSchemas' | 'xmpValueTypes';`, import `repairXmpValueTypes` beside `describeCatalogXmp`, and add after `extensionSchemaPass`:

```ts
/** Repair XMP values whose SHAPE is wrong for their type (`o6uu.10`): plain
 *  text where a Lang Alt or an array is expected, a Bag where a Seq is. The
 *  commonest real-world defect is a plain `dc:title`, which veraPDF parses
 *  WITHOUT normalization and so rejects. A value that is wrong in content is
 *  left and reported. Runs after `extensionSchemaPass`, whose descriptions
 *  decide the types. */
const xmpValueTypesPass: Pass = (ctx) => {
  if (ctx.part === 4 || ctx.preserve.has('xmpValueTypes')) return [];
  return repairXmpValueTypes(ctx.doc, ctx.part);
};
```

In `PASSES`, change `identificationPass, extensionSchemaPass, versionPass,` to `identificationPass, extensionSchemaPass, xmpValueTypesPass, versionPass,`.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/pdfavaluetypes-convert.test.ts test/pdfavaluetypes.test.ts test/pdfaconvert.test.ts test/pdfaextfix.test.ts test/import-cycles.test.ts`
Expected: PASS. If `import-cycles` reports a new pair, `pdfaextfix.ts` → `pdfavaluetypes.ts` → `pdfaext.ts` must stay one-way; move nothing into `pdfaext.ts` that imports back.

- [ ] **Step 7: README and CHANGELOG**

In `README.md`'s **PDF/A validation** bullet, replace the sentence `The predefined tables are generated from veraPDF's; property VALUES are not type-checked yet.` with:

```markdown
The predefined tables are generated from veraPDF's. Property VALUES are type-checked too (`XmpValueType`): each top-level property must match its type — from the packet's own extension schemas, then (parts 2–3) the catalog packet's, then the predefined XMP 2004/2005 set — covering the simple types (Integer, Real, Boolean, MIMEType, Date, GPSCoordinate, …), Bag/Seq/Alt arrays of any type, Lang Alt, and the structured types (Dimensions, Thumbnail, ResourceEvent, …) as well as a schema's own `pdfaSchema:valueType`s. A property with no known type is reported once, as undescribed, not again here.
```

In the **PDF/A conversion** bullet, after `…; \`preserve: ['extensionSchemas']\` declines.`, insert:

```markdown
 It also repairs XMP values whose shape is wrong for their type — plain text where a Lang Alt or an array is expected (a plain `dc:title` or `dc:rights` becomes its `x-default` item), a Bag where a Seq is expected and vice versa, a one-item Bag or Seq where an Alt is expected — keeping every value; anything wrong in content is left as written and reported unresolved, and `preserve: ['xmpValueTypes']` declines.
```

In `CHANGELOG.md` under `### Added`, at the top:

```markdown
- **PDF/A checks every XMP property's value against its type.**
  `ValidatePdfA` reports `XmpValueType` at parts 1–3 when a property's value
  does not match its type (ISO 19005-1 6.7.9, -2/-3 6.6.2.3.1): the type comes
  from the packet's own extension schemas, then the catalog packet's, then the
  predefined XMP 2004/2005 set, so a schema can redefine a predefined property.
  It is veraPDF's `isValueTypeCorrect` ported over the pinned sources the
  generator already reads — simple types by veraPDF's own patterns, dates by
  XMPCore's parser, arrays, Lang Alt and the structured types, with
  closed-choice checking off as veraPDF's validator runs it. Two stated
  divergences: a property with no known type is reported once (as
  undescribed), not twice, and an XPath value is checked only for being
  simple. `ConvertToPdfA` repairs the shape mismatches it can without losing a
  value — the commonest being a plain `dc:title` or `dc:rights`, which veraPDF
  rejects because it does not normalize — under the new `'xmpValueTypes'`
  category (o6uu.10).
```

- [ ] **Step 8: Commit**

```bash
git add src/pdfavaluetypes.ts src/pdfaextfix.ts src/pdfaconvert.ts test/pdfavaluetypes-convert.test.ts README.md CHANGELOG.md
git commit -m "feat(o6uu.10): ConvertToPdfA repairs XMP value shapes"
```

---

### Task 5: Mutation pass, CLAUDE.md, verification, close

- [ ] **Step 1: Mutation pass**

For each row apply the mutation, confirm it APPLIED (`git diff --stat`), run `npx vitest run test/xmptypes.test.ts test/xmpschemadata.test.ts test/pdfavaluetypes.test.ts test/pdfavaluetypes-convert.test.ts`, record RED/GREEN, restore with `git checkout -- <file>`:

| # | File | Mutation |
|---|---|---|
| 1 | `src/xmptypes.ts` | `compile`: drop the `^(?:` … `)$` anchoring |
| 2 | `src/xmptypes.ts` | `compile`: ignore `(?s)` (no `s` flag, keep the prefix stripped) |
| 3 | `src/xmptypes.ts` | array check: accept any array form (`value.form !== form` → `false`) |
| 4 | `src/xmptypes.ts` | lang alt: drop the empty-Alt allowance |
| 5 | `src/xmptypes.ts` | lang alt: accept an Alt with no language |
| 6 | `src/xmptypes.ts` | struct: drop the `f.ns === v.ns` test |
| 7 | `src/xmptypes.ts` | `isXmpDate`: return `false` for the empty string |
| 8 | `src/xmptypes.ts` | `isXmpDate`: drop the extra-chars check (`return !has()` → `return true`) |
| 9 | `src/xmptypes.ts` | `extend`: register a fielded type even without a namespace |
| 10 | `src/pdfavaluetypes.ts` | resolution: consult predefined BEFORE the extension schemas |
| 11 | `src/pdfavaluetypes.ts` | `extensionDefinitions`: drop the `registry.isKnownType(vt)` filter |
| 12 | `src/pdfavaluetypes.ts` | `extensionDefinitions`: last registration wins (`!types.has(n) &&` removed) |
| 13 | `src/pdfavaluetypes.ts` | `typeMismatches`: use main defs at part 1 too |
| 14 | `src/pdfavaluetypes.ts` | `predefinedType`: `in` instead of `Object.hasOwn` |
| 15 | `src/pdfavaluetypes.ts` | `repairShape`: skip the final `registry.validate` (return first candidate) |
| 16 | `src/pdfavaluetypes.ts` | `repairShape`: allow a two-item Seq → Alt |
| 17 | `src/pdfaextfix.ts` | object packet: write back through `installXmpText` too |
| 18 | `src/pdfaconvert.ts` | pass ignores `preserve` |

A GREEN mutation is a coverage gap (add a case, rerun) or a provably redundant defence (record it in CLAUDE.md, keep the code).

- [ ] **Step 2: CLAUDE.md**

After the `**xmpschemas.ts**, **xmpschemadata.ts**, **pdfaext.ts**, **pdfaextfix.ts**` entry, add:

```markdown
- **xmptypes.ts**, **pdfavaluetypes.ts** — XMP property VALUE types for PDF/A
  (ISO 19005-1 6.7.9-3, -2/-3 6.6.2.3.1-2; `o6uu.10`), veraPDF's
  `isValueTypeCorrect`. `xmptypes.ts` is `ValidatorsContainer` ported over the
  `xmprdf.ts` model (`XmpTypeRegistry`, `isXmpDate`), a pure leaf over the
  generated tables; `pdfavaluetypes.ts` resolves each top-level property's type
  and reports `XmpValueType`, and holds `repairShape` for the converter.
  **Invariant, and it is what made the port small:** closed-choice checking is
  OFF. `GFPDMetadata` builds its packages through the constructors passing
  `isClosedChoiceCheck = false` (the flag exists for the metadata fixer), so a
  restricted field registers its OPEN type and the predefined side is one
  `(namespace, name) → type` table. `gen:xmpschemas` replays veraPDF's
  registration sequence to produce it — unknown-type registrations dropped,
  first wins — and FAILS if a name `o6uu.6`'s tables list is one the replay
  drops, so the two tables cannot drift.
  **Invariant:** resolution is `AXLXMPProperty.getSchemasDefinition`'s order —
  this packet's extension schemas, then at parts 2–3 the catalog packet's, then
  the predefined set — so an extension schema OUTRANKS a predefined type. Each
  schema's registry starts from the catalog's registry for its namespace (an
  object packet at parts 2–3) or a fresh era one, extended by its own
  `valueType`s only.
  **Invariant:** veraPDF parses WITHOUT normalization (`VeraPDFMeta.parse`
  sets `setOmitNormalization(true)`), so a plain-text `dc:title` FAILS — it is
  not silently wrapped into a Lang Alt. A Lang Alt is an Alt with some item
  carrying `xml:lang` (`detectAltText`, run by `ParseRDF` regardless) or an
  empty Alt.
  **Invariant:** Date is XMPCore's `ISO8601Converter.parse` transcribed, never
  `pdfdate.ts`'s grammar — two answers to "is this a date" is how we and
  veraPDF would disagree. Its `gatherInt` CLAMPS, so only the shape fails:
  `2024-13-40` is a valid date, and so is the empty string.
  **Invariant:** a property name is probed with `Object.hasOwn` — it comes
  from the document, and `constructor` must not find `Object.prototype`'s.
  **Note, three stated divergences:** a property with no type is reported
  ONCE, by `o6uu.6`'s rule (veraPDF's `null == true` reports it again as type
  null); XPath accepts any simple value (no XPath compiler, and no predefined
  property uses it); URI and URL accept any simple value, which is veraPDF's
  own current behaviour rather than ours.
  **Invariant (`pdfaextfix.ts`):** the converter repairs SHAPE only — simple →
  Lang Alt `x-default` item or one-item array, Bag ↔ Seq, one-item Bag/Seq →
  Alt — and keeps a repair only if it then VALIDATES; anything wrong in
  content is left as written. It writes an object-level packet back into its
  own stream, never through `installXmpText`, which would repoint the CATALOG.
  **Note on the anchor:** a transcription with no runnable oracle — `72nc.1`'s
  ceiling. The vendored Acrobat and calibre packets produce no type error,
  which is evidence against packets we did not write, not conformance.
```

Append a `**Note, measured:**` line with Step 1's result. Run the module-doc sweep (expect empty):

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 3: Full verification**

Run: `npm run typecheck` — expected exit 0.
Run: `npm test` — expected all files pass.

- [ ] **Step 4: Commit, close, push**

```bash
git add CLAUDE.md test/
git commit -m "docs(o6uu.10): record XMP value-type invariants"
bd close aspose-pdf-foss-for-ts-o6uu.10
git pull --rebase --autostash
git push
git status
```
Expected: "up to date with origin".
