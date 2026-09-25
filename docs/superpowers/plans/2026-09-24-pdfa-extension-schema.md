# PDF/A XMP Extension-Schema Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ValidatePdfA` (parts 1–3) reports XMP properties that are neither predefined nor described in `pdfaExtension:schemas`, and malformed descriptions; `ConvertToPdfA` and `ConvertToPdfUa` write the descriptions they can state truthfully.

**Architecture:** A generator extracts veraPDF's predefined-property and value-type tables into a committed data module (`xmpschemadata.ts`), wrapped by a leaf (`xmpschemas.ts`). `pdfaext.ts` is pure over `RdfPacket` and produces the issues; `pdfavalidate.ts` feeds it every metadata stream. `pdfaextfix.ts` adds missing descriptions to a parsed packet, and both converters call it.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, Node `https` for the generator only.

**Spec:** `docs/superpowers/specs/2026-09-24-pdfa-extension-schema-design.md`

## Global Constraints

- No runtime dependencies. The generator uses `node:https`/`node:fs` and is NOT run by `npm test`.
- No veraPDF code is vendored — only facts (namespace URIs, property names, type names) land in `src/xmpschemadata.ts`.
- Pinned anchors: `veraPDF-library` at `60f8f1dc236adb536c3a935488cd6a56a650c941`; profiles at `veraPDF-validation-profiles` `174a2db133327e6d3f3a73e0cc50bd7155fcfee7`.
- Parts 1–3 only; part 4 is silent.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- Every name exported from `index.ts` needs a README API Reference row (`test/readme-api.test.ts`) — this plan exports nothing new, but `ConvertCategory` gains a member.
- CHANGELOG entries under `## [Unreleased]`, in the commit with the change, citing `(o6uu.6)`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before closing: `npm run typecheck` and `npm test` green.

## Review Focus

1. A real third-party packet: `test/fixtures/xmp/acrobat-tutorial-sample.xmp` (Acrobat Reader, not PDF/A) must flag EXACTLY `xmpMM:OriginalDocumentID` and `pdf:Trapped` — neither is in veraPDF's tables (checked against `XMPConstants.java` while planning). **This corrects the spec, which expected no issue.** Pinned in Task 2.
2. A document run through `ConvertToPdfA('2b')` then `ConvertToPdfUa()` must validate with no `XmpPropertyNotDescribed` — `pdfuaid` is not predefined. Pinned in Task 5.
3. An object-level metadata stream that will not parse must neither throw nor report from this rule. Pinned in Task 4.
4. A source packet binding the PDF/A extension namespaces to OTHER prefixes: the converter's rewrite must emit the required ones, which also repairs pre-existing descriptions. Pinned in Task 3.
5. An array, struct or URI in an unknown namespace must stay reported — never described as `Text`. Pinned in Task 3.

---

### Task 1: The generator, the data module and `xmpschemas.ts`

**Files:**
- Create: `scripts/gen-xmp-schemas.mjs`, `src/xmpschemadata.ts` (generated), `src/xmpschemas.ts`
- Modify: `package.json` (scripts), `.gitignore`
- Test: `test/xmpschemas.test.ts`

**Interfaces:**
- Produces (`src/xmpschemadata.ts`): `VERAPDF_COMMIT: string`, `PREDEFINED_2004`, `PREDEFINED_2005: Readonly<Record<string, readonly string[]>>`, `BASE_VALUE_TYPES`, `VALUE_TYPES_2004`, `VALUE_TYPES_2005: readonly string[]`.
- Produces (`src/xmpschemas.ts`): `type XmpEra = '2004' | '2005'`; `eraOf(part: 1 | 2 | 3): XmpEra`; `isPredefinedProperty(ns: string, name: string, era: XmpEra): boolean`; `simplifyValueType(type: string): string`; `valueTypesFor(era: XmpEra | undefined, local?: Iterable<string>): Set<string>`; `isKnownValueType(type: string, known: ReadonlySet<string>): boolean`.

- [ ] **Step 1: Add the generator**

Create `scripts/gen-xmp-schemas.mjs` with exactly this content (it was run against the pinned sources while planning and printed `2004: 172 properties / 11 namespaces; 2005: 277 / 14; types base 14, 2004 26, 2005 36`):

```js
// @ts-nocheck
// Generates src/xmpschemadata.ts from veraPDF-library's XMP tables (o6uu.6).
// Downloads the pinned Java sources into a gitignored verapdf/ dir (cached),
// extracts FACTS ONLY — the predefined (namespace, property) pairs per XMP era
// and the known value-type names — and emits the committed data module. No
// veraPDF code is copied. Run via: npm run gen:xmpschemas
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '60f8f1dc236adb536c3a935488cd6a56a650c941';
const BASE = `https://raw.githubusercontent.com/veraPDF/veraPDF-library/${COMMIT}`;
const TOOLS = 'core/src/main/java/org/verapdf/model/tools/xmp';
const FILES = {
  constants: `${TOOLS}/XMPConstants.java`,
  creator: `${TOOLS}/SchemasDefinitionCreator.java`,
  validators: `${TOOLS}/ValidatorsContainerCreator.java`,
  container: `${TOOLS}/ValidatorsContainer.java`,
  simple: `${TOOLS}/validators/SimpleTypeValidator.java`,
  xmpConst: 'xmp-core/src/main/java/org/verapdf/xmp/XMPConst.java',
};
const root = process.env.GEN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = process.env.GEN_RAW ?? join(root, 'verapdf', COMMIT);
const outFile = process.env.GEN_OUT ?? join(root, 'src/xmpschemadata.ts');
mkdirSync(rawDir, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u) => get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
      if (res.statusCode !== 200) { reject(new Error(`${u} -> ${res.statusCode}`)); return; }
      const out = createWriteStream(dest); res.pipe(out); out.on('finish', () => out.close(resolve));
    }).on('error', reject);
    go(url);
  });
}

const fail = (msg) => { throw new Error(`gen-xmp-schemas: ${msg}`); };

/** Java source with comments removed, string literals intact. */
function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1;
    } else if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; }
    else if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; }
    else out += src[i++];
  }
  return out;
}

/** Top-level comma-separated tokens of an initializer body, quotes respected. */
function tokens(body) {
  const out = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
      cur += body.slice(i, j + 1); i = j;
    } else if (c === ',') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

const literal = (tok) => {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(tok);
  if (!m) fail(`expected a string literal, got ${tok}`);
  return m[1];
};

/** The brace-balanced body of the method (or constructor) DECLARED as `name`
 *  — a parameter list followed by `{`, so a call site never matches. */
