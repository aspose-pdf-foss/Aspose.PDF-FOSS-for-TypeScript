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

  const obj = (m) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
  const typesTable = (map) => `{\n${[...map.keys()].sort().map((ns) => `  ${JSON.stringify(ns)}: ${JSON.stringify(obj(map.get(ns)))},`).join('\n')}\n}`;
  const structTable = (map) => `{\n${[...map.keys()].sort().map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify({ ns: map.get(n).ns, fields: map.get(n).fields })},`).join('\n')}\n}`;

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
`;
  writeFileSync(outFile, out);
  console.log(`2004: ${count(p2004)} properties / ${p2004.size} namespaces; 2005: ${count(p2005)} / ${p2005.size}; `
    + `types base ${base.size}, 2004 ${t2004.size}, 2005 ${t2005.size}; `
    + `structs 2004 ${structs2004.size}, 2005 ${structs2005.size}; patterns 2004 ${pat2004.size}, 2005 ${pat2005.size}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