function methodBody(src, name) {
  const m = new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`).exec(src);
  if (!m) fail(`method ${name} not found`);
  let i = m.index + m[0].length - 1;
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  return fail(`unbalanced method ${name}`);
}

async function main() {
  const text = {};
  for (const [k, rel] of Object.entries(FILES)) {
    const dest = join(rawDir, basename(rel));
    if (!existsSync(dest)) await download(`${BASE}/${rel}`, dest);
    text[k] = stripComments(readFileSync(dest, 'utf8'));
  }

  // XMPConst: NS_* and TYPE_* namespace URIs.
  const nsUri = new Map();
  for (const m of text.xmpConst.matchAll(/String\s+((?:NS|TYPE)_\w+)\s*=\s*("(?:[^"\\]|\\.)*")/g)) nsUri.set(m[1], literal(m[2]));
  // XMPConstants: string constants (type names) and String[] tables.
  const strConst = new Map();
  for (const m of text.constants.matchAll(/static final String\s+(\w+)\s*=\s*("(?:[^"\\]|\\.)*")\s*;/g)) strConst.set(m[1], literal(m[2]));
  const arrays = new Map();
  for (const m of text.constants.matchAll(/static final String\[\]\s+(\w+)\s*=\s*\{([\s\S]*?)\};/g)) arrays.set(m[1], tokens(m[2]));
  const getters = new Map();
  for (const m of text.constants.matchAll(/String\[\]\s+(get\w+)\s*\(\s*\)\s*\{\s*return\s+Arrays\.copyOf\(\s*(\w+)\s*,/g)) getters.set(m[1], m[2]);

  const tableOf = (getter) => {
    const name = getters.get(getter) ?? fail(`getter ${getter} not found`);
    return arrays.get(name) ?? fail(`array ${name} not found`);
  };
  const nsOf = (tok) => {
    const m = /^XMPConst\.(\w+)$/.exec(tok) ?? fail(`expected XMPConst.NS_*, got ${tok}`);
    return nsUri.get(m[1]) ?? fail(`XMPConst.${m[1]} has no URI`);
  };

  /** (ns, name) pairs a creator method registers. */
  function propertiesOf(method) {
    const body = methodBody(text.creator, method);
    const out = [];
    const calls = /(registerStructureTypeForSchema|registerRestrictedSimpleFieldForSchema)\(\s*XMPConstants\.(get\w+)\(\)|registerSeqChoiceFieldForSchema\(\s*XMPConst\.(\w+)\s*,\s*("(?:[^"\\]|\\.)*")|String\[\]\s+\w+\s*=\s*XMPConstants\.(get\w+)\(\)/g;
    for (const m of body.matchAll(calls)) {
      if (m[1]) {
        const t = tableOf(m[2]);
        const stride = m[1] === 'registerStructureTypeForSchema' ? 2 : 3;
        const ns = nsOf(t[0]);
        for (let i = 1; i < t.length; i += stride) out.push([ns, literal(t[i])]);
      } else if (m[3]) out.push([nsUri.get(m[3]) ?? fail(`XMPConst.${m[3]}`), literal(m[4])]);
      else { const t = tableOf(m[5]); out.push([nsOf(t[0]), literal(t[1])]); }
    }
    if (out.length === 0) fail(`${method} registered nothing`);
    return out;
  }
  const basic = propertiesOf('createBasicSchemasDefinition');
  const era = (m) => {
    const map = new Map();
    for (const [ns, name] of [...basic, ...propertiesOf(m)]) {
      if (!map.has(ns)) map.set(ns, new Set());
      map.get(ns).add(name);
    }
    return map;
  };
  const p2004 = era('createPredefinedPDFA_1SchemasDefinition');
  const p2005 = era('createPredefinedPDFA_2_3SchemasDefinition');

  // Value types. The empty container is `new ValidatorsContainer()`, whose
  // constructor registers the BASE set; each era adds its structured types.
  if (!/EMPTY_VALIDATORS_CONTAINER\s*=\s*new ValidatorsContainer\(\)/.test(text.validators))
    fail('EMPTY_VALIDATORS_CONTAINER is no longer `new ValidatorsContainer()`');
  const typeName = (c) => strConst.get(c) ?? fail(`XMPConstants.${c} not found`);
  const ctor = methodBody(text.container, 'ValidatorsContainer');
  const base = new Set([...ctor.matchAll(/validators\.put\(\s*XMPConstants\.(\w+)/g)].map((m) => typeName(m[1])));
  for (const m of text.simple.matchAll(/\b[A-Z_]+\(\s*XMPConstants\.(\w+)\s*,\s*"/g)) base.add(typeName(m[1]));
  const registered = (method) => new Set([...methodBody(text.validators, method)
    .matchAll(/register\w*(?:Validator|ForContainer)\(\s*(?:\n\s*)?XMPConstants\.([A-Z_]+)\b/g)].map((m) => typeName(m[1])));
  const basicTypes = registered('createBasicValidatorsContainer');
  const t2004 = new Set([...base, ...basicTypes, ...registered('createValidatorsContainerPredefinedForPDFA_1')]);
  const t2005 = new Set([...base, ...basicTypes, ...registered('createValidatorsContainerPredefinedForPDFA_2_3')]);

  const sorted = (s) => [...s].sort();
  const table = (map) => `{\n${[...map.keys()].sort().map((ns) => `  ${JSON.stringify(ns)}: ${JSON.stringify(sorted(map.get(ns)))},`).join('\n')}\n}`;
  const count = (map) => [...map.values()].reduce((n, s) => n + s.size, 0);
  const out = `// Generated by scripts/gen-xmp-schemas.mjs — do not edit. Re-run
// \`npm run gen:xmpschemas\` only when VERAPDF_COMMIT moves.
//
// FACTS extracted from veraPDF-library at the commit below: the XMP properties
// PDF/A treats as predefined (XMP 2004 for ISO 19005-1, XMP 2005 for -2/-3),
// keyed by namespace URI, and the value-type names veraPDF knows. Sources:
// core/src/main/java/org/verapdf/model/tools/xmp/{XMPConstants,
// SchemasDefinitionCreator,ValidatorsContainer,ValidatorsContainerCreator}.java,
// validators/SimpleTypeValidator.java and xmp-core's XMPConst.java.

export const VERAPDF_COMMIT = '${COMMIT}';

/** Predefined properties for PDF/A-1 (XMP 2004): ${count(p2004)} across ${p2004.size} namespaces. */
export const PREDEFINED_2004: Readonly<Record<string, readonly string[]>> = ${table(p2004)};

/** Predefined properties for PDF/A-2 and -3 (XMP 2005): ${count(p2005)} across ${p2005.size} namespaces. */
export const PREDEFINED_2005: Readonly<Record<string, readonly string[]>> = ${table(p2005)};

/** Types \`new ValidatorsContainer()\` knows — what a schema that registers no
 *  definition can use. */
export const BASE_VALUE_TYPES: readonly string[] = ${JSON.stringify(sorted(base))};

/** Types a registered PDF/A-1 schema can use, before its own value types. */
export const VALUE_TYPES_2004: readonly string[] = ${JSON.stringify(sorted(t2004))};

/** Types a registered PDF/A-2/-3 schema can use, before its own value types. */
export const VALUE_TYPES_2005: readonly string[] = ${JSON.stringify(sorted(t2005))};
`;
  writeFileSync(outFile, out);
  console.log(`2004: ${count(p2004)} properties / ${p2004.size} namespaces; 2005: ${count(p2005)} / ${p2005.size}; `
    + `types base ${base.size}, 2004 ${t2004.size}, 2005 ${t2005.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

In `package.json` `scripts`, after `"gen:cidunicode"`, add:

```json
    "gen:xmpschemas": "node scripts/gen-xmp-schemas.mjs",
```

In `.gitignore`, append:

```
# veraPDF source downloads (regenerate src/xmpschemadata.ts via npm run gen:xmpschemas)
/verapdf/
```

- [ ] **Step 2: Generate the data module**

Run: `npm run gen:xmpschemas`
Expected: `2004: 172 properties / 11 namespaces; 2005: 277 / 14; types base 14, 2004 26, 2005 36`, and `src/xmpschemadata.ts` exists.

- [ ] **Step 3: Write the failing tests**

```ts
// test/xmpschemas.test.ts
import { describe, it, expect } from 'vitest';
import {
  VERAPDF_COMMIT, PREDEFINED_2004, PREDEFINED_2005, BASE_VALUE_TYPES, VALUE_TYPES_2004, VALUE_TYPES_2005,
} from '../src/xmpschemadata.js';
import { eraOf, isPredefinedProperty, simplifyValueType, valueTypesFor, isKnownValueType } from '../src/xmpschemas.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const DM = 'http://ns.adobe.com/xmp/1.0/DynamicMedia/';
const TPG = 'http://ns.adobe.com/xap/1.0/t/pg/';
const PDFAID = 'http://www.aiim.org/pdfa/ns/id/';
const PDFUAID = 'http://www.aiim.org/pdfua/ns/id/';
const count = (t: Readonly<Record<string, readonly string[]>>) => Object.values(t).reduce((n, a) => n + a.length, 0);

describe('generated tables', () => {
  it('are pinned to veraPDF-library 60f8f1dc and have the generated sizes', () => {
    // A truncated or re-pinned generation is a red build rather than a
    // silently smaller predefined set.
    expect(VERAPDF_COMMIT).toBe('60f8f1dc236adb536c3a935488cd6a56a650c941');
    expect([count(PREDEFINED_2004), Object.keys(PREDEFINED_2004).length]).toEqual([172, 11]);
    expect([count(PREDEFINED_2005), Object.keys(PREDEFINED_2005).length]).toEqual([277, 14]);
    expect([BASE_VALUE_TYPES.length, VALUE_TYPES_2004.length, VALUE_TYPES_2005.length]).toEqual([14, 26, 36]);
  });

  it('holds facts checked by hand against XMPConstants.java', () => {
    expect(isPredefinedProperty(DC, 'title', '2004')).toBe(true);
    expect(isPredefinedProperty(DC, 'title', '2005')).toBe(true);
    expect(isPredefinedProperty(DM, 'album', '2005')).toBe(true);
    expect(isPredefinedProperty(DM, 'album', '2004')).toBe(false);
    expect(isPredefinedProperty(TPG, 'Fonts', '2005')).toBe(true);
    expect(isPredefinedProperty(TPG, 'Fonts', '2004')).toBe(false);
    expect(isPredefinedProperty(PDFAID, 'corr', '2005')).toBe(true);
    expect(isPredefinedProperty(PDFAID, 'corr', '2004')).toBe(false);
    // Not predefined in EITHER era — the two properties the Acrobat fixture
    // carries, and pdfuaid, which is why a PDF/A + PDF/UA file needs a description.
    for (const era of ['2004', '2005'] as const) {
      expect(isPredefinedProperty(MM, 'OriginalDocumentID', era)).toBe(false);
      expect(isPredefinedProperty(PDF, 'Trapped', era)).toBe(false);
      expect(isPredefinedProperty(PDFUAID, 'part', era)).toBe(false);
    }
  });

  it('knows structured types per era and only simple ones in the base container', () => {
    expect(VALUE_TYPES_2004).toContain('resourceref');
    expect(VALUE_TYPES_2005).toContain('colorant');
    expect(VALUE_TYPES_2004).not.toContain('colorant');
    expect(BASE_VALUE_TYPES).toContain('lang alt');
    expect(BASE_VALUE_TYPES).not.toContain('resourceref');
    expect(BASE_VALUE_TYPES).not.toContain('gpscoordinate');
  });
});

describe('eraOf', () => {
  it('is XMP 2004 for part 1 and 2005 for parts 2 and 3', () => {
    expect([eraOf(1), eraOf(2), eraOf(3)]).toEqual(['2004', '2005', '2005']);
  });
});

describe('value-type names (veraPDF getSimplifiedType + isKnownType)', () => {
  it('lowercases, strips choice wording, and makes a bare array an array of Text', () => {
    expect(simplifyValueType('ProperName')).toBe('propername');
    expect(simplifyValueType('Closed Choice of Text')).toBe('text');
    expect(simplifyValueType('Open Choice')).toBe('text');
    expect(simplifyValueType('')).toBe('text');
    expect(simplifyValueType('Seq')).toBe('seq text');
    expect(simplifyValueType('Lang Alt')).toBe('lang alt');
  });

  it('peels array prefixes before looking the name up', () => {
    const known = valueTypesFor('2005');
    expect(isKnownValueType('Bag ProperName', known)).toBe(true);
    expect(isKnownValueType('Seq Seq Date', known)).toBe(true);
    expect(isKnownValueType('Lang Alt', known)).toBe(true);
    expect(isKnownValueType('Seq', known)).toBe(true);
    expect(isKnownValueType('Widget', known)).toBe(false);
  });

  it('adds a schema\'s own types, simplified, and gives an unregistered schema the base set only', () => {
    expect(isKnownValueType('Seq Point', valueTypesFor('2005', ['Point']))).toBe(true);
    expect(isKnownValueType('ResourceRef', valueTypesFor(undefined))).toBe(false);
    expect(isKnownValueType('Text', valueTypesFor(undefined))).toBe(true);
    expect(isKnownValueType('GPSCoordinate', valueTypesFor('2004'))).toBe(true);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/xmpschemas.test.ts`
Expected: FAIL — cannot resolve `../src/xmpschemas.js`.

- [ ] **Step 5: Implement the leaf**

```ts
// src/xmpschemas.ts
import {
  PREDEFINED_2004, PREDEFINED_2005, BASE_VALUE_TYPES, VALUE_TYPES_2004, VALUE_TYPES_2005,
} from './xmpschemadata.js';

/** The XMP properties and value types PDF/A treats as predefined (`o6uu.6`),
 *  over veraPDF's tables as `gen:xmpschemas` extracts them. A leaf.
 *
 *  Part 1 is XMP 2004 and parts 2–3 are XMP 2005; ISO 19005-4 has no such
 *  rule. The value-type rules are veraPDF's `getSimplifiedType` and
 *  `isKnownType` transcribed — note the three TIERS of known types: an
 *  unregistered schema (no `namespaceURI` or no `property` array) sees only
 *  `new ValidatorsContainer()`'s base set, a registered one sees its era's set
 *  plus the types its own `valueType` Seq declares. */

export type XmpEra = '2004' | '2005';

const index = (t: Readonly<Record<string, readonly string[]>>) =>
  new Map(Object.entries(t).map(([ns, names]) => [ns, new Set(names)] as const));
const PREDEFINED = { '2004': index(PREDEFINED_2004), '2005': index(PREDEFINED_2005) } as const;
const TYPES = { '2004': VALUE_TYPES_2004, '2005': VALUE_TYPES_2005 } as const;
const ARRAYS = ['bag', 'seq', 'alt'] as const;

export const eraOf = (part: 1 | 2 | 3): XmpEra => (part === 1 ? '2004' : '2005');

/** Is `(ns, name)` predefined for `era`? Keyed by PROPERTY, not namespace: a
 *  known namespace does not excuse an unknown property in it. */
export function isPredefinedProperty(ns: string, name: string, era: XmpEra): boolean {
  return PREDEFINED[era].get(ns)?.has(name) ?? false;
}

/** veraPDF's `getSimplifiedType`: lowercase, drop "open/closed choice of",
 *  treat a bare array name as an array of Text. */
export function simplifyValueType(type: string): string {
  let res = type.toLowerCase().replace(/(open |closed )?(choice |choice$)(of )?/g, '').trim();
  if (res === '') return 'text';
  if (res.endsWith('lang alt')) return res;
  for (const a of ARRAYS) if (res.endsWith(a)) { res += ' text'; break; }
  return res;
}

/** The type names a schema may use: `era` undefined is the base container. */
export function valueTypesFor(era: XmpEra | undefined, local: Iterable<string> = []): Set<string> {
  if (era === undefined) return new Set(BASE_VALUE_TYPES);
  const out = new Set(TYPES[era]);
  for (const t of local) out.add(simplifyValueType(t));
  return out;
}

/** veraPDF's `isKnownType`: simplify, then peel `bag `/`seq `/`alt ` prefixes. */
export function isKnownValueType(type: string, known: ReadonlySet<string>): boolean {
  let t = simplifyValueType(type);
  for (let peeled = true; peeled;) {
    peeled = false;
    for (const a of ARRAYS) if (t.startsWith(`${a} `)) { t = t.slice(a.length + 1); peeled = true; break; }
  }
  return known.has(t);
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/xmpschemas.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-xmp-schemas.mjs src/xmpschemadata.ts src/xmpschemas.ts test/xmpschemas.test.ts package.json .gitignore
git commit -m "feat(o6uu.6): generate veraPDF's predefined XMP tables"
```

---

### Task 2: `pdfaext.ts` — the rules, pure over `RdfPacket`

**Files:**
- Create: `src/pdfaext.ts`
- Test: `test/pdfaext.test.ts`

**Interfaces:**
- Consumes: Task 1's `eraOf`, `isPredefinedProperty`, `valueTypesFor`, `isKnownValueType`, `simplifyValueType`; `RdfPacket`, `RdfProperty`, `RdfValue` from `src/xmprdf.ts`; `ValidationIssue` from `src/validation.ts`; `PdfRef` from `src/types.ts`.
- Produces:
  - `PDFA_EXTENSION_NS`, `PDFA_SCHEMA_NS`, `PDFA_PROPERTY_NS`, `PDFA_TYPE_NS`, `PDFA_FIELD_NS: string`; `REQUIRED_PREFIX: ReadonlyMap<string, string>`
  - `type PdfaPart = 1 | 2 | 3`; `interface PacketUnderTest { packet: RdfPacket; main: boolean; object?: PdfRef }`
  - `childOf(v: RdfValue, ns: string, name: string): RdfProperty | undefined`; `textOf(p: RdfProperty | undefined): string | undefined`
  - `extensionContainer(packet: RdfPacket): RdfProperty | undefined`
  - `describedProperties(packet: RdfPacket): Map<string, Set<string>>`
  - `undescribedProperties(packet: RdfPacket, part: PdfaPart, main?: RdfPacket): RdfProperty[]`
  - `extensionSchemaIssues(packets: readonly PacketUnderTest[], part: PdfaPart): ValidationIssue[]`

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdfaext.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { extensionSchemaIssues, undescribedProperties } from '../src/pdfaext.js';
import type { PdfRef } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:acme="http://acme.example/ns/1.0/"'
  + ' xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/"'
  + ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"'
  + ' xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#" xmlns:pdfaType="http://www.aiim.org/pdfa/ns/type#"'
  + ' xmlns:pdfaField="http://www.aiim.org/pdfa/ns/field#"';
const text = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string) => parseRdfPacket(enc(text(inner)));
const prop = (name: string, vt = 'Text', cat = 'external') => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>${vt}</pdfaProperty:valueType>`
  + `<pdfaProperty:category>${cat}</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>`;
const schema = (props: string, extra = '', ns = 'http://acme.example/ns/1.0/') => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaSchema:schema>Acme</pdfaSchema:schema><pdfaSchema:namespaceURI>${ns}</pdfaSchema:namespaceURI>`
  + `<pdfaSchema:prefix>acme</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq>${props}</rdf:Seq></pdfaSchema:property>${extra}</rdf:li>`;
const container = (schemas: string, form = 'Bag') =>
  `<pdfaExtension:schemas><rdf:${form}>${schemas}</rdf:${form}></pdfaExtension:schemas>`;
const ACME = '<acme:Batch>B1</acme:Batch>';
const issues = (inner: string, part: 1 | 2 | 3 = 2) => extensionSchemaIssues([{ packet: pkt(inner), main: true }], part);
const rules = (inner: string, part: 1 | 2 | 3 = 2) => issues(inner, part).map((i) => i.rule);

describe('XmpPropertyNotDescribed', () => {
  it('reports an undescribed property at parts 1 and 2, with each part\'s clause', () => {
    expect(issues(ACME, 1)).toMatchObject([{ rule: 'XmpPropertyNotDescribed', severity: 'error', clause: 'ISO 19005-1 §6.7.9' }]);
    expect(issues(ACME, 2)).toMatchObject([{ rule: 'XmpPropertyNotDescribed', clause: 'ISO 19005-2 §6.6.2.3.1' }]);
    expect(issues(ACME, 3)[0].clause).toBe('ISO 19005-3 §6.6.2.3.1');
    expect(issues(ACME, 2)[0].message).toContain('acme:Batch');
  });

  it('accepts a described or predefined property', () => {
    expect(rules(ACME + container(schema(prop('Batch'))))).toEqual([]);
    expect(rules('<dc:format>application/pdf</dc:format>')).toEqual([]);
  });

  it('checks by property, not namespace: an unknown dc property is reported', () => {
    expect(rules('<dc:bogus>x</dc:bogus>')).toEqual(['XmpPropertyNotDescribed']);
  });

  it('uses XMP 2004 at part 1 and XMP 2005 at part 2', () => {
    expect(rules('<xmpDM:album>A</xmpDM:album>', 2)).toEqual([]);
    expect(rules('<xmpDM:album>A</xmpDM:album>', 1)).toEqual(['XmpPropertyNotDescribed']);
  });

  it('does not count a property description with no valueType', () => {
    const noType = '<rdf:li rdf:parseType="Resource"><pdfaProperty:name>Batch</pdfaProperty:name>'
      + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>';
    expect(rules(ACME + container(schema(noType)))).toContain('XmpPropertyNotDescribed');
  });

  it('lets the LAST schema entry for a namespace win, as veraPDF\'s map.put does', () => {
    expect(rules(ACME + container(schema(prop('Batch')) + schema(prop('Other'))))).toContain('XmpPropertyNotDescribed');
    expect(rules(ACME + container(schema(prop('Other')) + schema(prop('Batch'))))).toEqual([]);
  });
});

describe('main packet descriptions for object-level packets', () => {
  const ref: PdfRef = { kind: 'ref', num: 9, gen: 0 };
  const run = (part: 1 | 2) => extensionSchemaIssues([
    { packet: pkt(container(schema(prop('Batch')))), main: true },
    { packet: pkt(ACME), main: false, object: ref },
  ], part);

  it('count at parts 2 and 3', () => {
    expect(run(2)).toEqual([]);
  });

  it('do not count at part 1, and the issue names the object', () => {
    expect(run(1)).toMatchObject([{ rule: 'XmpPropertyNotDescribed', object: ref }]);
  });
});

describe('description structure', () => {
  it('requires the container to be a Bag', () => {
    expect(rules(ACME + container(schema(prop('Batch')), 'Seq'))).toEqual(['XmpExtensionContainer']);
  });

  it('requires the prefix pdfaExtension', () => {
    const src = text(ACME + container(schema(prop('Batch')))).replace(/pdfaExtension/g, 'ext');
    const out = extensionSchemaIssues([{ packet: parseRdfPacket(enc(src)), main: true }], 2);
    expect(out.map((i) => i.rule)).toEqual(['XmpExtensionContainer']);
  });

  it('reports a field outside the namespace\'s allowed set', () => {
    expect(rules(ACME + container(schema(prop('Batch'), '<pdfaSchema:bogus>1</pdfaSchema:bogus>'))))
      .toEqual(['XmpExtensionUndefinedField']);
    expect(rules(ACME + container(schema(prop('Batch'), '<acme:Other>1</acme:Other>'))))
      .toEqual(['XmpExtensionUndefinedField']);
  });

  it('requires schema, namespaceURI and prefix, each simple', () => {
    const noSchema = schema(prop('Batch')).replace('<pdfaSchema:schema>Acme</pdfaSchema:schema>', '');
    expect(rules(ACME + container(noSchema))).toEqual(['XmpExtensionField']);
    const structPrefix = schema(prop('Batch')).replace('<pdfaSchema:prefix>acme</pdfaSchema:prefix>',
      '<pdfaSchema:prefix rdf:parseType="Resource"><acme:a>1</acme:a></pdfaSchema:prefix>');
    expect(rules(ACME + container(structPrefix))).toEqual(['XmpExtensionField']);
  });

  it('requires property to be a Seq when present, and allows it absent', () => {
    const bag = schema(prop('Batch')).replace(/rdf:Seq/g, 'rdf:Bag');
    expect(rules(ACME + container(bag))).toEqual(['XmpExtensionField']);
    const none = schema('').replace(/<pdfaSchema:property>.*<\/pdfaSchema:property>/, '');
    expect(rules(container(none))).toEqual([]);
  });

  it('requires each property field and reports a bad category or value type', () => {
    expect(rules(ACME + container(schema(prop('Batch', 'Text', 'sometimes'))))).toEqual(['XmpExtensionValueType']);
    expect(rules(ACME + container(schema(prop('Batch', 'Widget'))))).toEqual(['XmpExtensionValueType']);
    const noDesc = prop('Batch').replace('<pdfaProperty:description>d</pdfaProperty:description>', '');
    expect(rules(ACME + container(schema(noDesc)))).toEqual(['XmpExtensionField']);
  });

  it('knows array, lang-alt and choice spellings, and a schema\'s own value types', () => {
    for (const vt of ['Bag ProperName', 'Lang Alt', 'Closed Choice of Text', 'Seq Date'])
      expect(rules(ACME + container(schema(prop('Batch', vt))))).toEqual([]);
    const widget = '<pdfaSchema:valueType><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pdfaType:type>Widget</pdfaType:type><pdfaType:namespaceURI>http://acme.example/w#</pdfaType:namespaceURI>'
      + '<pdfaType:prefix>w</pdfaType:prefix><pdfaType:description>d</pdfaType:description>'
      + '</rdf:li></rdf:Seq></pdfaSchema:valueType>';
    expect(rules(ACME + container(schema(prop('Batch', 'Widget'), widget)))).toEqual([]);
  });

  it('gives an unregistered schema only the base types for its value-type fields', () => {
    // No property array: veraPDF registers no definition for the namespace,
    // so its valueType entries are checked against `new ValidatorsContainer()`.
    const vtWithRef = '<pdfaSchema:valueType><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pdfaType:type>Thing</pdfaType:type><pdfaType:namespaceURI>http://acme.example/t#</pdfaType:namespaceURI>'
      + '<pdfaType:prefix>t</pdfaType:prefix><pdfaType:description>d</pdfaType:description>'
      + '<pdfaType:field><rdf:Seq><rdf:li rdf:parseType="Resource"><pdfaField:name>ref</pdfaField:name>'
      + '<pdfaField:valueType>ResourceRef</pdfaField:valueType><pdfaField:description>d</pdfaField:description>'
      + '</rdf:li></rdf:Seq></pdfaType:field></rdf:li></rdf:Seq></pdfaSchema:valueType>';
    const unregistered = schema('', vtWithRef).replace(/<pdfaSchema:property>.*?<\/pdfaSchema:property>/, '');
    expect(rules(container(unregistered))).toEqual(['XmpExtensionValueType']);
    expect(rules(ACME + container(schema(prop('Batch'), vtWithRef)))).toEqual([]);
  });
});

describe('real packets from other producers', () => {
  const load = (f: string) => parseRdfPacket(readFileSync(`test/fixtures/xmp/${f}`));
  const names = (f: string) => {
    const p = load(f);
    return undescribedProperties(p, 2).map((q) => `${p.prefixes.get(q.ns)}:${q.name}`).sort();
  };

  it('flags exactly the two Acrobat properties veraPDF\'s tables lack', () => {
    // Checked against XMPConstants.java at 60f8f1dc while planning: neither
    // name occurs anywhere in it. The spec expected no issue; it was wrong.
    expect(names('acrobat-tutorial-sample.xmp')).toEqual(['pdf:Trapped', 'xmpMM:OriginalDocumentID']);
  });

  it('flags calibre\'s pdfx and prism identifiers and nothing else', () => {
    expect(names('calibre-identifiers.xmp')).toEqual(['pdfx:doi', 'pdfx:isbn', 'prism:doi', 'prism:isbn']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfaext.test.ts`
Expected: FAIL — cannot resolve `../src/pdfaext.js`.

- [ ] **Step 3: Implement**

```ts
// src/pdfaext.ts
import type { PdfRef } from './types.js';
import type { ValidationIssue } from './validation.js';
import type { RdfPacket, RdfProperty, RdfValue } from './xmprdf.js';
import { eraOf, isPredefinedProperty, valueTypesFor, isKnownValueType } from './xmpschemas.js';

/** PDF/A's rule that every XMP property is predefined or described
 *  (ISO 19005-1 6.7.8–6.7.9, -2/-3 6.6.2.3), transcribed from veraPDF
 *  (`o6uu.6`). Pure over `RdfPacket`s — `pdfavalidate.ts` supplies them — so
 *  every rule is drivable from hand-built packets. Part 4 has no such rule and
 *  never reaches here.
 *
 *  Two readings are veraPDF's and look wrong: a later schema entry for a
 *  namespace REPLACES an earlier one (its registry is a map), and "shall be
 *  present" is enforced by the PREFIX test, since every shape test passes an
 *  absent field. */

export const PDFA_EXTENSION_NS = 'http://www.aiim.org/pdfa/ns/extension/';
export const PDFA_SCHEMA_NS = 'http://www.aiim.org/pdfa/ns/schema#';
export const PDFA_PROPERTY_NS = 'http://www.aiim.org/pdfa/ns/property#';
export const PDFA_TYPE_NS = 'http://www.aiim.org/pdfa/ns/type#';
export const PDFA_FIELD_NS = 'http://www.aiim.org/pdfa/ns/field#';

export const REQUIRED_PREFIX: ReadonlyMap<string, string> = new Map([
  [PDFA_EXTENSION_NS, 'pdfaExtension'], [PDFA_SCHEMA_NS, 'pdfaSchema'],
  [PDFA_PROPERTY_NS, 'pdfaProperty'], [PDFA_TYPE_NS, 'pdfaType'], [PDFA_FIELD_NS, 'pdfaField'],
]);

const ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [PDFA_SCHEMA_NS, new Set(['schema', 'namespaceURI', 'prefix', 'property', 'valueType'])],
  [PDFA_PROPERTY_NS, new Set(['name', 'valueType', 'category', 'description'])],
  [PDFA_TYPE_NS, new Set(['type', 'namespaceURI', 'prefix', 'description', 'field'])],
  [PDFA_FIELD_NS, new Set(['name', 'valueType', 'description'])],
]);

export type PdfaPart = 1 | 2 | 3;

/** One metadata stream's packet. `main` is the catalog's; `object` names an
 *  object-level stream so its issues can point at it. */
export interface PacketUnderTest { packet: RdfPacket; main: boolean; object?: PdfRef }

const fieldsOf = (v: RdfValue): RdfProperty[] => (v.kind === 'struct' ? v.fields : []);
export const childOf = (v: RdfValue, ns: string, name: string): RdfProperty | undefined =>
  fieldsOf(v).find((f) => f.ns === ns && f.name === name);
export const textOf = (p: RdfProperty | undefined): string | undefined =>
  (p?.value.kind === 'simple' ? p.value.value : undefined);
const itemsOf = (v: RdfValue | undefined): RdfValue[] => (v?.kind === 'array' ? v.items.map((i) => i.value) : []);
/** XMPCore's `isArrayOrdered`, which an Alt satisfies too. */
const isOrdered = (v: RdfValue) => v.kind === 'array' && v.form !== 'Bag';

/** The `pdfaExtension:schemas` property. veraPDF lists it apart from the
 *  packet's properties, so it is never itself "undescribed". */
export function extensionContainer(packet: RdfPacket): RdfProperty | undefined {
  return packet.properties.find((p) => p.ns === PDFA_EXTENSION_NS && p.name === 'schemas');
}

/** Namespace → the property names a packet describes, by veraPDF's
 *  registration: a schema needs a simple `namespaceURI` and an array
 *  `property`; a property needs a simple `name` and `valueType`. A later
 *  entry for a namespace REPLACES an earlier one. */
export function describedProperties(packet: RdfPacket): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const c = extensionContainer(packet);
  if (c === undefined || c.value.kind !== 'array') return out;
  for (const schema of itemsOf(c.value)) {
    const ns = textOf(childOf(schema, PDFA_SCHEMA_NS, 'namespaceURI'));
    const props = childOf(schema, PDFA_SCHEMA_NS, 'property');
    if (ns === undefined || props === undefined || props.value.kind !== 'array') continue;
    const names = new Set<string>();
    for (const p of itemsOf(props.value)) {
      const name = textOf(childOf(p, PDFA_PROPERTY_NS, 'name'));
      if (name !== undefined && textOf(childOf(p, PDFA_PROPERTY_NS, 'valueType')) !== undefined) names.add(name);
    }
    out.set(ns, names);
  }
  return out;
}

/** Top-level properties neither predefined for `part` nor described — by this
 *  packet, or at parts 2–3 by the catalog's (`main`). */
export function undescribedProperties(packet: RdfPacket, part: PdfaPart, main?: RdfPacket): RdfProperty[] {
  const era = eraOf(part);
  const own = describedProperties(packet);
  const fromMain = part === 1 || main === undefined ? new Map<string, Set<string>>() : describedProperties(main);
  return packet.properties.filter((p) =>
    !(p.ns === PDFA_EXTENSION_NS && p.name === 'schemas')
    && !isPredefinedProperty(p.ns, p.name, era)
    && !own.get(p.ns)?.has(p.name)
    && !fromMain.get(p.ns)?.has(p.name));
}

const clause = (part: PdfaPart, one: string, twoThree: string) => `ISO 19005-${part} §${part === 1 ? one : twoThree}`;

/** The type names a schema declares in its own `valueType` Seq. A type with
 *  fields registers only when it also states a `namespaceURI`. */
function localTypes(vts: RdfValue | undefined): string[] {
  const out: string[] = [];
  for (const vt of itemsOf(vts)) {
    const name = textOf(childOf(vt, PDFA_TYPE_NS, 'type'));
    if (name === undefined) continue;
    const fields = childOf(vt, PDFA_TYPE_NS, 'field');
    const hasFields = fields !== undefined && fields.value.kind === 'array' && fields.value.items.length > 0;
    if (!hasFields || textOf(childOf(vt, PDFA_TYPE_NS, 'namespaceURI')) !== undefined) out.push(name);
  }
  return out;
}

function structureIssues(t: PacketUnderTest, part: PdfaPart): ValidationIssue[] {
  const c = extensionContainer(t.packet);
  if (c === undefined) return [];
  const out: ValidationIssue[] = [];
  const at = t.object !== undefined ? { object: t.object } : {};
  const structCl = clause(part, '6.7.8', '6.6.2.3.3');
  const issue = (rule: string, cl: string, message: string) => { out.push({ rule, severity: 'error', clause: cl, message, ...at }); };
  // One prefix per namespace: the model keeps the source's FIRST binding,
  // where veraPDF reads each element's own — a stated divergence.
  const prefixOk = (ns: string) => t.packet.prefixes.get(ns) === REQUIRED_PREFIX.get(ns);

  if (!(c.value.kind === 'array' && c.value.form === 'Bag') || !prefixOk(PDFA_EXTENSION_NS))
    issue('XmpExtensionContainer', structCl, 'pdfaExtension:schemas must be an rdf:Bag written with the prefix pdfaExtension.');
  if (c.value.kind !== 'array') return out;

  const undefinedFields = (v: RdfValue, ns: string, what: string) => {
    const allowed = ALLOWED.get(ns)!;
    const bad = fieldsOf(v).filter((f) => f.ns !== ns || !allowed.has(f.name));
    if (bad.length) issue('XmpExtensionUndefinedField', clause(part, '6.7.8', '6.6.2.3.2'),
      `${what} carries fields outside ${REQUIRED_PREFIX.get(ns)}: ${bad.map((f) => `${f.name} (${f.ns})`).join(', ')}.`);
  };
  /** A required simple field; returns its text when it has one. */
  const textField = (v: RdfValue, ns: string, name: string, what: string): string | undefined => {
    const f = childOf(v, ns, name);
    const pre = REQUIRED_PREFIX.get(ns)!;
    if (f === undefined) issue('XmpExtensionField', structCl, `${what} has no ${pre}:${name}.`);
    else if (f.value.kind !== 'simple') issue('XmpExtensionField', structCl, `${what}'s ${pre}:${name} must be a simple value.`);
    else if (!prefixOk(ns)) issue('XmpExtensionField', structCl, `${what}'s ${name} must be written with the prefix ${pre}.`);
    return textOf(f);
  };
  /** An optional Seq field: absent, or ordered and correctly prefixed. */
  const seqField = (v: RdfValue, ns: string, name: string, what: string): RdfProperty | undefined => {
    const f = childOf(v, ns, name);
    if (f === undefined) return undefined;
    const pre = REQUIRED_PREFIX.get(ns)!;
    if (!isOrdered(f.value)) issue('XmpExtensionField', structCl, `${what}'s ${pre}:${name} must be an rdf:Seq.`);
    else if (!prefixOk(ns)) issue('XmpExtensionField', structCl, `${what}'s ${name} must be written with the prefix ${pre}.`);
    return f;
  };
  const checkType = (vt: string | undefined, known: ReadonlySet<string>, what: string) => {
    if (vt !== undefined && !isKnownValueType(vt, known))
      issue('XmpExtensionValueType', structCl, `${what} names value type "${vt}", which is neither predefined nor declared by its schema.`);
  };

  const era = eraOf(part);
  c.value.items.forEach((item, i) => {
    const s = item.value;
    const ns = textOf(childOf(s, PDFA_SCHEMA_NS, 'namespaceURI'));
    const what = `Extension schema ${ns ?? `#${i + 1}`}`;
    undefinedFields(s, PDFA_SCHEMA_NS, what);
    for (const n of ['schema', 'namespaceURI', 'prefix']) textField(s, PDFA_SCHEMA_NS, n, what);
    const props = seqField(s, PDFA_SCHEMA_NS, 'property', what);
    const vts = seqField(s, PDFA_SCHEMA_NS, 'valueType', what);
    const registered = ns !== undefined && props !== undefined && props.value.kind === 'array';
    const known = registered ? valueTypesFor(era, localTypes(vts?.value)) : valueTypesFor(undefined);

    for (const p of itemsOf(props?.value)) {
      const pw = `Property ${textOf(childOf(p, PDFA_PROPERTY_NS, 'name')) ?? '(unnamed)'} of ${what}`;
      undefinedFields(p, PDFA_PROPERTY_NS, pw);
      textField(p, PDFA_PROPERTY_NS, 'name', pw);
      checkType(textField(p, PDFA_PROPERTY_NS, 'valueType', pw), known, pw);
      const cat = textField(p, PDFA_PROPERTY_NS, 'category', pw);
      if (cat !== undefined && cat !== 'internal' && cat !== 'external')
        issue('XmpExtensionValueType', structCl, `${pw} has category "${cat}"; it must be internal or external.`);
      textField(p, PDFA_PROPERTY_NS, 'description', pw);
    }
    for (const vt of itemsOf(vts?.value)) {
      const tw = `Value type ${textOf(childOf(vt, PDFA_TYPE_NS, 'type')) ?? '(unnamed)'} of ${what}`;
      undefinedFields(vt, PDFA_TYPE_NS, tw);
      for (const n of ['type', 'namespaceURI', 'prefix', 'description']) textField(vt, PDFA_TYPE_NS, n, tw);
      const fields = seqField(vt, PDFA_TYPE_NS, 'field', tw);
      for (const f of itemsOf(fields?.value)) {
        const fw = `Field ${textOf(childOf(f, PDFA_FIELD_NS, 'name')) ?? '(unnamed)'} of ${tw}`;
        undefinedFields(f, PDFA_FIELD_NS, fw);
        textField(f, PDFA_FIELD_NS, 'name', fw);
        checkType(textField(f, PDFA_FIELD_NS, 'valueType', fw), known, fw);
        textField(f, PDFA_FIELD_NS, 'description', fw);
      }
    }
  });
  return out;
}

/** Every issue for these packets at `part`. */
export function extensionSchemaIssues(packets: readonly PacketUnderTest[], part: PdfaPart): ValidationIssue[] {
  const main = packets.find((t) => t.main)?.packet;
  const out: ValidationIssue[] = [];
  for (const t of packets) {
    for (const p of undescribedProperties(t.packet, part, t.main ? undefined : main)) {
      out.push({
        rule: 'XmpPropertyNotDescribed', severity: 'error', clause: clause(part, '6.7.9', '6.6.2.3.1'),
        message: `XMP property ${t.packet.prefixes.get(p.ns) ?? p.ns}:${p.name} is neither predefined for PDF/A-${part} `
          + 'nor described in pdfaExtension:schemas.',
        ...(t.object !== undefined ? { object: t.object } : {}),
      });
    }
    out.push(...structureIssues(t, part));
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfaext.test.ts`
Expected: PASS. If a structure case reports an extra rule, read the message: every case above is built so exactly one defect is present, so an extra rule is either a fixture defect (fix the fixture and say so in the commit) or a rule firing where veraPDF's would not (fix the code).

- [ ] **Step 5: Commit**

```bash
git add src/pdfaext.ts test/pdfaext.test.ts
git commit -m "feat(o6uu.6): PDF/A extension-schema rules over the XMP model"
```

---

### Task 3: The converter pass

**Files:**
- Create: `src/pdfaextfix.ts`
- Modify: `src/xmp.ts` (export `writeXmpPacket`), `src/document.ts` (`installXmpText`), `src/pdfaconvert.ts` (category + pass)
- Test: `test/pdfaextfix.test.ts`

**Interfaces:**
- Consumes: Task 2's `undescribedProperties`, `extensionContainer`, `childOf`, `textOf`, `PDFA_*_NS`, `REQUIRED_PREFIX`, `PdfaPart`, `extensionSchemaIssues`.
- Produces:
  - `src/xmp.ts`: `writeXmpPacket(packet: RdfPacket): string`
  - `Document.installXmpText(text: string): void` (`@internal`)
  - `src/pdfaextfix.ts`: `addMissingDescriptions(packet: RdfPacket, part: PdfaPart): { added: string[]; left: string[] }`; `describeCatalogXmp(doc: Document, part: PdfaPart): ConvertAction[]`
  - `ConvertCategory` gains `'extensionSchemas'`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdfaextfix.test.ts
import { describe, it, expect } from 'vitest';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { addMissingDescriptions } from '../src/pdfaextfix.js';
import { extensionSchemaIssues, PDFA_EXTENSION_NS } from '../src/pdfaext.js';
import { writeXmpPacket } from '../src/xmp.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const enc = (s: string) => new TextEncoder().encode(s);
const text = (inner: string, ns = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + '<rdf:Description rdf:about="" xmlns:acme="http://acme.example/ns/1.0/"'
  + ` xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"${ns}>`
  + `${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string, ns = '') => parseRdfPacket(enc(text(inner, ns)));
/** Write, re-read, and validate — what the converter's re-validation sees. */
const after = (inner: string, part: 1 | 2 = 2, ns = '') => {
  const p = pkt(inner, ns);
  const r = addMissingDescriptions(p, part);
  const back = parseRdfPacket(enc(writeXmpPacket(p)));
  return { r, back, issues: extensionSchemaIssues([{ packet: back, main: true }], part) };
};

describe('addMissingDescriptions', () => {
  it('describes a simple value in an unknown namespace as external Text', () => {
    const { r, back, issues } = after('<acme:Batch>B1</acme:Batch>');
    expect(r).toEqual({ added: ['acme:Batch'], left: [] });
    expect(issues).toEqual([]);
    expect(writeXmpPacket(back)).toContain('<pdfaProperty:valueType>Text</pdfaProperty:valueType>');
    expect(writeXmpPacket(back)).toContain('<pdfaProperty:category>external</pdfaProperty:category>');
  });

  it('describes pdfuaid and pdfxid with their real types, category internal', () => {
    const { r, back, issues } = after('<pdfuaid:part>1</pdfuaid:part><pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>');
    expect(r.added.sort()).toEqual(['pdfuaid:part', 'pdfxid:GTS_PDFXVersion']);
    expect(issues).toEqual([]);
    const s = writeXmpPacket(back);
    expect(s).toContain('<pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>');
    expect(s).toMatch(/<pdfaProperty:name>part<\/pdfaProperty:name>\s*<pdfaProperty:valueType>Integer</);
    expect(s).toContain('<pdfaProperty:category>internal</pdfaProperty:category>');
  });

  it('leaves an array, a struct and a URI in an unknown namespace reported', () => {
    const inner = '<acme:List><rdf:Bag><rdf:li>a</rdf:li></rdf:Bag></acme:List>'
      + '<acme:S rdf:parseType="Resource"><acme:x>1</acme:x></acme:S><acme:U rdf:resource="http://x"/>';
    const { r, issues } = after(inner);
    expect(r.added).toEqual([]);
    expect(r.left.sort()).toEqual(['acme:List', 'acme:S', 'acme:U']);
    expect(issues.filter((i) => i.rule === 'XmpPropertyNotDescribed')).toHaveLength(3);
  });

  it('extends an existing entry for the namespace rather than adding a second', () => {
    const existing = '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
      + '<pdfaSchema:schema>Acme</pdfaSchema:schema><pdfaSchema:namespaceURI>http://acme.example/ns/1.0/</pdfaSchema:namespaceURI>'
      + '<pdfaSchema:prefix>acme</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pdfaProperty:name>Other</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType>'
      + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description>'
      + '</rdf:li></rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas>';
    const ns = ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"'
      + ' xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"';
    const { back, issues } = after(`<acme:Batch>B1</acme:Batch><acme:Other>o</acme:Other>${existing}`, 2, ns);
    expect(issues).toEqual([]);
    const c = back.properties.find((p) => p.ns === PDFA_EXTENSION_NS)!;
    expect(c.value.kind === 'array' && c.value.items.length).toBe(1);
  });

  it('writes the required prefixes even when the source bound the namespaces to others', () => {
    // A pre-existing description under the prefix `ps` fails the prefix test
    // until rewritten; the rewrite pins pdfaSchema and repairs it for free.
    const existing = '<ext:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
      + '<ps:schema>Acme</ps:schema><ps:namespaceURI>http://acme.example/ns/1.0/</ps:namespaceURI>'
      + '<ps:prefix>acme</ps:prefix><ps:property><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pp:name>Other</pp:name><pp:valueType>Text</pp:valueType><pp:category>external</pp:category>'
      + '<pp:description>d</pp:description></rdf:li></rdf:Seq></ps:property></rdf:li></rdf:Bag></ext:schemas>';
    const ns = ' xmlns:ext="http://www.aiim.org/pdfa/ns/extension/" xmlns:ps="http://www.aiim.org/pdfa/ns/schema#"'
      + ' xmlns:pp="http://www.aiim.org/pdfa/ns/property#"';
    const before = extensionSchemaIssues([{ packet: pkt(`<acme:Other>o</acme:Other>${existing}`, ns), main: true }], 2);
    expect(before.length).toBeGreaterThan(0);
    const { issues } = after(`<acme:Batch>B1</acme:Batch><acme:Other>o</acme:Other>${existing}`, 2, ns);
    expect(issues).toEqual([]);
  });

  it('adds nothing when the container is not a Bag', () => {
    const seq = '<pdfaExtension:schemas><rdf:Seq/></pdfaExtension:schemas>';
    const ns = ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"';
    const p = pkt(`<acme:Batch>B1</acme:Batch>${seq}`, ns);
    expect(addMissingDescriptions(p, 2)).toEqual({ added: [], left: ['acme:Batch'] });
  });

  it('does nothing to a packet that needs nothing', () => {
    const p = pkt('');
    expect(addMissingDescriptions(p, 2)).toEqual({ added: [], left: [] });
    expect(p.properties).toEqual([]);
  });
});

describe('ConvertToPdfA extensionSchemaPass', () => {
  const custom = { namespace: 'http://acme.example/ns/1.0/', prefix: 'acme', name: 'Batch', value: 'B1' };
  const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); d.SetXmp({ custom: [custom] }); return d; };
  const schemasOf = (d: Document) => d.GetXmpValue(PDFA_EXTENSION_NS, 'schemas')?.asArray()?.length ?? 0;

  it('describes the custom property at parts 1-3 and reports it in applied', () => {
    for (const level of ['1b', '2b', '3b'] as const) {
      const d = doc1();
      const report = d.ConvertToPdfA(level);
      expect(schemasOf(d)).toBe(1);
      expect(report.applied.map((a) => a.rule)).toContain('XmpPropertyNotDescribed');
    }
  });

  it('does nothing at part 4, or under preserve', () => {
    const d4 = doc1();
    d4.ConvertToPdfA('4');
    expect(schemasOf(d4)).toBe(0);
    const dp = doc1();
    dp.ConvertToPdfA('2b', { preserve: ['extensionSchemas'] });
    expect(schemasOf(dp)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfaextfix.test.ts`
Expected: FAIL — cannot resolve `../src/pdfaextfix.js`.

- [ ] **Step 3: `writeXmpPacket` in `src/xmp.ts`**

Add below `editXmpPacket`, and make `editXmpPacket` end with it:

```ts
/** A model packet as the text `SetXmp` writes: characters XML cannot carry
 *  stripped, the six built-in namespaces pinned to their standard prefixes.
 *  The one owner of that tail, shared by `editXmpPacket` and the PDF/A
 *  extension-schema pass (`o6uu.6`). */
export function writeXmpPacket(packet: RdfPacket): string {
  sanitize(packet.properties);
  return serializeRdfPacket(pinBuiltinPrefixes(packet));
}
```

and replace the last two statements of `editXmpPacket`:

```ts
  sanitize(packet.properties);
  return serializeRdfPacket(pinBuiltinPrefixes(packet));
```

with:

```ts
  return writeXmpPacket(packet);
```

- [ ] **Step 4: `installXmpText` in `src/document.ts`**

Replace the body of `installXmp` and add the internal method beside it:

```ts
  private installXmp(update: XmpUpdate): void {
    const md = this.resolve(this.catalog().get('Metadata'));
    const text = editXmpPacket(isStream(md) ? inflateStream(md) : undefined, update);
    if (text !== undefined) this.installXmpText(text);
  }

  /** @internal Install `text` as the catalog's /Metadata stream, uncompressed.
   *  The one place a packet becomes a stream — `installXmp` and the PDF/A
   *  extension-schema pass (`o6uu.6`) both end here. */
  installXmpText(text: string): void {
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Metadata')], ['Subtype', name('XML')],
    ]);
    const stream: PdfStream = { kind: 'stream', dict, raw: new TextEncoder().encode(text) };
    this.catalog().set('Metadata', this.allocObject(stream));
  }
```

- [ ] **Step 5: `src/pdfaextfix.ts`**

```ts
import type { Document } from './document.js';
import type { ConvertAction } from './conversion.js';
import { isStream } from './types.js';
import { inflateStream } from './flate.js';
import { parseRdfPacket, type RdfPacket, type RdfProperty } from './xmprdf.js';
import { writeXmpPacket } from './xmp.js';
import { rethrowLimit } from './errors.js';
import {
  undescribedProperties, extensionContainer, childOf, textOf, REQUIRED_PREFIX, type PdfaPart,
  PDFA_EXTENSION_NS, PDFA_SCHEMA_NS, PDFA_PROPERTY_NS,
} from './pdfaext.js';

/** Writing the extension-schema descriptions PDF/A needs (`o6uu.6`), for the
 *  properties whose type can be stated TRUTHFULLY: `pdfuaid` and `pdfxid`
 *  from their standards, and a simple non-URI value in any other namespace as
 *  `Text`. An array, a struct or a URI in an unknown namespace is left and
 *  stays reported — its type would be a guess. */

const PDFUA_NS = 'http://www.aiim.org/pdfua/ns/id/';
const PDFX_NS = 'http://www.npes.org/pdfx/ns/id/';

interface KnownSchema { schema: string; prefix: string; props: Record<string, { valueType: string; description: string }> }
const KNOWN: ReadonlyMap<string, KnownSchema> = new Map([
  [PDFUA_NS, { schema: 'PDF/UA Universal Accessibility Schema', prefix: 'pdfuaid', props: {
    part: { valueType: 'Integer', description: 'Indicates, which part of ISO 14289 standard is followed' },
    rev: { valueType: 'Integer', description: 'Indicates the year of the revision of the part of ISO 14289 that is followed' },
    amd: { valueType: 'Text', description: 'Optional: specifies amendment identifier' },
    corr: { valueType: 'Text', description: 'Optional: specifies corrigenda identifier' },
  } }],
  [PDFX_NS, { schema: 'PDF/X ID Schema', prefix: 'pdfxid', props: {
    GTS_PDFXVersion: { valueType: 'Text', description: 'ID of PDF/X standard' },
  } }],
]);

const simple = (ns: string, name: string, value: string): RdfProperty => ({ ns, name, value: { kind: 'simple', value } });

function describe(name: string, valueType: string, category: string, description: string): RdfProperty['value'] {
  return { kind: 'struct', fields: [
    simple(PDFA_PROPERTY_NS, 'name', name), simple(PDFA_PROPERTY_NS, 'valueType', valueType),
    simple(PDFA_PROPERTY_NS, 'category', category), simple(PDFA_PROPERTY_NS, 'description', description),
  ] };
}

/** Bind each PDF/A extension namespace to its required prefix, taking the
 *  prefix from any other namespace that holds it — the serializer prefers the
 *  model's binding, so without this a source's `ps:` is written back. */
function pinPdfaPrefixes(packet: RdfPacket): void {
  for (const [ns, pre] of REQUIRED_PREFIX) {
    for (const [other, p] of [...packet.prefixes]) if (p === pre && other !== ns) packet.prefixes.delete(other);
    packet.prefixes.set(ns, pre);
  }
}

/** Describe what can be described, in place. `added` and `left` are
 *  `prefix:name` labels. */
export function addMissingDescriptions(packet: RdfPacket, part: PdfaPart): { added: string[]; left: string[] } {
  const label = (p: RdfProperty) => `${packet.prefixes.get(p.ns) ?? p.ns}:${p.name}`;
  const missing = undescribedProperties(packet, part);
  if (missing.length === 0) return { added: [], left: [] };
  let container = extensionContainer(packet);
  if (container !== undefined && !(container.value.kind === 'array' && container.value.form === 'Bag'))
    return { added: [], left: missing.map(label) };

  const plan = new Map<string, { prop: RdfProperty; desc: RdfProperty['value'] }[]>();
  const left: string[] = [];
  for (const p of missing) {
    const known = KNOWN.get(p.ns);
    const k = known?.props[p.name];
    let desc: RdfProperty['value'] | undefined;
    if (k !== undefined) desc = describe(p.name, k.valueType, 'internal', k.description);
    else if (known === undefined && p.value.kind === 'simple' && !p.value.uri)
      desc = describe(p.name, 'Text', 'external', 'Added by PDF/A conversion: the value is carried as Text.');
    if (desc === undefined) { left.push(label(p)); continue; }
    if (!plan.has(p.ns)) plan.set(p.ns, []);
    plan.get(p.ns)!.push({ prop: p, desc });
  }
  if (plan.size === 0) return { added: [], left };

  if (container === undefined) {
    container = { ns: PDFA_EXTENSION_NS, name: 'schemas', value: { kind: 'array', form: 'Bag', items: [] } };
    packet.properties.push(container);
  }
  const items = (container.value as Extract<RdfProperty['value'], { kind: 'array' }>).items;
  const added: string[] = [];
  for (const [ns, entries] of plan) {
    const descItems = entries.map((e) => ({ value: e.desc }));
    // veraPDF registers the LAST entry for a namespace, so that is the one to extend.
    let entry: (typeof items)[number] | undefined;
    for (let i = items.length - 1; i >= 0 && entry === undefined; i--)
      if (textOf(childOf(items[i].value, PDFA_SCHEMA_NS, 'namespaceURI')) === ns) entry = items[i];
    if (entry === undefined) {
      const known = KNOWN.get(ns);
      items.push({ value: { kind: 'struct', fields: [
        simple(PDFA_SCHEMA_NS, 'schema', known?.schema ?? `Properties in ${ns}`),
        simple(PDFA_SCHEMA_NS, 'namespaceURI', ns),
        simple(PDFA_SCHEMA_NS, 'prefix', known?.prefix ?? packet.prefixes.get(ns) ?? 'ns'),
        { ns: PDFA_SCHEMA_NS, name: 'property', value: { kind: 'array', form: 'Seq', items: descItems } },
      ] } });
    } else {
      const props = childOf(entry.value, PDFA_SCHEMA_NS, 'property');
      if (props === undefined && entry.value.kind === 'struct')
        entry.value.fields.push({ ns: PDFA_SCHEMA_NS, name: 'property', value: { kind: 'array', form: 'Seq', items: descItems } });
      else if (props !== undefined && props.value.kind === 'array') props.value.items.push(...descItems);
      else { left.push(...entries.map((e) => label(e.prop))); continue; }
    }
    added.push(...entries.map((e) => label(e.prop)));
  }
  if (added.length) pinPdfaPrefixes(packet);
  return { added, left };
}

/** Run `addMissingDescriptions` over the catalog packet and install the
 *  result. A missing or unparseable packet is left alone — there is nothing
 *  safe to edit. */
export function describeCatalogXmp(doc: Document, part: PdfaPart): ConvertAction[] {
  const md = doc.resolve(doc.catalog().get('Metadata'));
  if (!isStream(md)) return [];
  let packet: RdfPacket;
  try {
    packet = parseRdfPacket(inflateStream(md), doc.loadLimits);
  } catch (e) {
    rethrowLimit(e);
    return [];
  }
  const { added } = addMissingDescriptions(packet, part);
  if (added.length === 0) return [];
  doc.installXmpText(writeXmpPacket(packet));
  return [{ rule: 'XmpPropertyNotDescribed', action: `Described ${added.join(', ')} in pdfaExtension:schemas.` }];
}
```

- [ ] **Step 6: The pass in `src/pdfaconvert.ts`**

1. Add `| 'extensionSchemas'` to `ConvertCategory` (after `'transparency'`).
2. Add the import: `import { describeCatalogXmp } from './pdfaextfix.js';`
3. Add the pass after `identificationPass`'s definition:

```ts
/** Describe in `pdfaExtension:schemas` every XMP property that is neither
 *  predefined nor described (ISO 19005-1 6.7.9, -2/-3 6.6.2.3.1; `o6uu.6`).
 *  Parts 1–3 only — ISO 19005-4 has no such rule. Runs after
 *  identificationPass, which may have written the properties it describes. */
const extensionSchemaPass: Pass = (ctx) => {
  if (ctx.part === 4 || ctx.preserve.has('extensionSchemas')) return [];
  return describeCatalogXmp(ctx.doc, ctx.part);
};
```

4. In `PASSES`, change the first line to `identificationPass, extensionSchemaPass, versionPass, fileIdPass, outputIntentPass,`.

- [ ] **Step 7: Run to verify pass, and the fences**

Run: `npx vitest run test/pdfaextfix.test.ts test/xmp-edit.test.ts test/xmp-preserve.test.ts test/xmp.test.ts test/pdfaconvert.test.ts test/import-cycles.test.ts`
Expected: PASS. `import-cycles` must stay green: `pdfaextfix.ts` imports `document.ts` and `conversion.ts` as TYPES only.

- [ ] **Step 8: Commit**

```bash
git add src/pdfaextfix.ts src/xmp.ts src/document.ts src/pdfaconvert.ts test/pdfaextfix.test.ts
git commit -m "feat(o6uu.6): ConvertToPdfA describes undescribed XMP properties"
```

---

### Task 4: Wire the rule into `ValidatePdfA`

**Files:**
- Modify: `src/pdfavalidate.ts`
- Test: `test/pdfa-extension-validate.test.ts`

**Interfaces:**
- Consumes: Task 2's `extensionSchemaIssues`, `PacketUnderTest`; Task 3's converter.
- Produces: `extensionSchemaRule` in `RULES`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdfa-extension-validate.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS } from '../src/xmprdf.js';

const custom = { namespace: 'http://acme.example/ns/1.0/', prefix: 'acme', name: 'Batch', value: 'B1' };
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
const rulesAt = (d: Document, level: '1b' | '2b' | '3b' | '4') => d.ValidatePdfA(level).Issues.map((i) => i.rule);
const metadataStream = (d: Document, text: string) => {
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
  return d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) });
};
const packet = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + '<rdf:Description rdf:about="" xmlns:acme="http://acme.example/ns/1.0/">'
  + `${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;

describe('ValidatePdfA XmpPropertyNotDescribed', () => {
  it('reports an undescribed custom property at parts 1-3 and never at part 4', () => {
    const d = doc1();
    d.SetXmp({ custom: [custom] });
    for (const level of ['1b', '2b', '3b'] as const) expect(rulesAt(d, level)).toContain('XmpPropertyNotDescribed');
    expect(rulesAt(d, '4')).not.toContain('XmpPropertyNotDescribed');
  });

  it('is resolved by ConvertToPdfA', () => {
    const d = doc1();
    d.SetXmp({ custom: [custom] });
    const report = d.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpPropertyNotDescribed');
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
  });

  it('checks an object-level metadata stream, which the catalog packet may describe at part 2 only', () => {
    const d = doc1();
    d.SetXmp({ custom: [custom] });
    d.ConvertToPdfA('2b');                        // the catalog packet now describes acme:Batch
    const ref = metadataStream(d, packet('<acme:Batch>X</acme:Batch>'));
    d.Pages[0].Dict.set('Metadata', ref);
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
    const part1 = d.ValidatePdfA('1b').Issues.filter((i) => i.rule === 'XmpPropertyNotDescribed');
    expect(part1.some((i) => i.object?.num === ref.num)).toBe(true);
  });

  it('ignores a metadata stream that will not parse, without throwing', () => {
    const d = doc1();
    d.Pages[0].Dict.set('Metadata', metadataStream(d, '<not xml'));
    expect(() => d.ValidatePdfA('2b')).not.toThrow();
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfa-extension-validate.test.ts`
Expected: FAIL — the first and third cases (the rule is not wired). The `ConvertToPdfA` and unparseable cases pass already; they are guards.

- [ ] **Step 3: Implement**

In `src/pdfavalidate.ts` add the imports:

```ts
import { parseRdfPacket } from './xmprdf.js';
import { extensionSchemaIssues, type PacketUnderTest } from './pdfaext.js';
```

Add the rule after `xmpInfoConsistencyRule`:

```ts
/** Every XMP property predefined or described, and every description well
 *  formed (ISO 19005-1 6.7.8–6.7.9, -2/-3 6.6.2.3; `o6uu.6`) — over EVERY
 *  metadata stream, as veraPDF checks each XMP package. Part 4 has no such
 *  rule. A stream that will not parse is skipped: well-formedness is a
 *  separate clause. */
const extensionSchemaRule: Rule = (ctx) => {
  if (ctx.part === 4) return [];
  const mainRef = ctx.catalog.get('Metadata');
  const packets: PacketUnderTest[] = [];
  for (const [ref, obj] of allObjects(ctx)) {
    if (!isStream(obj)) continue;
    const main = isRef(mainRef) && mainRef.num === ref.num;
    if (!main && nameOf(ctx, obj.dict, 'Type') !== 'Metadata') continue;
    try {
      const packet = parseRdfPacket(inflateStream(obj), ctx.doc.loadLimits);
      packets.push(main ? { packet, main } : { packet, main, object: ref });
    } catch (e) {
      rethrowLimit(e);
    }
  }
  return extensionSchemaIssues(packets, ctx.part);
};
```

In `RULES`, change `metadataRule, pdfaIdRule, xmpInfoConsistencyRule,` to `metadataRule, pdfaIdRule, xmpInfoConsistencyRule, extensionSchemaRule,`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfa-extension-validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Triage the existing suite**

Run: `npx vitest run test/pdfavalidate.test.ts test/pdfaconvert.test.ts test/pdfa4-validate.test.ts test/pdfa4-convert.test.ts test/pdfua2-convert.test.ts test/image-colorspace-scan.test.ts test/colorsep.test.ts > "$TMPDIR/pdfa.log" 2>&1; tail -40 "$TMPDIR/pdfa.log"`
Then the whole suite: `npm test`.
Expected: green, or failures of ONE kind — a case asserting `passed`/an exact issue list on a document whose XMP carries a property the new rule reports. For each: confirm from the message that the property is genuinely undescribed and not predefined (grep `src/xmpschemadata.ts`), then EITHER the document should have been converted (`ConvertToPdfA` now describes it — find out why it did not) OR the assertion predates the rule and gets updated with the reason in the commit message. Any other failure is a bug: stop and debug.

- [ ] **Step 6: Commit**

```bash
git add src/pdfavalidate.ts test/pdfa-extension-validate.test.ts
git commit -m "feat(o6uu.6): ValidatePdfA reports undescribed XMP properties"
```

---

### Task 5: `ConvertToPdfUa` on a PDF/A document

**Files:**
- Modify: `src/pdfuaconvert.ts`
- Test: append to `test/pdfa-extension-validate.test.ts`

**Interfaces:**
- Consumes: Task 3's `describeCatalogXmp(doc, part)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pdfa-extension-validate.test.ts`:

```ts
describe('ConvertToPdfUa on a PDF/A document', () => {
  it('describes pdfuaid so the document stays PDF/A', () => {
    const d = doc1();
    d.ConvertToPdfA('2b');
    d.ConvertToPdfUa();
    expect(d.GetXmp().pdfuaPart).toBe(1);
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
  });

  it('writes no extension schema on a document that claims no PDF/A part 1-3', () => {
    const d = doc1();
    d.ConvertToPdfUa();
    expect(d.GetXmpValue('http://www.aiim.org/pdfa/ns/extension/', 'schemas')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfa-extension-validate.test.ts`
Expected: FAIL — the first new case reports `XmpPropertyNotDescribed` (for `pdfuaid:part`).

- [ ] **Step 3: Implement**

In `src/pdfuaconvert.ts` add `import { describeCatalogXmp } from './pdfaextfix.js';` and, after `identificationPass`:

```ts
/** A PDF/A document stays PDF/A (`o6uu.6`): `pdfuaid` is not a predefined
 *  schema for ISO 19005-1..3, so writing it obliges a description. Only when
 *  the packet claims one of those parts — a plain document gets no extension
 *  schema it does not need. */
const pdfaExtensionPass: Pass = (ctx) => {
  const part = ctx.doc.GetXmp().pdfaPart;
  return part === 1 || part === 2 || part === 3 ? describeCatalogXmp(ctx.doc, part) : [];
};
```

In `PASSES`, change `identificationPass,` to `identificationPass, pdfaExtensionPass,`.

- [ ] **Step 4: Run to verify pass, and the PDF/UA suites**

Run: `npx vitest run test/pdfa-extension-validate.test.ts test/pdfuaconvert.test.ts test/pdfua2-convert.test.ts`
Expected: PASS. (If `test/pdfuaconvert.test.ts` does not exist, `ls test | grep -i pdfua` and run the convert suites that do.)

- [ ] **Step 5: Commit**

```bash
git add src/pdfuaconvert.ts test/pdfa-extension-validate.test.ts
git commit -m "feat(o6uu.6): ConvertToPdfUa describes pdfuaid on a PDF/A document"
```

---

### Task 6: Docs, mutation pass, full verification, close

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: README**

In the **PDF/A validation** bullet (`grep -n "PDF/A validation\*\* —" README.md`), append:

```markdown
 At parts 1–3 it also checks the XMP packets — the catalog's and every object-level one — for properties that are neither predefined by the XMP 2004 (part 1) or 2005 (parts 2–3) schemas nor described in `pdfaExtension:schemas`, and checks each description's structure (`XmpPropertyNotDescribed`, `XmpExtensionContainer`, `XmpExtensionUndefinedField`, `XmpExtensionField`, `XmpExtensionValueType`). The predefined tables are generated from veraPDF's; property VALUES are not type-checked yet. PDF/A-4 has no such rule.
```

In the **PDF/A conversion** bullet, append:

```markdown
 At parts 1–3 it writes the missing `pdfaExtension:schemas` descriptions it can state truthfully — `pdfuaid` and `pdfxid` with their standard types, and any other simple text property as `Text` — and leaves an array, struct or URI in an unknown namespace unresolved; `preserve: ['extensionSchemas']` declines. `ConvertToPdfUa` does the same for `pdfuaid` when the document already claims PDF/A part 1–3, so a PDF/A + PDF/UA document stays PDF/A.
```

Run: `npx vitest run test/readme-api.test.ts` — expected PASS (no new exports).

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → the first `### Added`, at the top:

```markdown
- **PDF/A checks that every XMP property is predefined or described.**
  `ValidatePdfA` at parts 1–3 now reports an XMP property that is neither in
  the XMP 2004 (part 1) or 2005 (parts 2–3) predefined schemas nor described
  in the packet's `pdfaExtension:schemas`, and a description that is itself
  malformed — the rule veraPDF enforces and this library did not, so a file
  whose custom namespace lost its description validated here and failed
  there. It checks by property rather than namespace, covers object-level
  metadata streams too, and takes its predefined tables from veraPDF's own by
  a generator (`npm run gen:xmpschemas`), so hundreds of rows were not typed
  by hand. `ConvertToPdfA` writes the descriptions it can state truthfully —
  `pdfuaid`, `pdfxid`, and any other simple text value as `Text` — and
  `ConvertToPdfUa` does the same on a document already claiming PDF/A, which
  is what keeps a PDF/A + PDF/UA document conformant. Values are not
  type-checked yet; PDF/A-4 has no such rule (o6uu.6).
```

- [ ] **Step 3: Mutation pass**

Apply each, run the named file, confirm RED, restore with `git checkout -- <file>`, and check `git diff --stat` shows the mutation applied before trusting a green result. Record each result for Step 4.

| # | File | Mutation | Test |
|---|---|---|---|
| 1 | `src/xmpschemas.ts` | `eraOf` returns `'2005'` always | `test/xmpschemas.test.ts`, `test/pdfaext.test.ts` |
| 2 | `src/xmpschemas.ts` | `isKnownValueType` skips the peel loop | `test/xmpschemas.test.ts` |
| 3 | `src/xmpschemas.ts` | `simplifyValueType` drops the bare-array `' text'` suffix | `test/xmpschemas.test.ts` |
| 4 | `src/pdfaext.ts` | `describedProperties` merges into an existing set instead of replacing | `test/pdfaext.test.ts` |
| 5 | `src/pdfaext.ts` | `describedProperties` ignores the `valueType` requirement | `test/pdfaext.test.ts` |
| 6 | `src/pdfaext.ts` | `undescribedProperties` consults `main` at part 1 too | `test/pdfaext.test.ts` |
| 7 | `src/pdfaext.ts` | container check accepts any array form | `test/pdfaext.test.ts` |
| 8 | `src/pdfaext.ts` | `prefixOk` always true | `test/pdfaext.test.ts` |
| 9 | `src/pdfaext.ts` | `registered` always true | `test/pdfaext.test.ts` |
| 10 | `src/pdfaext.ts` | `localTypes` returns `[]` | `test/pdfaext.test.ts` |
| 11 | `src/pdfaext.ts` | `seqField` accepts a Bag | `test/pdfaext.test.ts` |
| 12 | `src/pdfaextfix.ts` | a struct in an unknown namespace is described as Text | `test/pdfaextfix.test.ts` |
| 13 | `src/pdfaextfix.ts` | `pinPdfaPrefixes` removed | `test/pdfaextfix.test.ts` |
| 14 | `src/pdfaextfix.ts` | always push a new schema entry | `test/pdfaextfix.test.ts` |
| 15 | `src/pdfavalidate.ts` | `extensionSchemaRule` reads only the catalog stream | `test/pdfa-extension-validate.test.ts` |
| 16 | `src/pdfavalidate.ts` | drop the part-4 gate | `test/pdfa-extension-validate.test.ts` |
| 17 | `src/pdfuaconvert.ts` | `pdfaExtensionPass` returns `[]` | `test/pdfa-extension-validate.test.ts` |

A mutation that stays GREEN is a coverage gap (add a case) or a redundant defence (record it, keep the code).

- [ ] **Step 4: CLAUDE.md**

Add to the Build section's `gen:` list, after `gen:cidunicode`:

```bash
npm run gen:xmpschemas # xmpschemadata.ts — veraPDF's predefined XMP tables
```

and change "Five generators" to "Six generators".

Add to the Source list, after the `**xmprdf.ts**` entry:

```markdown
- **xmpschemas.ts**, **xmpschemadata.ts**, **pdfaext.ts**, **pdfaextfix.ts** —
  PDF/A's rule that every XMP property is predefined or described (ISO
  19005-1 6.7.8–6.7.9, -2/-3 6.6.2.3; `o6uu.6`). `xmpschemadata.ts` is
  GENERATED by `scripts/gen-xmp-schemas.mjs` from veraPDF-library at a pinned
  commit — facts only, no code — and `xmpschemas.ts` is the leaf over it;
  `pdfaext.ts` is pure over `RdfPacket` and produces the issues;
  `pdfaextfix.ts` writes missing descriptions and is the only one of the four
  touching a `Document`.
  **Invariant:** parts 1–3 only. `PDFA-4.xml` carries no rule on an XMP
  property or an extension-schema object — ISO 19005-4 dropped it — and parts
  2 and 3 are identical (the 21 extracted rules diff empty).
  **Invariant:** presence is keyed by PROPERTY `(namespace, name)`, never by
  namespace, and part 1 uses the XMP 2004 set where parts 2–3 use 2005. At
  parts 2–3 an object-level packet may also be described by the catalog's.
  **Invariant, and it reads wrong:** a later schema entry for a namespace
  REPLACES an earlier one (veraPDF's registry is a map), and "shall be
  present" is enforced by the PREFIX test — every shape test passes an absent
  field. The converter therefore extends the LAST entry for a namespace.
  **Invariant:** known value types come in three tiers — a schema with no
  simple `namespaceURI` or no `property` array registers nothing and sees only
  `new ValidatorsContainer()`'s base set; a registered one sees its era's set
  plus its own `valueType` declarations.
  **Invariant:** the converter describes only what it can state truthfully:
  `pdfuaid` and `pdfxid` from their standards, a simple non-URI value as
  `Text`. An array, a struct or a URI in an unknown namespace stays reported.
  It pins the five PDF/A extension prefixes on the way out, which also repairs
  a pre-existing description under other prefixes.
  **Note, a stated divergence:** veraPDF reads each element's own prefix; the
  model keeps the FIRST binding per namespace (`RdfPacket.prefixes`).
  **Note, and it corrected the spec:** the vendored Acrobat packet is flagged
  for exactly `xmpMM:OriginalDocumentID` and `pdf:Trapped`, neither of which
  occurs in veraPDF's tables. A real third-party packet reporting two named
  properties is a sharper fence than one reporting none.
  **Note on the anchor:** a transcription with no runnable oracle
  (`72nc.1`'s ceiling). Value-type correctness (6.6.2.3.1-2) is `o6uu.10`.
```

Append a `**Note, measured:**` sentence summarising Step 3.

- [ ] **Step 5: Full verification**

Run: `npm run typecheck` — expected exit 0.
Run: `npm test` — expected all files pass.

- [ ] **Step 6: Commit, close, push**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs(o6uu.6): document PDF/A extension-schema validation"
bd close aspose-pdf-foss-for-ts-o6uu.6
git pull --rebase --autostash
git push
git status
```
Expected: "up to date with origin".
