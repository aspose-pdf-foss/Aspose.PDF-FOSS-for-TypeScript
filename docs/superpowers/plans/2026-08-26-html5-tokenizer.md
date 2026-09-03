# HTML5 Tokenizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A conformant WHATWG HTML5 tokenizer — every state, both character-reference forms, and parse errors with positions — passing the official html5lib-tests tokenizer suite.

**Architecture:** A literal transcription of the spec's state machine: one branch per state, named as the spec names it, over a pull model (`next()` / `setState()`) that `zch2.1.2` will steer for RCDATA, RAWTEXT, script data and PLAINTEXT. Character-reference resolution is its own module, since it is a self-contained sub-machine with an entry/return-state contract. Both modules are pure leaves — no `Document`, no PDF object, no `node:` import.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies — this repo has none and adds none.

**Spec:** [`docs/superpowers/specs/2026-08-26-html5-tokenizer-design.md`](../specs/2026-08-26-html5-tokenizer-design.md)

**Issue:** `zch2.1.1`, under `zch2.1`, under epic `zch2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins, and this feature needs none of those either.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension: `import { namedEntity } from './mdentity.js'`.
- **The tokenizer never throws.** Every string is a valid HTML document. Parse errors are values pushed onto `errors`, never control flow. No `PdfParseError`, no `UnsupportedFeatureError`, no `throw` of any kind in `src/htmltoken.ts` or `src/htmlcharref.ts`.
- **Purity.** Neither module may import `document.js`, `page.js`, or any PDF object module. Both take a `string`.
- **Spec names, verbatim.** A `TokenizerState` member is named as §13.2.5 names the state (`ScriptDataDoubleEscapedDashDash`). An `HtmlParseError.code` is the spec's own kebab-case name (`eof-in-tag`). Neither is paraphrased or shortened — this is what makes a failing html5lib case diffable against the spec text.
- **Run before closing any task:** `npm run typecheck` and `npm test`, both green. Target one file with `npx vitest run test/<name>.test.ts`.
- **CHANGELOG.md** gets an `## [Unreleased]` entry only for user-visible change. Tasks 1–7 are internal; Task 8 carries the entry.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/gen-entities.mjs` | **Modify.** Emit the 106 legacy semicolon-less keys as a second map. |
| `src/mdentity.ts` | **Modify (generated).** Legacy name set + `allowsMissingSemicolon` / `MAX_ENTITY_NAME`. `namedEntity` and `ENTITIES` unchanged. |
| `src/htmlcharref.ts` | **Create.** The character-reference sub-machine: numeric with the windows-1252 override, named with longest match and the attribute rule. |
| `src/htmltoken.ts` | **Create.** Token types, `HtmlParseError`, `TokenizerState`, preprocessing, the cursor, and every tokenizer state. |
| `test/helpers/html5lib-tokenizer.ts` | **Create.** Suite loader: file list, `doubleEscaped`, `initialStates` expansion, `lastStartTag`, character-token concatenation, the structural `xmlViolationTests` exclusion. |
| `test/fixtures/html5lib/tokenizer/*.test` | **Vendor.** 14 files from html5lib-tests. |
| `test/fixtures/html5lib/PROVENANCE.md` | **Create.** Source, commit SHA, per-file bytes + SHA-256, coverage and gaps, mutation results. |
| `test/html5lib-tokenizer.test.ts` | **Create.** Drives the vendored suite. |
| `test/htmltoken.test.ts` | **Create.** Hand-built unit tests for the seam and the four silent-when-wrong rules. |
| `test/htmlcharref.test.ts` | **Create.** Hand-built unit tests for the reference sub-machine. |
| `CLAUDE.md` | **Modify.** Source-list entries for both new modules (Task 8). |
| `CHANGELOG.md` | **Modify.** `## [Unreleased]` entry (Task 8). |

`src/index.ts` is **not** modified. Nothing here is public API yet — `parseHtml` arrives with `zch2.1.2`, and exporting a tokenizer nobody can drive would be an API we then have to keep.

---

## The error-position convention

This is the one rule the whole plan depends on and it is not stated in the spec prose. Derived from the vendored expectations and confirmed against five cases:

The cursor tracks two positions. `pos()` is the 1-based line/col of the code point **about to be consumed**; `lastPos()` is that of the code point **just consumed**. Consuming EOF advances the column to `length + 1`.

`error(code)` reports at **`lastPos()`**. The peek-based markup-declaration-open state is the exception and passes `pos()` explicitly.

| Input | Expected | Why |
|---|---|---|
| `<!DOCTYPE HtMl` | `eof-in-doctype` 1:15 | 14 code points; EOF sits at col 15 |
| `<>` | `invalid-first-character-of-tag-name` 1:2 | consumed `>` |
| `<h a='b'c='d'>` | `missing-whitespace-between-attributes` 1:9 | consumed `c` |
| `<h a='&COPY'>` | `missing-semicolon-after-character-reference` 1:12 | consumed the `'` that ended the match |
| `<!DOC>` | `incorrectly-opened-comment` 1:3 | **peeked** `D` — `pos()`, not `lastPos()` |

Columns count **code points**, so a surrogate pair advances the column by one. Iterate with `codePointAt`, never by UTF-16 index.

---

## Task 1: The legacy semicolon-less spelling rule

`gen-entities.mjs` caches all 2231 keys from `entities.json` and keeps only the 2125 semicolon-terminated ones, because CommonMark recognises only that spelling. HTML5 matches both.

**Measured against the cache before writing this, and it is not what the issue text suggests:** every one of the 106 legacy names is *also* a semicolon-terminated key, and the two spellings carry byte-identical values in all 106 cases. So the legacy set is **not a wider name table** — `namedEntity` already resolves every name HTML5 can match. It is the set of names *permitted to match without a trailing semicolon*.

The addition is therefore a **predicate**, not a second value map. A second map would duplicate 106 entries to say nothing and would hide the actual rule behind a lookup that appears to succeed for every name.

Verify the premise yourself before starting — one command, and if it prints anything but `0` and `0` the rest of this task is wrong:

```bash
node -e "
const r=JSON.parse(require('fs').readFileSync('unicode/entities.json','utf8'));
const semi=new Set(),leg=new Set();
for(const k of Object.keys(r)){ k.endsWith(';') ? semi.add(k.slice(1,-1)) : leg.add(k.slice(1)); }
console.log('legacy names absent from the semicolon map:', [...leg].filter(n=>!semi.has(n)).length);
console.log('value mismatches:', [...leg].filter(n=>r['&'+n].characters!==r['&'+n+';'].characters).length);
"
```

**Files:**
- Modify: `scripts/gen-entities.mjs`
- Modify (regenerated): `src/mdentity.ts`
- Test: `test/htmlentity.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `allowsMissingSemicolon(name: string): boolean` — true for the 106 names HTML5 matches without a trailing `;`. `name` carries no `&` and no `;`.
  - `MAX_ENTITY_NAME: number` — the longest key's length (**31**, `CounterClockwiseContourIntegral`), bounding the longest-match scan.
  - `namedEntity(name: string): string | undefined` — **unchanged**, and now the only value accessor either consumer needs.

- [ ] **Step 1: Write the failing test**

Create `test/htmlentity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { namedEntity, allowsMissingSemicolon, MAX_ENTITY_NAME } from '../src/mdentity.js';

describe('the HTML5 named character reference table', () => {
  it('resolves every name through the one value accessor', () => {
    expect(namedEntity('copy')).toBe('\u00a9');
    // A legacy name is ALSO a semicolon key, with the same value \u2014 the legacy
    // set is a spelling permission, not a wider name table.
    expect(namedEntity('COPY')).toBe('\u00a9');
  });

  it('permits the 106 legacy names to match without a semicolon', () => {
    expect(allowsMissingSemicolon('COPY')).toBe(true);
    expect(allowsMissingSemicolon('AMP')).toBe(true);
    expect(allowsMissingSemicolon('copy')).toBe(true);
  });

  it('refuses the permission to a name that only exists with a semicolon', () => {
    expect(namedEntity('notin')).toBe('\u2209');
    expect(allowsMissingSemicolon('notin')).toBe(false);
    expect(allowsMissingSemicolon('NotEqualTilde')).toBe(false);
  });

  it('bounds the longest-match scan', () => {
    // 'CounterClockwiseContourIntegral' is the longest key in entities.json.
    expect(MAX_ENTITY_NAME).toBe(31);
    expect(namedEntity('CounterClockwiseContourIntegral')).toBe('\u2233');
  });

  it('probes with hasOwnProperty, so a document cannot name a prototype key', () => {
    expect(namedEntity('constructor')).toBeUndefined();
    expect(allowsMissingSemicolon('constructor')).toBe(false);
    expect(allowsMissingSemicolon('__proto__')).toBe(false);
  });

  it('resolves a multi-code-point replacement', () => {
    expect(namedEntity('NotEqualTilde')).toBe('\u2242\u0338');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmlentity.test.ts`
Expected: FAIL — `allowsMissingSemicolon` and `MAX_ENTITY_NAME` are not exported from `src/mdentity.ts`.

- [ ] **Step 3: Teach the generator to emit the legacy name set**

In `scripts/gen-entities.mjs`, replace the single-table build and the `out` template. The existing semicolon loop and its `names.length < 2000` guard stay exactly as they are; a second loop and a second guard join them:

```js
  // CommonMark recognises only the semicolon-terminated spelling. entities.json
  // keys look like "&copy;" and "&copy"; keep the former, strip the framing.
  const table = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!key.startsWith('&') || !key.endsWith(';')) continue;
    table[key.slice(1, -1)] = val.characters;
  }
  const names = Object.keys(table).sort();
  if (names.length < 2000) throw new Error(`only ${names.length} entities — entities.json looks wrong`);
  const sorted = {};
  for (const n of names) sorted[n] = table[n];

  // HTML5's named character reference state also matches the legacy
  // semicolon-less spellings, which CommonMark deliberately does not. Every
  // legacy name is also a semicolon key with the same value, so what is emitted
  // is the NAME SET — a spelling permission, not a second value table. The
  // guard asserts that, because a legacy name carrying a different value would
  // make the whole design wrong rather than merely incomplete.
  const legacyNames = [];
  for (const key of Object.keys(raw)) {
    if (!key.startsWith('&') || key.endsWith(';')) continue;
    const n = key.slice(1);
    if (table[n] === undefined) throw new Error(`legacy &${n} has no &${n}; counterpart`);
    if (table[n] !== raw[key].characters) throw new Error(`&${n} and &${n}; differ`);
    legacyNames.push(n);
  }
  legacyNames.sort();
  if (legacyNames.length < 100) throw new Error(`only ${legacyNames.length} legacy entities — entities.json looks wrong`);

  const maxName = Math.max(...names.map((n) => n.length));
```

Then the emitted file gains the second map and two exports. Append to the `out` template, after the existing `namedEntity`:

```js
  const out = `// GENERATED by scripts/gen-entities.mjs from ${SOURCE} — do not edit.
// The ${names.length} HTML5 named character references, and the ${legacyNames.length} of them
// that may also be spelled without the trailing semicolon.
//
// CommonMark 0.31.2 recognises only the semicolon spelling: "&copy;" resolves,
// "&copy" stays literal text. HTML5 matches both — but every legacy name is
// also a semicolon key with an identical value, so the difference is a
// SPELLING PERMISSION rather than a second table. One value accessor, one
// predicate; the two readings cannot drift because there is only one table.
/* eslint-disable */

const ENTITIES: Record<string, string> = ${JSON.stringify(sorted)};

const LEGACY: Record<string, 1> = ${JSON.stringify(Object.fromEntries(legacyNames.map((n) => [n, 1])))};

/** The replacement for a named entity, given the name alone — no '&', no ';'.
 *  Probed with hasOwnProperty rather than \\\`in\\\`, because the name comes out of a
 *  document: '&constructor;' would otherwise resolve to a function. */
export function namedEntity(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : undefined;
}

/** Whether HTML5 matches this name without a trailing ';' (§13.2.5.73). The 106
 *  names this is true of are a historical set, not a rule — '&COPY' resolves and
 *  '&notin' does not. CommonMark must not read this; it requires the semicolon
 *  everywhere. */
export function allowsMissingSemicolon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY, name);
}

/** The longest key in the table, which bounds the longest-match scan in
 *  htmlcharref.ts. */
export const MAX_ENTITY_NAME = ${maxName};
`;
```

Also update the trailing log line:

```js
  process.stdout.write(`src/mdentity.ts: ${names.length} entities, ${legacyNames.length} legacy\n`);
```

- [ ] **Step 4: Regenerate and verify**

Run: `npm run gen:entities`
Expected: `src/mdentity.ts: 2125 entities, 106 legacy`. The cache at `unicode/entities.json` already exists, so this makes no network call.

Run: `npx vitest run test/htmlentity.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm CommonMark did not move**

Run: `npx vitest run test/commonmark-spec.test.ts test/markdown-ast.test.ts`
Expected: PASS — 652 cases, unchanged.

Then confirm the semicolon map is byte-identical rather than merely behaving:

Run: `git diff src/mdentity.ts | grep -c '^[-+].*ENTITIES: Record'`
Expected: `2` — the const line moved only because the header comment above it changed. If the diff shows any change *inside* the `ENTITIES` object literal, stop: the semicolon table must be untouched.

- [ ] **Step 6: Prove the fence load-bearing**

Temporarily change `allowsMissingSemicolon` to `return false;` and run `npx vitest run test/htmlentity.test.ts`.
Expected: FAIL on the permission case alone; the value-accessor cases stay green. Revert.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck && npm test
git add scripts/gen-entities.mjs src/mdentity.ts test/htmlentity.test.ts
git commit -m "feat(zch2.1.1): carry the 106 legacy entity keys HTML5 needs

gen-entities.mjs already caches all 2231 keys from entities.json and keeps
only the 2125 semicolon-terminated ones, because CommonMark recognises no
other spelling. HTML5's named character reference state matches both, and in
an attribute the difference is decisive: ?a=1&copy=2 keeps its literal &copy
while the same bytes in text resolve to a copyright sign.

One table with two accessors rather than a second table, so the two readings
cannot drift. namedEntity and the ENTITIES literal are untouched; the 652
CommonMark cases are the fence."
```

---

## Task 2: Vendor the suite and build its loader

The loader is built and tested **before** the tokenizer exists, against hand-built token streams. That is deliberate: the suite's three wrinkles (`doubleEscaped`, `initialStates`, `lastStartTag`) are its own logic, and a loader validated only through a tokenizer cannot tell a loader bug from a tokenizer bug.

**Files:**
- Vendor: `test/fixtures/html5lib/tokenizer/*.test` (14 files)
- Create: `test/fixtures/html5lib/PROVENANCE.md`
- Create: `test/helpers/html5lib-tokenizer.ts`
- Test: `test/html5lib-suite.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface Html5libCase {
    file: string;            // 'test1.test'
    description: string;
    input: string;           // doubleEscaped already resolved
    initialState: string;    // one of the six state names; 'Data state' when unstated
    lastStartTag?: string;
    output: unknown[][];     // ['Character','x'] | ['StartTag',name,attrs,selfClosing?] | ...
    errors: { code: string; line: number; col: number }[];
  }
  export function loadTokenizerCases(files?: string[]): Html5libCase[];
  export const SUITE_FILES: string[];      // the 14 declared, in a fixed order
  export const EXCLUDED: { file: string; reason: string }[];
  export function unescapeDoubled(s: string): string;
  export function concatCharacterTokens(out: unknown[][]): unknown[][];
  ```

- [ ] **Step 1: Vendor the fixtures**

```bash
mkdir -p test/fixtures/html5lib/tokenizer
for f in contentModelFlags domjs entities escapeFlag namedEntities numericEntities \
         pendingSpecChanges test1 test2 test3 test4 unicodeChars \
         unicodeCharsProblematic xmlViolation; do
  curl -fsSL "https://raw.githubusercontent.com/html5lib/html5lib-tests/224991ec10db04f056a89eed8b0bd8695fd2950e/tokenizer/$f.test" \
    -o "test/fixtures/html5lib/tokenizer/$f.test"
done
```

Verify all 14 landed and record their hashes for the provenance table:

```bash
cd test/fixtures/html5lib/tokenizer && sha256sum *.test | sort && wc -c *.test | sort -n
```

Expected byte counts, as a sanity check against a truncated download: `pendingSpecChanges.test` 162, `escapeFlag.test` 1378, `unicodeCharsProblematic.test` 1107, `contentModelFlags.test` 3055, `xmlViolation.test` 442, `test1.test` 10006, `test2.test` 8647, `test4.test` 16339, `domjs.test` 13430, `entities.test` 19147, `unicodeChars.test` 43771, `numericEntities.test` 49842, `test3.test` 349970, `namedEntities.test` 1128317.

- [ ] **Step 2: Write the failing test**

Create `test/html5lib-suite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  loadTokenizerCases, SUITE_FILES, EXCLUDED, unescapeDoubled, concatCharacterTokens,
} from './helpers/html5lib-tokenizer.js';

describe('the html5lib tokenizer suite loader', () => {
  it('declares 14 files and excludes exactly one, with a reason', () => {
    expect(SUITE_FILES.length).toBe(14);
    expect(EXCLUDED.map((e) => e.file)).toEqual(['xmlViolation.test']);
    expect(EXCLUDED[0].reason).toMatch(/XML/);
  });

  it('loads every non-excluded file', () => {
    const cases = loadTokenizerCases();
    expect(cases.length).toBeGreaterThan(1000);
    expect(new Set(cases.map((c) => c.file)).size).toBe(13);
    expect(cases.some((c) => c.file === 'xmlViolation.test')).toBe(false);
  });

  // xmlViolation.test is excluded STRUCTURALLY: its root key is
  // "xmlViolationTests", not "tests". A name-based skip would silently accept
  // a file whose contents changed shape.
  it('excludes by root key, not by file name', () => {
    expect(() => loadTokenizerCases(['xmlViolation.test'])).toThrow(/xmlViolationTests/);
  });

  it('rejects a file that is not in the declared list', () => {
    expect(() => loadTokenizerCases(['nope.test'])).toThrow(/not a declared/);
  });

  it('resolves doubleEscaped inputs and outputs', () => {
    expect(unescapeDoubled('\\u0000')).toBe('\u0000');
    expect(unescapeDoubled('a\\uFFFDb')).toBe('a\uFFFDb');
    expect(unescapeDoubled('plain')).toBe('plain');
    const nul = loadTokenizerCases(['domjs.test']).find((c) => c.description === 'Raw NUL replacement');
    expect(nul?.input).toBe('\u0000');
    expect(nul?.output[0]).toEqual(['Character', '\uFFFD']);
  });

  // One input with several initialStates is several cases, or a state that
  // fails is hidden by a sibling that passes.
  it('expands initialStates into one case each', () => {
    const cases = loadTokenizerCases(['contentModelFlags.test']);
    const rc = cases.filter((c) => c.description === 'End tag closing RCDATA or RAWTEXT');
    expect(rc.map((c) => c.initialState).sort()).toEqual(['RAWTEXT state', 'RCDATA state']);
    expect(rc.every((c) => c.lastStartTag === 'xmp')).toBe(true);
  });

  it('defaults an unstated initial state to Data', () => {
    const c = loadTokenizerCases(['test1.test']).find((x) => x.description === 'Single Start Tag');
    expect(c?.initialState).toBe('Data state');
  });

  it('defaults a stated-nowhere errors array to empty', () => {
    const c = loadTokenizerCases(['test1.test']).find((x) => x.description === 'Single Start Tag');
    expect(c?.errors).toEqual([]);
  });

  it('concatenates consecutive character tokens, which is what expectations assume', () => {
    expect(concatCharacterTokens([
      ['Character', 'a'], ['Character', 'b'], ['EndTag', 'p'], ['Character', 'c'],
    ])).toEqual([['Character', 'ab'], ['EndTag', 'p'], ['Character', 'c']]);
    expect(concatCharacterTokens([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/html5lib-suite.test.ts`
Expected: FAIL — `./helpers/html5lib-tokenizer.js` does not exist.

- [ ] **Step 4: Write the loader**

Create `test/helpers/html5lib-tokenizer.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'html5lib', 'tokenizer');

/** The 14 files vendored from html5lib-tests, in a fixed order so a run's
 *  output is stable. */
export const SUITE_FILES = [
  'contentModelFlags.test', 'domjs.test', 'entities.test', 'escapeFlag.test',
  'namedEntities.test', 'numericEntities.test', 'pendingSpecChanges.test',
  'test1.test', 'test2.test', 'test3.test', 'test4.test',
  'unicodeChars.test', 'unicodeCharsProblematic.test', 'xmlViolation.test',
];

/** Excluded files, with a reason each — never a silent skip, the rule
 *  test/commonmark-spec.test.ts's five-entry GFM divergence list already sets. */
export const EXCLUDED = [
  {
    file: 'xmlViolation.test',
    reason:
      'Encodes an XML-compatibility output mode this library does not implement — ' +
      'U+FFFF folded to U+FFFD, FF treated as a space, "--" rewritten inside a ' +
      'comment. Its root key is "xmlViolationTests" rather than "tests", so the ' +
      'exclusion is structural rather than a name match.',
  },
];

export interface Html5libCase {
  file: string;
  description: string;
  input: string;
  initialState: string;
  lastStartTag?: string;
  output: unknown[][];
  errors: { code: string; line: number; col: number }[];
}

/** Resolve one level of \\uXXXX escaping. The suite double-escapes a case whose
 *  input or expectation holds a character JSON cannot carry legibly. */
export function unescapeDoubled(s: string): string {
  return s.replace(/\\u([0-9A-Fa-f]{4})/g, (_m, h: string) =>
    String.fromCharCode(parseInt(h, 16)));
}

/** Fold consecutive Character tokens into one. The suite's expectations assume
 *  it; a tokenizer legitimately emits them one code point at a time. */
export function concatCharacterTokens(out: unknown[][]): unknown[][] {
  const merged: unknown[][] = [];
  for (const t of out) {
    const prev = merged[merged.length - 1];
    if (t[0] === 'Character' && prev !== undefined && prev[0] === 'Character') {
      prev[1] = String(prev[1]) + String(t[1]);
      continue;
    }
    merged.push([...t]);
  }
  return merged;
}

interface RawCase {
  description: string;
  input: string;
  output: unknown[][];
  initialStates?: string[];
  lastStartTag?: string;
  doubleEscaped?: boolean;
  errors?: { code: string; line: number; col: number }[];
}

/** Load the suite. Defaults to every declared file that is not excluded. */
export function loadTokenizerCases(files?: string[]): Html5libCase[] {
  const want = files ?? SUITE_FILES.filter((f) => !EXCLUDED.some((e) => e.file === f));
  const cases: Html5libCase[] = [];
  for (const file of want) {
    if (!SUITE_FILES.includes(file)) throw new Error(`${file} is not a declared suite file`);
    const doc = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Record<string, RawCase[]>;
    const raw = doc['tests'];
    if (raw === undefined) {
      throw new Error(`${file} has no "tests" key (root keys: ${Object.keys(doc).join(', ')})`);
    }
    for (const c of raw) {
      const de = c.doubleEscaped === true;
      const input = de ? unescapeDoubled(c.input) : c.input;
      const output = concatCharacterTokens(
        c.output.map((t) => t.map((v) => (de && typeof v === 'string' ? unescapeDoubled(v) : v))),
      );
      for (const initialState of c.initialStates ?? ['Data state']) {
        cases.push({
          file,
          description: c.description,
          input,
          initialState,
          lastStartTag: c.lastStartTag,
          output,
          errors: c.errors ?? [],
        });
      }
    }
  }
  return cases;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/html5lib-suite.test.ts`
Expected: PASS, all 10 assertions.

- [ ] **Step 6: Write the provenance document**

Create `test/fixtures/html5lib/PROVENANCE.md`. Fill the hash column from Step 1's `sha256sum` output — do not invent them:

```markdown
# html5lib-tests tokenizer suite — provenance

The official conformance suite for the WHATWG HTML tokenizer, here to validate
`src/htmltoken.ts` against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-26-html5-tokenizer-design.md`.

**Source:** <https://github.com/html5lib/html5lib-tests>, the shared test suite
maintained by the html5lib project and used by browser engines and independent
implementations alike (MIT). Downloaded verbatim, not regenerated.

**Commit:** `224991ec10db04f056a89eed8b0bd8695fd2950e` (2026-06-26).

### Command

(the loop from Task 1 Step 1 of docs/superpowers/plans/2026-08-26-html5-tokenizer.md)

| File | Bytes | SHA-256 |
|---|---|---|
| ... | ... | ... |

## Shape

Each file is a JSON object with a `tests` array. A case carries `description`,
`input`, and `output` — a list of tokens spelled `["Character", data]`,
`["Comment", data]`, `["StartTag", name, attrs]` (a fourth `true` for
self-closing), `["EndTag", name]`, or
`["DOCTYPE", name, publicId, systemId, correctness]`, where `correctness` is the
negation of the force-quirks flag. Optional keys: `errors` (each `code`, `line`,
`col`), `initialStates` (up to six named states, expanded here into one case
each), `lastStartTag` (the appropriate end tag for a case starting inside
RCDATA, RAWTEXT or script data), and `doubleEscaped` (input and expectations
carry literal `\uXXXX` sequences).

Consecutive `Character` tokens are concatenated in the expectations, so the
runner concatenates what the tokenizer emits before comparing.

## What it covers

Every tokenizer state, both character-reference forms in both the text and
attribute return states, the full parse-error vocabulary with positions, and the
alternate content models. `namedEntities.test` alone is 1.1 MB because it
exercises all 2231 named references in both spellings.

## What it does not cover

Tree construction, foreign content and fragment parsing — those are
`html5lib-tests/tree-construction`, vendored by `zch2.1.2` and `zch2.1.3`.
Character-encoding detection from bytes is not covered by any tokenizer case and
is out of scope here (`zch2.8`).

## Exclusions

| File | Reason |
|---|---|
| `xmlViolation.test` | Encodes an XML-compatibility output mode this library does not implement: U+FFFF folded to U+FFFD, FF treated as a space, `--` rewritten inside a comment. Excluded **structurally** — its root key is `xmlViolationTests` rather than `tests`, so the loader throws rather than matching on a file name. |

## Mutation results

(Filled in by Task 8. A mutation that reddens nothing means the suite does not
cover that rule, and is recorded here rather than left to be discovered.)
```

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck && npm test
git add test/fixtures/html5lib test/helpers/html5lib-tokenizer.ts test/html5lib-suite.test.ts
git commit -m "test(zch2.1.1): vendor the html5lib tokenizer suite and its loader

Built and tested before the tokenizer exists, against hand-built token
streams: the suite's three wrinkles — doubleEscaped inputs, initialStates
expansion, lastStartTag — are its own logic, and a loader validated only
through a tokenizer cannot tell a loader bug from a tokenizer bug.

xmlViolation.test is excluded structurally, by its xmlViolationTests root
key rather than by name, with the reason recorded in PROVENANCE.md."
```

---

## Task 3: Tokenizer skeleton — preprocessing, cursor, tokens, Data state

**Files:**
- Create: `src/htmltoken.ts`
- Test: `test/htmltoken.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface HtmlParseError { code: string; line: number; col: number; }
  export type HtmlToken =
    | { kind: 'doctype'; name?: string; publicId?: string; systemId?: string; forceQuirks: boolean }
    | { kind: 'startTag'; name: string; attrs: Map<string, string>; selfClosing: boolean }
    | { kind: 'endTag'; name: string; attrs: Map<string, string>; selfClosing: boolean }
    | { kind: 'comment'; data: string }
    | { kind: 'character'; data: string }
    | { kind: 'eof' };
  export enum TokenizerState { Data, RCDATA, RAWTEXT, ScriptData, PLAINTEXT, /* …the rest, added by later tasks */ }
  export function preprocess(src: string): string;
  export class HtmlTokenizer {
    constructor(src: string);
    readonly errors: HtmlParseError[];
    next(): HtmlToken;
    setState(s: TokenizerState): void;
    setLastStartTag(name: string): void;
  }
  ```
  `endTag` carries `attrs` and `selfClosing` because the spec's tag states are shared between the two and an end tag with attributes is a parse error whose *token* still drops them — the drop happens at emit, and `zch2.1.2` never sees them.

- [ ] **Step 1: Write the failing test**

Create `test/htmltoken.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { HtmlTokenizer, TokenizerState, preprocess } from '../src/htmltoken.js';

/** Drain a tokenizer to EOF. */
function drain(src: string): { tokens: unknown[]; errors: unknown[] } {
  const t = new HtmlTokenizer(src);
  const tokens = [];
  for (;;) { const tok = t.next(); if (tok.kind === 'eof') break; tokens.push(tok); }
  return { tokens, errors: t.errors };
}

function text(src: string): string {
  return drain(src).tokens.filter((t: any) => t.kind === 'character').map((t: any) => t.data).join('');
}

describe('preprocessing', () => {
  // Runs BEFORE tokenizing, and is where the line/col counter is seeded. Wrong,
  // every position after the first CRLF is off while tokens stay perfect.
  it('collapses CRLF and a lone CR to LF', () => {
    expect(preprocess('a\r\nb')).toBe('a\nb');
    expect(preprocess('a\rb')).toBe('a\nb');
    expect(preprocess('a\r\r\nb')).toBe('a\n\nb');
    expect(preprocess('a\nb')).toBe('a\nb');
  });
});

describe('the tokenizer skeleton', () => {
  it('emits characters and then EOF, and EOF is idempotent', () => {
    const t = new HtmlTokenizer('hi');
    expect(t.next()).toEqual({ kind: 'character', data: 'h' });
    expect(t.next()).toEqual({ kind: 'character', data: 'i' });
    expect(t.next()).toEqual({ kind: 'eof' });
    expect(t.next()).toEqual({ kind: 'eof' });
  });

  it('counts columns in code points, not UTF-16 units', () => {
    // U+1F600 is one code point and two UTF-16 units. The NUL after it must be
    // reported at column 2, not column 3.
    const { errors } = drain('\u{1F600}\u0000');
    expect(errors).toEqual([{ code: 'unexpected-null-character', line: 1, col: 2 }]);
  });

  it('counts lines from the preprocessed source', () => {
    const { errors } = drain('a\r\nb\u0000');
    expect(errors).toEqual([{ code: 'unexpected-null-character', line: 2, col: 2 }]);
  });

  it('passes NUL through in the Data state, with an error', () => {
    expect(text('a\u0000b')).toBe('a\u0000b');
  });

  it('never throws, on any input', () => {
    for (const s of ['', '<', '</', '<!', '<!-', '&', '&#', '\u0000', '<\u{1F600}']) {
      expect(() => drain(s)).not.toThrow();
    }
  });

  it('takes PLAINTEXT from setState and never leaves it', () => {
    const t = new HtmlTokenizer('<p>&amp;');
    t.setState(TokenizerState.PLAINTEXT);
    let out = '';
    for (;;) { const tok = t.next(); if (tok.kind === 'eof') break; out += (tok as any).data; }
    expect(out).toBe('<p>&amp;');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: FAIL — `../src/htmltoken.js` does not exist.

- [ ] **Step 3: Write the skeleton**

Create `src/htmltoken.ts`. The cursor and the dispatch loop are the whole of this task; later tasks add `case` branches and nothing else.

```ts
/** The WHATWG HTML tokenizer (HTML Standard §13.2.5), as a literal
 *  transcription: one branch per spec state, named as the spec names it.
 *
 *  Invariant: this module NEVER throws. Every string is a valid HTML document —
 *  the spec mandates a recovery for every parse error by construction, so there
 *  is no input for which refusing is the defined answer. This is markdown.ts's
 *  rule and the exact opposite of parseXml one directory away, which throws
 *  PdfParseError. Errors are reported values on `errors`, never control flow.
 *
 *  Invariant: a pure leaf. No Document, no PDF object, no node: import. It takes
 *  a string; character-encoding detection from bytes is zch2.8. */

export interface HtmlParseError {
  /** The spec's own kebab-case name, verbatim: 'eof-in-tag'. Never paraphrased
   *  — this is what makes a failing html5lib case name its own spec section. */
  code: string;
  line: number;
  col: number;
}

export type HtmlToken =
  | { kind: 'doctype'; name?: string; publicId?: string; systemId?: string; forceQuirks: boolean }
  | { kind: 'startTag'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'endTag'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'comment'; data: string }
  | { kind: 'character'; data: string }
  | { kind: 'eof' };

export enum TokenizerState {
  Data,
  RCDATA,
  RAWTEXT,
  ScriptData,
  PLAINTEXT,
  // Later tasks add the remaining states here, in spec order.
}

/** §13.2.3.5 preprocessing: CRLF and a lone CR both become LF. Runs before
 *  tokenizing, and is where the line/col counter is seeded — so a tokenizer
 *  that skips it reports every position after the first CRLF one too far
 *  while emitting a perfect token stream. */
export function preprocess(src: string): string {
  return src.replace(/\r\n?/g, '\n');
}

const EOF = -1;

export class HtmlTokenizer {
  readonly errors: HtmlParseError[] = [];

  private readonly src: string;
  private i = 0;
  /** Position of the code point about to be consumed. */
  private line = 1;
  private col = 1;
  /** Position of the code point just consumed; where an error is reported. */
  private lastLine = 1;
  private lastCol = 1;
  private state: TokenizerState = TokenizerState.Data;
  private readonly queue: HtmlToken[] = [];
  private done = false;
  private lastStartTag = '';

  constructor(src: string) {
    this.src = preprocess(src);
  }

  setState(s: TokenizerState): void { this.state = s; }

  setLastStartTag(name: string): void { this.lastStartTag = name; }

  next(): HtmlToken {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) return queued;
      if (this.done) return { kind: 'eof' };
      this.step();
    }
  }

  // ---- cursor -------------------------------------------------------------

  /** Consume one code point, or EOF. Advances both positions. */
  private consume(): number {
    if (this.i >= this.src.length) {
      this.lastLine = this.line;
      this.lastCol = this.col;
      if (!this.atEofPos) { this.atEofPos = true; this.lastCol = this.col; }
      return EOF;
    }
    const cp = this.src.codePointAt(this.i) as number;
    this.i += cp > 0xffff ? 2 : 1;
    this.lastLine = this.line;
    this.lastCol = this.col;
    if (cp === 0x0a) { this.line++; this.col = 1; } else { this.col++; }
    return cp;
  }
  private atEofPos = false;

  /** Put the current code point back, so the next consume returns it again. */
  private reconsume(cp: number): void {
    if (cp === EOF) return;
    this.i -= cp > 0xffff ? 2 : 1;
    this.line = this.lastLine;
    this.col = this.lastCol;
  }

  /** Report at the code point just consumed — the convention every vendored
   *  expectation follows. The one peek-based site (markup declaration open)
   *  passes an explicit position instead. */
  private error(code: string, at?: { line: number; col: number }): void {
    this.errors.push({ code, line: at?.line ?? this.lastLine, col: at?.col ?? this.lastCol });
  }

  private emit(t: HtmlToken): void {
    if (t.kind === 'startTag') this.lastStartTag = t.name;
    this.queue.push(t);
  }

  private emitEof(): void { this.done = true; this.queue.push({ kind: 'eof' }); }

  private char(cp: number): void { this.emit({ kind: 'character', data: String.fromCodePoint(cp) }); }

  // ---- states -------------------------------------------------------------

  private step(): void {
    switch (this.state) {
      case TokenizerState.Data: return this.dataState();
      case TokenizerState.PLAINTEXT: return this.plaintextState();
      // Later tasks add their states here.
      default: return this.dataState();
    }
  }

  /** §13.2.5.1 Data state. `&` and `<` are wired by Tasks 6 and 4. */
  private dataState(): void {
    const cp = this.consume();
    if (cp === EOF) return this.emitEof();
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(cp); }
    return this.char(cp);
  }

  /** §13.2.5.7 PLAINTEXT state. There is no way out of it. */
  private plaintextState(): void {
    const cp = this.consume();
    if (cp === EOF) return this.emitEof();
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(0xfffd); }
    return this.char(cp);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: PASS, all 8 assertions.

- [ ] **Step 5: Prove the position rules load-bearing**

Change `consume` to advance by `1` unconditionally instead of `cp > 0xffff ? 2 : 1`, and run the file.
Expected: FAIL on "counts columns in code points" alone. Revert.

Change `preprocess` to `return src;` and run the file.
Expected: FAIL on the CRLF cases and on "counts lines from the preprocessed source". Revert.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck && npm test
git add src/htmltoken.ts test/htmltoken.test.ts
git commit -m "feat(zch2.1.1): tokenizer skeleton — preprocessing, cursor, Data state

The cursor carries two positions, which is what the vendored expectations
need: an error reports at the code point just CONSUMED, except at the one
peek-based site (markup declaration open), where <!DOC> is expected to fire
incorrectly-opened-comment at the D it only looked at.

Columns count code points rather than UTF-16 units, so an astral character
advances by one."
```

---

## Task 4: Tag states

**Files:**
- Modify: `src/htmltoken.ts`
- Test: `test/htmltoken.test.ts`

**Interfaces:**
- Consumes: `HtmlTokenizer`, `TokenizerState`, the cursor, `error`, `emit` (Task 3).
- Produces: nothing new in the public shape. `TokenizerState` gains the members below.

Implement §13.2.5.6–§13.2.5.14 and §13.2.5.32–§13.2.5.41 in full — every one of these, added to `TokenizerState` in spec order and to `step()`'s switch:

`TagOpen`, `EndTagOpen`, `TagName`, `BeforeAttributeName`, `AttributeName`, `AfterAttributeName`, `BeforeAttributeValue`, `AttributeValueDoubleQuoted`, `AttributeValueSingleQuoted`, `AttributeValueUnquoted`, `AfterAttributeValueQuoted`, `SelfClosingStartTag`, `BogusComment`.

Error codes this task must emit: `eof-before-tag-name`, `invalid-first-character-of-tag-name`, `missing-end-tag-name`, `eof-in-tag`, `unexpected-null-character`, `unexpected-equals-sign-before-attribute-name`, `unexpected-character-in-attribute-name`, `missing-attribute-value`, `unexpected-character-in-unquoted-attribute-value`, `missing-whitespace-between-attributes`, `unexpected-solidus-in-tag`, `duplicate-attribute`, `end-tag-with-attributes`, `end-tag-with-trailing-solidus`.

Three rules that are silent when wrong:

- **A duplicate attribute keeps the FIRST value** and errors — `<h a='b' a='d'>` is `{a: 'b'}`. Keeping the last is the natural `Map.set` behaviour and is wrong. The check fires when the name is *finished*, not when the value is.
- **`</>` emits no token at all** — not an end tag, not characters. It errors `missing-end-tag-name` and returns to Data.
- **`<>` emits the two characters `<>`** — `invalid-first-character-of-tag-name` at the `>`, then reconsume in Data.

- [ ] **Step 1: Write the failing test**

Append to `test/htmltoken.test.ts`:

```ts
describe('tag states', () => {
  it('tokenizes a start tag with quoted, unquoted and valueless attributes', () => {
    const { tokens } = drain(`<h a='b' c="d" e=f g>`);
    expect(tokens).toEqual([{
      kind: 'startTag', name: 'h', selfClosing: false,
      attrs: new Map([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', '']]),
    }]);
  });

  it('lowercases a tag name and an attribute name', () => {
    const { tokens } = drain('<DIV CLASS=x>');
    expect((tokens[0] as any).name).toBe('div');
    expect([...(tokens[0] as any).attrs.keys()]).toEqual(['class']);
  });

  it('marks a self-closing tag', () => {
    expect((drain('<br/>').tokens[0] as any).selfClosing).toBe(true);
  });

  // First wins. Map.set semantics keep the last, which is the natural mistake.
  it('keeps the first of a duplicate attribute and errors at the name', () => {
    const { tokens, errors } = drain(`<h a='b' a='d'>`);
    expect((tokens[0] as any).attrs).toEqual(new Map([['a', 'b']]));
    expect(errors).toEqual([{ code: 'duplicate-attribute', line: 1, col: 11 }]);
  });

  it('emits no token at all for </>', () => {
    const { tokens, errors } = drain('</>');
    expect(tokens).toEqual([]);
    expect(errors).toEqual([{ code: 'missing-end-tag-name', line: 1, col: 3 }]);
  });

  it('emits the literal characters for <>', () => {
    expect(text('<>')).toBe('<>');
    expect(drain('<>').errors).toEqual([
      { code: 'invalid-first-character-of-tag-name', line: 1, col: 2 },
    ]);
  });

  it('drops an end tag\u2019s attributes but keeps the token', () => {
    const { tokens, errors } = drain(`<h></h a='b'>`);
    expect(tokens[1]).toEqual({ kind: 'endTag', name: 'h', attrs: new Map(), selfClosing: false });
    expect(errors).toEqual([{ code: 'end-tag-with-attributes', line: 1, col: 13 }]);
  });

  it('reports a missing space between attributes at the offending character', () => {
    expect(drain(`<h a='b'c='d'>`).errors).toEqual([
      { code: 'missing-whitespace-between-attributes', line: 1, col: 9 },
    ]);
  });

  it('treats an unterminated tag as EOF in tag, emitting nothing', () => {
    const { tokens, errors } = drain('<div a=b');
    expect(tokens).toEqual([]);
    expect(errors).toEqual([{ code: 'eof-in-tag', line: 1, col: 9 }]);
  });

  it('turns <? into a bogus comment', () => {
    const { tokens, errors } = drain('<?php ?>');
    expect(tokens).toEqual([{ kind: 'comment', data: '?php ?' }]);
    expect(errors[0]).toEqual({
      code: 'unexpected-question-mark-instead-of-tag-name', line: 1, col: 2,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: FAIL on all 10 new assertions; the Task 3 assertions stay green.

- [ ] **Step 3: Implement the states**

Add to `TokenizerState` and `step()`, then write each state as a method transcribed from its spec section. The tag-building scratch space goes on the instance:

```ts
  private tagName = '';
  private tagIsEnd = false;
  private tagSelfClosing = false;
  private tagAttrs = new Map<string, string>();
  private attrName = '';
  private attrValue = '';
  /** Set when the name just finished duplicates one already in tagAttrs; the
   *  value is then parsed and thrown away, so the FIRST occurrence wins. */
  private attrDuplicate = false;
  private commentData = '';

  private startTag(isEnd: boolean): void {
    this.tagName = '';
    this.tagIsEnd = isEnd;
    this.tagSelfClosing = false;
    this.tagAttrs = new Map();
  }

  /** Finish the pending attribute. Called before each new one and at emit. */
  private finishAttr(): void {
    if (this.attrName === '') return;
    if (this.tagAttrs.has(this.attrName)) this.error('duplicate-attribute');
    else this.tagAttrs.set(this.attrName, this.attrValue);
    this.attrName = '';
    this.attrValue = '';
  }

  private emitTag(): void {
    this.finishAttr();
    if (this.tagIsEnd) {
      if (this.tagAttrs.size > 0) this.error('end-tag-with-attributes');
      if (this.tagSelfClosing) this.error('end-tag-with-trailing-solidus');
      this.emit({ kind: 'endTag', name: this.tagName, attrs: new Map(), selfClosing: false });
      return;
    }
    this.emit({
      kind: 'startTag', name: this.tagName,
      attrs: this.tagAttrs, selfClosing: this.tagSelfClosing,
    });
  }
```

**Note on `duplicate-attribute`'s position:** `finishAttr` runs when the *next* thing after the value is seen, but the expected column for `<h a='b' a='d'>` is 11 — the closing `'` of `b`… no: it is the second `a`, at index 9, col 10, and the expectation says 11. Confirm against the vendored case and place the `error` call where it matches; the check belongs at the point the *name* is complete (entering `AfterAttributeName` or `BeforeAttributeValue`), not at emit. If the column is off by one, that is the `lastPos`/`pos` choice, not the logic.

Then wire `<` into the Data state:

```ts
    if (cp === 0x3c) { this.state = TokenizerState.TagOpen; return; }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: PASS, all 18 assertions.

- [ ] **Step 5: Prove the duplicate rule load-bearing**

Change `finishAttr` to always `this.tagAttrs.set(...)` and run the file.
Expected: FAIL on the duplicate-attribute case alone. Revert.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck && npm test
git add src/htmltoken.ts test/htmltoken.test.ts
git commit -m "feat(zch2.1.1): tag states

Three rules that produce plausible output when wrong, so each is asserted
alone: a duplicate attribute keeps the FIRST value where Map.set keeps the
last; </> emits no token at all rather than an empty end tag; and <> emits
the two literal characters."
```

---

## Task 5: Markup declaration — comments, DOCTYPE, CDATA

**Files:**
- Modify: `src/htmltoken.ts`
- Test: `test/htmltoken.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–4.
- Produces: the `doctype` and `comment` token kinds are now reachable. `TokenizerState` gains the members below.

Implement §13.2.5.42–§13.2.5.70 in full:

- **Markup declaration open** (§13.2.5.42) — the one peek-based site. It reports `incorrectly-opened-comment` at `pos()`, not `lastPos()`.
- **Comments:** `CommentStart`, `CommentStartDash`, `Comment`, `CommentLessThanSign`, `CommentLessThanSignBang`, `CommentLessThanSignBangDash`, `CommentLessThanSignBangDashDash`, `CommentEndDash`, `CommentEnd`, `CommentEndBang`.
- **DOCTYPE:** `Doctype`, `BeforeDoctypeName`, `DoctypeName`, `AfterDoctypeName`, `AfterDoctypePublicKeyword`, `BeforeDoctypePublicIdentifier`, `DoctypePublicIdentifierDoubleQuoted`, `DoctypePublicIdentifierSingleQuoted`, `AfterDoctypePublicIdentifier`, `BetweenDoctypePublicAndSystemIdentifiers`, `AfterDoctypeSystemKeyword`, `BeforeDoctypeSystemIdentifier`, `DoctypeSystemIdentifierDoubleQuoted`, `DoctypeSystemIdentifierSingleQuoted`, `AfterDoctypeSystemIdentifier`, `BogusDoctype`.
- **CDATA:** `CdataSection`, `CdataSectionBracket`, `CdataSectionEnd`. Outside foreign content the sequence `<![CDATA[` is a bogus comment with `cdata-in-html-content`; the CDATA states are reachable only from the `CDATA section state` initial state the suite names, and from `zch2.1.3`.

Error codes: `incorrectly-opened-comment`, `abrupt-closing-of-empty-comment`, `eof-in-comment`, `nested-comment`, `incorrectly-closed-comment`, `missing-whitespace-before-doctype-name`, `missing-doctype-name`, `eof-in-doctype`, `invalid-character-sequence-after-doctype-name`, `missing-whitespace-after-doctype-public-keyword`, `missing-doctype-public-identifier`, `missing-quote-before-doctype-public-identifier`, `abrupt-doctype-public-identifier`, `missing-whitespace-between-doctype-public-and-system-identifiers`, `missing-whitespace-after-doctype-system-keyword`, `missing-doctype-system-identifier`, `missing-quote-before-doctype-system-identifier`, `abrupt-doctype-system-identifier`, `unexpected-character-after-doctype-system-identifier`, `cdata-in-html-content`, `eof-in-cdata`, `unexpected-null-character`.

Two rules that are silent when wrong:

- **`correctness` in the expectations is the NEGATION of force-quirks.** `["DOCTYPE","html",null,null,true]` means *not* force-quirks. Reading it as the flag itself inverts every doctype case while the name, public and system identifiers all match.
- **A DOCTYPE name is lowercased; the public and system identifiers are NOT.** `<!DOCTYPE HtMl PUBLIC "FooBar">` is name `html`, publicId `FooBar`.

- [ ] **Step 1: Write the failing test**

Append to `test/htmltoken.test.ts`:

```ts
describe('comments', () => {
  it('tokenizes a plain comment', () => {
    expect(drain('<!--x-->').tokens).toEqual([{ kind: 'comment', data: 'x' }]);
  });

  it('reports an abruptly closed empty comment', () => {
    const { tokens, errors } = drain('<!-->');
    expect(tokens).toEqual([{ kind: 'comment', data: '' }]);
    expect(errors).toEqual([{ code: 'abrupt-closing-of-empty-comment', line: 1, col: 5 }]);
  });

  // The one peek-based error site: <!DOC> fires at the D it only looked at.
  it('reports an incorrectly opened comment at the peeked character', () => {
    const { tokens, errors } = drain('<!DOC>');
    expect(tokens).toEqual([{ kind: 'comment', data: 'DOC' }]);
    expect(errors).toEqual([{ code: 'incorrectly-opened-comment', line: 1, col: 3 }]);
  });

  it('keeps a double hyphen inside a comment body', () => {
    expect(drain('<!---- >').tokens).toEqual([{ kind: 'comment', data: '-- >' }]);
    expect(drain('<!---- >').errors).toEqual([{ code: 'eof-in-comment', line: 1, col: 9 }]);
  });

  it('reports a nested comment', () => {
    expect(drain('<!--<!--x-->').errors[0].code).toBe('nested-comment');
  });
});

describe('DOCTYPE', () => {
  it('lowercases the name and clears force-quirks', () => {
    expect(drain('<!DOCTYPE HtMl>').tokens).toEqual([{
      kind: 'doctype', name: 'html', publicId: undefined, systemId: undefined, forceQuirks: false,
    }]);
  });

  // correctness in the expectations is !forceQuirks. Reading it as the flag
  // itself inverts every doctype case while every identifier still matches.
  it('sets force-quirks on EOF in doctype', () => {
    const { tokens, errors } = drain('<!DOCTYPE HtMl');
    expect((tokens[0] as any).forceQuirks).toBe(true);
    expect(errors).toEqual([{ code: 'eof-in-doctype', line: 1, col: 15 }]);
  });

  it('keeps the case of a public and a system identifier', () => {
    const { tokens } = drain('<!DOCTYPE HtMl PUBLIC "FooBar" "BazQux">');
    expect(tokens[0]).toEqual({
      kind: 'doctype', name: 'html', publicId: 'FooBar', systemId: 'BazQux', forceQuirks: false,
    });
  });

  it('reports a missing name', () => {
    const { tokens, errors } = drain('<!DOCTYPE>');
    expect((tokens[0] as any).forceQuirks).toBe(true);
    expect(errors).toEqual([{ code: 'missing-doctype-name', line: 1, col: 10 }]);
  });
});

describe('CDATA outside foreign content', () => {
  it('becomes a bogus comment', () => {
    const { tokens, errors } = drain('<![CDATA[x]]>');
    expect(tokens).toEqual([{ kind: 'comment', data: '[CDATA[x]]' }]);
    expect(errors).toEqual([{ code: 'cdata-in-html-content', line: 1, col: 3 }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: FAIL on the 10 new assertions.

- [ ] **Step 3: Implement the states**

Transcribe each spec section. The doctype scratch space:

```ts
  private dtName: string | undefined;
  private dtPublicId: string | undefined;
  private dtSystemId: string | undefined;
  private dtForceQuirks = false;

  private emitDoctype(): void {
    this.emit({
      kind: 'doctype', name: this.dtName,
      publicId: this.dtPublicId, systemId: this.dtSystemId,
      forceQuirks: this.dtForceQuirks,
    });
  }
```

Markup declaration open, the peek-based site, in full — it is the only state that looks ahead rather than consuming:

```ts
  /** §13.2.5.42. The one state that peeks: it matches a multi-character
   *  sequence and errors at the character it did NOT consume. */
  private markupDeclarationOpenState(): void {
    const at = { line: this.line, col: this.col };
    if (this.src.startsWith('--', this.i)) {
      this.i += 2; this.col += 2;
      this.commentData = '';
      this.state = TokenizerState.CommentStart;
      return;
    }
    if (/^doctype/i.test(this.src.slice(this.i, this.i + 7))) {
      this.i += 7; this.col += 7;
      this.state = TokenizerState.Doctype;
      return;
    }
    if (this.src.startsWith('[CDATA[', this.i)) {
      // Outside foreign content this is a bogus comment. zch2.1.3 will pass an
      // adjusted-current-node test here and route to CdataSection instead.
      this.i += 7; this.col += 7;
      this.error('cdata-in-html-content', at);
      this.commentData = '[CDATA[';
      this.state = TokenizerState.BogusComment;
      return;
    }
    this.error('incorrectly-opened-comment', at);
    this.commentData = '';
    this.state = TokenizerState.BogusComment;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: PASS, all 28 assertions.

- [ ] **Step 5: Prove the force-quirks polarity load-bearing**

Invert `forceQuirks` at the emit site and run the file.
Expected: FAIL on both doctype force-quirks assertions and on nothing else. Revert.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck && npm test
git add src/htmltoken.ts test/htmltoken.test.ts
git commit -m "feat(zch2.1.1): comment, DOCTYPE and CDATA states

Markup declaration open is the one peek-based error site in the whole
tokenizer: <!DOC> must fire incorrectly-opened-comment at the D it only
looked at, which is why the cursor carries pos() beside lastPos().

The suite's DOCTYPE correctness field is the NEGATION of force-quirks;
reading it as the flag inverts every doctype case while every identifier
still matches, so the polarity is asserted alone."
```

---

## Task 6: Character references

**Files:**
- Create: `src/htmlcharref.ts`
- Modify: `src/htmltoken.ts`
- Test: `test/htmlcharref.test.ts`

**Interfaces:**
- Consumes: `namedEntity`, `allowsMissingSemicolon`, `MAX_ENTITY_NAME` (Task 1).
- Produces:
  ```ts
  export interface CharRefResult {
    /** The text to append — to the attribute value, or to emit as characters. */
    text: string;
    /** Index just past the reference; equals `i` when nothing was consumed. */
    end: number;
    errors: { code: string; offset: number }[];  // offset is a code-point count from `i`
  }
  /** Resolve the reference beginning at s[i] (which must be '&').
   *  `inAttribute` selects the historical rule that decides whether a
   *  semicolon-less match is replaced at all. */
  export function resolveCharRef(s: string, i: number, inAttribute: boolean): CharRefResult;
  export const C1_REPLACEMENTS: ReadonlyMap<number, number>;
  ```
  A sub-machine rather than states on the tokenizer: it is self-contained, it is the piece with the most arithmetic, and returning offsets lets the tokenizer convert them to line/col with the cursor it already has.

Three rules that are silent when wrong:

- **The attribute rule.** In an attribute, a match that does **not** end in `;` and is followed by `=` or an alphanumeric is **not** replaced — the whole `&`-run stays literal. `?a=1&copy=2` keeps `&copy`; the same bytes in text give `©`. This is the entire reason Task 1 exists.
- **The windows-1252 override.** Numeric references in 0x80–0x9F map through a 27-entry table. Skipped, they become C1 controls, which draw nothing and read as a missing glyph.
- **Longest match, not first match.** `&notit;` is `¬it;` — `not` matches, `notin` does not, and the scan must not stop at the first hit.

- [ ] **Step 1: Write the failing test**

Create `test/htmlcharref.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveCharRef, C1_REPLACEMENTS } from '../src/htmlcharref.js';

const inText = (s: string) => resolveCharRef(s, 0, false);
const inAttr = (s: string) => resolveCharRef(s, 0, true);

describe('named character references', () => {
  it('resolves a semicolon-terminated reference', () => {
    expect(inText('&copy;').text).toBe('\u00a9');
    expect(inText('&copy;').end).toBe(6);
    expect(inText('&copy;').errors).toEqual([]);
  });

  // Longest match, not first match: 'not' matches and 'notin' does not, so a
  // scan that stops at the first hit gets this right by accident and gets
  // '&notin;' wrong.
  it('takes the longest match', () => {
    expect(inText('&notit;').text).toBe('\u00acit;');
    expect(inText('&notit;').end).toBe(4);
    expect(inText('&notin;').text).toBe('\u2209');
    expect(inText('&notin;').end).toBe(7);
  });

  it('resolves a legacy reference in text, with an error', () => {
    const r = inText('&COPY ');
    expect(r.text).toBe('\u00a9');
    expect(r.end).toBe(5);
    expect(r.errors).toEqual([{ code: 'missing-semicolon-after-character-reference', offset: 5 }]);
  });

  // The attribute rule, and the whole reason the legacy permission is carried.
  it('declines a semicolon-less match in an attribute before = or alphanumeric', () => {
    expect(inAttr('&copy=2').text).toBe('&');
    expect(inAttr('&copy=2').end).toBe(1);
    expect(inAttr('&copy1').end).toBe(1);
  });

  it('accepts a semicolon-less match in an attribute before anything else', () => {
    expect(inAttr("&COPY'").text).toBe('\u00a9');
    expect(inAttr("&COPY'").end).toBe(5);
  });

  it('leaves an unknown reference literal', () => {
    expect(inText('&nosuch;').end).toBe(1);
    expect(inText('&nosuch;').text).toBe('&');
    expect(inText('&nosuch;').errors[0].code).toBe('unknown-named-character-reference');
  });

  it('leaves a bare ampersand literal with no error', () => {
    expect(inText('& ')).toEqual({ text: '&', end: 1, errors: [] });
  });
});

describe('numeric character references', () => {
  it('resolves decimal and hexadecimal', () => {
    expect(inText('&#65;').text).toBe('A');
    expect(inText('&#x41;').text).toBe('A');
    expect(inText('&#X41;').text).toBe('A');
  });

  it('reports a missing semicolon', () => {
    const r = inText('&#65 ');
    expect(r.text).toBe('A');
    expect(r.errors).toEqual([{ code: 'missing-semicolon-after-character-reference', offset: 4 }]);
  });

  // Skipped, these become C1 controls: they draw nothing, so the page looks
  // like a font problem rather than a decode fault.
  it('maps 0x80..0x9F through the windows-1252 table', () => {
    expect(C1_REPLACEMENTS.size).toBe(27);
    expect(inText('&#x80;').text).toBe('\u20ac');
    expect(inText('&#x92;').text).toBe('\u2019');
    expect(inText('&#x9F;').text).toBe('\u0178');
    expect(inText('&#x81;').text).toBe('\u0081'); // absent from the table: passes through
    expect(inText('&#x80;').errors[0].code).toBe('control-character-reference');
  });

  it('replaces null, out-of-range and surrogate references with U+FFFD', () => {
    expect(inText('&#0;').text).toBe('\ufffd');
    expect(inText('&#0;').errors[0].code).toBe('null-character-reference');
    expect(inText('&#x110000;').text).toBe('\ufffd');
    expect(inText('&#x110000;').errors[0].code).toBe('character-reference-outside-unicode-range');
    expect(inText('&#xD800;').text).toBe('\ufffd');
    expect(inText('&#xD800;').errors[0].code).toBe('surrogate-character-reference');
  });

  it('reports a reference with no digits and consumes nothing past the &', () => {
    const r = inText('&#x;');
    expect(r.text).toBe('&#x');
    expect(r.end).toBe(3);
    expect(r.errors[0].code).toBe('absence-of-digits-in-numeric-character-reference');
  });

  it('reports a noncharacter but passes it through', () => {
    expect(inText('&#xFFFF;').text).toBe('\uffff');
    expect(inText('&#xFFFF;').errors[0].code).toBe('noncharacter-character-reference');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmlcharref.test.ts`
Expected: FAIL — `../src/htmlcharref.js` does not exist.

- [ ] **Step 3: Write the sub-machine**

Create `src/htmlcharref.ts`. The C1 table in full — 27 entries, and the five gaps (0x81, 0x8D, 0x8F, 0x90, 0x9D) are absent on purpose and pass through:

```ts
import { namedEntity, allowsMissingSemicolon, MAX_ENTITY_NAME } from './mdentity.js';

/** §13.2.5.80's numeric character reference end state table. The five values in
 *  0x80..0x9F absent from it (0x81, 0x8D, 0x8F, 0x90, 0x9D) pass through
 *  unchanged, which is the spec's behaviour and not an omission. */
export const C1_REPLACEMENTS: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);
```

Then `resolveCharRef`, with the named branch doing a longest-prefix scan bounded by `MAX_ENTITY_NAME` and the attribute rule applied only when the winning match lacks its semicolon.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmlcharref.test.ts`
Expected: PASS, all 15 assertions.

- [ ] **Step 5: Wire it into the tokenizer**

In `src/htmltoken.ts`, route `&` from the Data state, the RCDATA state (Task 7) and the three attribute-value states into `resolveCharRef`, converting each returned `offset` into a line/col through the cursor. The attribute states pass `inAttribute: true`; Data and RCDATA pass `false`.

Append to `test/htmltoken.test.ts`:

```ts
describe('character references in the tokenizer', () => {
  it('resolves a reference in text', () => {
    expect(text('a&amp;b')).toBe('a&b');
  });

  it('applies the attribute rule, so a query string survives', () => {
    const { tokens } = drain('<a href="?a=1&copy=2">');
    expect((tokens[0] as any).attrs.get('href')).toBe('?a=1&copy=2');
  });

  it('resolves the same bytes in text', () => {
    expect(text('?a=1&copy=2')).toBe('?a=1\u00a9=2');
  });

  it('reports a reference error at the right column', () => {
    expect(drain(`<h a='&COPY'>`).errors).toEqual([
      { code: 'missing-semicolon-after-character-reference', line: 1, col: 12 },
    ]);
  });
});
```

- [ ] **Step 6: Turn on the three entity suite files**

Create `test/html5lib-tokenizer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadTokenizerCases, concatCharacterTokens } from './helpers/html5lib-tokenizer.js';
import { HtmlTokenizer, TokenizerState } from '../src/htmltoken.js';

const STATES: Record<string, TokenizerState> = {
  'Data state': TokenizerState.Data,
  'RCDATA state': TokenizerState.RCDATA,
  'RAWTEXT state': TokenizerState.RAWTEXT,
  'Script data state': TokenizerState.ScriptData,
  'PLAINTEXT state': TokenizerState.PLAINTEXT,
  'CDATA section state': TokenizerState.CdataSection,
};

/** Run one case and return its tokens in the suite's own spelling. */
function run(input: string, initialState: string, lastStartTag?: string) {
  const t = new HtmlTokenizer(input);
  const s = STATES[initialState];
  if (s === undefined) throw new Error(`unknown initial state ${initialState}`);
  t.setState(s);
  if (lastStartTag !== undefined) t.setLastStartTag(lastStartTag);
  const out: unknown[][] = [];
  for (;;) {
    const tok = t.next();
    if (tok.kind === 'eof') break;
    if (tok.kind === 'character') out.push(['Character', tok.data]);
    else if (tok.kind === 'comment') out.push(['Comment', tok.data]);
    else if (tok.kind === 'startTag') {
      const a: Record<string, string> = {};
      for (const [k, v] of tok.attrs) a[k] = v;
      out.push(tok.selfClosing ? ['StartTag', tok.name, a, true] : ['StartTag', tok.name, a]);
    } else if (tok.kind === 'endTag') out.push(['EndTag', tok.name]);
    else out.push(['DOCTYPE', tok.name ?? null, tok.publicId ?? null, tok.systemId ?? null, !tok.forceQuirks]);
  }
  return { tokens: concatCharacterTokens(out), errors: t.errors };
}

// Files are turned on as the states they need land. Task 8 replaces this with
// the full declared list and asserts the list is complete.
const FILES = ['entities.test', 'numericEntities.test', 'namedEntities.test'];

describe('html5lib tokenizer suite', () => {
  for (const file of FILES) {
    describe(file, () => {
      for (const c of loadTokenizerCases([file])) {
        it(`${c.description} [${c.initialState}]`, () => {
          const got = run(c.input, c.initialState, c.lastStartTag);
          expect(got.tokens).toEqual(c.output);
          expect(got.errors).toEqual(c.errors);
        });
      }
    });
  }
});
```

Run: `npx vitest run test/html5lib-tokenizer.test.ts`
Expected: PASS. If a case fails, fix the tokenizer — never the expectation, and never by adding to an exclusion list without a recorded reason.

- [ ] **Step 7: Prove the attribute rule and the C1 table load-bearing**

Delete the attribute-context condition (always replace) and run `npx vitest run test/htmlcharref.test.ts test/html5lib-tokenizer.test.ts`.
Expected: FAIL on the attribute cases in `test/htmlcharref.test.ts` and in `entities.test`, and on nothing in `numericEntities.test`. Revert.

Change `resolveCharRef` to treat `allowsMissingSemicolon` as always false and run the same command.
Expected: FAIL in `namedEntities.test`. Revert.

Delete the `C1_REPLACEMENTS` lookup and run the same command.
Expected: FAIL in `numericEntities.test` only. Revert.

Record all three results — they go into `PROVENANCE.md` in Task 8.

- [ ] **Step 8: Run the gates and commit**

```bash
npm run typecheck && npm test
git add src/htmlcharref.ts src/htmltoken.ts test/htmlcharref.test.ts test/htmltoken.test.ts test/html5lib-tokenizer.test.ts
git commit -m "feat(zch2.1.1): character references, and the first three suite files

The attribute rule is why the legacy permission is carried: in an attribute a
semicolon-less match followed by '=' or an alphanumeric is not replaced at
all, so ?a=1&copy=2 keeps its literal &copy while the same bytes in text
resolve to a copyright sign. One table, two rules, decided by the return
state.

The windows-1252 override covers 0x80-0x9F with five deliberate gaps.
Skipped, those references become C1 controls, which draw nothing and read as
a missing glyph rather than as a decode fault."
```

---

## Task 7: Alternate content models

**Files:**
- Modify: `src/htmltoken.ts`
- Test: `test/htmltoken.test.ts`, `test/html5lib-tokenizer.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–6.
- Produces: `TokenizerState` gains the members below. `setLastStartTag` becomes meaningful — the appropriate-end-tag test.

Implement §13.2.5.2–§13.2.5.5 and §13.2.5.15–§13.2.5.31:

`RCDATALessThanSign`, `RCDATAEndTagOpen`, `RCDATAEndTagName`, `RAWTEXTLessThanSign`, `RAWTEXTEndTagOpen`, `RAWTEXTEndTagName`, `ScriptDataLessThanSign`, `ScriptDataEndTagOpen`, `ScriptDataEndTagName`, `ScriptDataEscapeStart`, `ScriptDataEscapeStartDash`, `ScriptDataEscaped`, `ScriptDataEscapedDash`, `ScriptDataEscapedDashDash`, `ScriptDataEscapedLessThanSign`, `ScriptDataEscapedEndTagOpen`, `ScriptDataEscapedEndTagName`, `ScriptDataDoubleEscapeStart`, `ScriptDataDoubleEscaped`, `ScriptDataDoubleEscapedDash`, `ScriptDataDoubleEscapedDashDash`, `ScriptDataDoubleEscapedLessThanSign`, `ScriptDataDoubleEscapeEnd`.

Three rules that are silent when wrong:

- **The appropriate-end-tag test is against the last start tag EMITTED**, and it is case-insensitive on the tag name. `</XMP>` closes `<xmp>`. A non-matching end tag is not a tag at all — the buffered `</name` is emitted as **characters** and the state returns to its content model.
- **RCDATA resolves character references; RAWTEXT, script data and PLAINTEXT do not.** `&amp;` inside `<title>` is `&`; inside `<style>` it is the five literal characters. One `case` label apart, and no rendering reveals the difference until a title shows `&amp;`.
- **NUL differs by content model.** In RCDATA, RAWTEXT and script data it becomes U+FFFD; in Data it passes through. This is the per-state NUL rule the design names.

- [ ] **Step 1: Write the failing test**

Append to `test/htmltoken.test.ts`:

```ts
function drainFrom(src: string, state: TokenizerState, lastStartTag: string) {
  const t = new HtmlTokenizer(src);
  t.setState(state);
  t.setLastStartTag(lastStartTag);
  const tokens = [];
  for (;;) { const tok = t.next(); if (tok.kind === 'eof') break; tokens.push(tok); }
  return { tokens, errors: t.errors };
}

describe('alternate content models', () => {
  it('closes RCDATA on the appropriate end tag, case-insensitively', () => {
    const { tokens } = drainFrom('foo</XMP>', TokenizerState.RCDATA, 'xmp');
    expect(tokens).toEqual([
      { kind: 'character', data: 'f' }, { kind: 'character', data: 'o' },
      { kind: 'character', data: 'o' },
      { kind: 'endTag', name: 'xmp', attrs: new Map(), selfClosing: false },
    ]);
  });

  // A non-matching end tag is not a tag: the buffered characters come back out.
  it('emits a non-matching end tag as characters', () => {
    const { tokens } = drainFrom('foo</div>', TokenizerState.RCDATA, 'xmp');
    expect(tokens.map((t: any) => t.data ?? t.name).join('')).toBe('foo</div>');
    expect(tokens.every((t: any) => t.kind === 'character')).toBe(true);
  });

  // One case label apart, and nothing renders the difference until a <title>
  // shows the five literal characters &amp;.
  it('resolves references in RCDATA and not in RAWTEXT', () => {
    const rc = drainFrom('&amp;</xmp>', TokenizerState.RCDATA, 'xmp');
    expect(rc.tokens.filter((t: any) => t.kind === 'character').map((t: any) => t.data).join('')).toBe('&');
    const rw = drainFrom('&amp;</xmp>', TokenizerState.RAWTEXT, 'xmp');
    expect(rw.tokens.filter((t: any) => t.kind === 'character').map((t: any) => t.data).join('')).toBe('&amp;');
  });

  it('replaces NUL with U+FFFD in RAWTEXT but passes it through in Data', () => {
    const rw = drainFrom('\u0000</xmp>', TokenizerState.RAWTEXT, 'xmp');
    expect((rw.tokens[0] as any).data).toBe('\ufffd');
    expect(text('\u0000')).toBe('\u0000');
  });

  it('keeps a commented close tag as text in RAWTEXT', () => {
    const { tokens } = drainFrom('foo<!--</xmp>--></xmp>', TokenizerState.RAWTEXT, 'xmp');
    const kinds = tokens.map((t: any) => t.kind);
    expect(kinds.filter((k) => k === 'endTag').length).toBe(2);
  });

  it('handles script data double escaping', () => {
    const { tokens } = drainFrom('<!--<script></script>--></script>', TokenizerState.ScriptData, 'script');
    expect(tokens[tokens.length - 1]).toEqual({
      kind: 'endTag', name: 'script', attrs: new Map(), selfClosing: false,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: FAIL on the 6 new assertions.

- [ ] **Step 3: Implement the states**

The three end-tag-name states share one shape; write them as three transcriptions rather than one parameterised helper, so each stays diffable against its own spec section. The shared scratch is the temporary buffer:

```ts
  /** The characters buffered since '<' in a content-model end-tag scan. If the
   *  name turns out not to be the appropriate end tag, they are emitted as
   *  characters — a non-matching end tag is not a tag at all. */
  private tempBuffer = '';

  private isAppropriateEndTag(): boolean {
    return this.tagName === this.lastStartTag;
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: PASS, all 38 assertions.

- [ ] **Step 5: Turn on the content-model suite files**

In `test/html5lib-tokenizer.test.ts`, extend `FILES`:

```ts
const FILES = [
  'entities.test', 'numericEntities.test', 'namedEntities.test',
  'contentModelFlags.test', 'escapeFlag.test',
];
```

Run: `npx vitest run test/html5lib-tokenizer.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the RCDATA/RAWTEXT split load-bearing**

Route RAWTEXT's `&` into `resolveCharRef` as RCDATA does, and run `npx vitest run test/htmltoken.test.ts test/html5lib-tokenizer.test.ts`.
Expected: FAIL on the RCDATA/RAWTEXT case and in `contentModelFlags.test`. Revert.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck && npm test
git add src/htmltoken.ts test/htmltoken.test.ts test/html5lib-tokenizer.test.ts
git commit -m "feat(zch2.1.1): RCDATA, RAWTEXT, script data and their escapes

RCDATA resolves character references and RAWTEXT does not — one case label
apart, and nothing renders the difference until a <title> shows the five
literal characters &amp;.

A non-matching end tag is not a tag: the buffered '</name' comes back out as
characters and the content model resumes, which is what keeps '</div>'
inside a <textarea> visible."
```

---

## Task 8: Full suite green, mutations recorded, docs

**Files:**
- Modify: `src/htmltoken.ts` (whatever the remaining files expose)
- Modify: `test/html5lib-tokenizer.test.ts`
- Modify: `test/fixtures/html5lib/PROVENANCE.md`
- Modify: `CLAUDE.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything.
- Produces: the finished tokenizer. `zch2.1.2` builds on `HtmlTokenizer`, `HtmlToken`, `TokenizerState`, `setState`, `setLastStartTag`.

- [ ] **Step 1: Turn on every declared file**

Replace the hand-maintained `FILES` list in `test/html5lib-tokenizer.test.ts` with the loader's own default, and assert there is no allowlist left:

```ts
import { loadTokenizerCases, SUITE_FILES, EXCLUDED, concatCharacterTokens } from './helpers/html5lib-tokenizer.js';

describe('html5lib tokenizer suite', () => {
  it('runs every declared file except the recorded exclusions', () => {
    const ran = new Set(loadTokenizerCases().map((c) => c.file));
    const expected = SUITE_FILES.filter((f) => !EXCLUDED.some((e) => e.file === f));
    expect([...ran].sort()).toEqual([...expected].sort());
  });

  for (const c of loadTokenizerCases()) {
    it(`${c.file}: ${c.description} [${c.initialState}]`, () => {
      const got = run(c.input, c.initialState, c.lastStartTag);
      expect(got.tokens).toEqual(c.output);
      expect(got.errors).toEqual(c.errors);
    });
  }
});
```

- [ ] **Step 2: Run it and fix the tokenizer until green**

Run: `npx vitest run test/html5lib-tokenizer.test.ts`

Fix `src/htmltoken.ts` until every case passes. Two rules while doing this: never edit a vendored expectation, and never add a file or a case to `EXCLUDED` without a recorded reason that names what the case asserts and why this library declines it. A growing exclusion list is the failure mode this whole task exists to prevent.

- [ ] **Step 3: Run the five mutation checks and record the results**

Run each, note exactly which files redden, then revert:

| # | Mutation | Expected |
|---|---|---|
| 1 | `allowsMissingSemicolon` always returns false | `namedEntities.test` alone |
| 2 | Delete the attribute-context rule in the named branch | only the legacy-in-attribute cases (`entities.test`) |
| 3 | `preprocess` returns `src` unchanged | position assertions; token assertions stay green |
| 4 | Delete the `C1_REPLACEMENTS` lookup | `numericEntities.test` alone |
| 5 | Replace U+0000 globally with U+FFFD in every state | a subset of `test1`–`test4`; the entity suites stay green |

Run each as: `npx vitest run test/html5lib-tokenizer.test.ts 2>&1 | tail -40`

- [ ] **Step 4: Write the results into PROVENANCE.md**

Fill the `## Mutation results` section with what actually happened — the file names and case counts observed, not the predictions above. **A mutation that reddens nothing is the important result**: it means the suite does not cover that rule, and it gets recorded here as an uncovered gap rather than left to be discovered, the form `test/fixtures/fonts/PROVENANCE.md` uses for the Type 1 paths its one real font cannot reach.

- [ ] **Step 5: Add the CLAUDE.md source-list entries**

The Source list in `CLAUDE.md` gets an entry for each new module **when it lands**. Insert near the `markdown.ts` / `mdscan.ts` cluster, since that is where the entity table's other reader is:

```markdown
- **htmltoken.ts**, **htmlcharref.ts** — the WHATWG HTML tokenizer
  (HTML Standard §13.2.5), a literal transcription: one branch per spec state,
  named as the spec names it, over a pull model (`next`/`setState`) that
  tree construction steers for RCDATA, RAWTEXT, script data and PLAINTEXT.
  Note the direction against `htmlsemantic.ts` and `htmlfixed.ts`, which are
  PDF→HTML and share no code with this.
  **Invariant:** it NEVER throws. Every string is a valid HTML document — the
  spec mandates a recovery for every parse error by construction — so parse
  errors are values on `errors`, never control flow. This is `markdown.ts`'s
  rule and the exact opposite of `parseXml`, which throws `PdfParseError`; the
  contrast otherwise reads as an oversight and gets "fixed".
  **Invariant:** both are pure leaves. No `Document`, no PDF object, no `node:`
  import; they take a `string`. Character-encoding detection from bytes is a
  separate decision, tracked as `zch2.8`.
  **Invariant:** neither `xml.ts` nor `mdscan.ts` is reused, and the reasons are
  opposite. `parseXml` is one closure-based recursive descent that throws on a
  mismatched end tag, demands quoted attribute values and strips namespace
  prefixes — every rule the inverse of what HTML5 needs. `scanHtmlTag` is
  CommonMark's grammar, returns only an end index, and produces no name and no
  attributes; it also REJECTS inputs HTML5 accepts, on purpose. Two grammars
  sharing a name, as `tablegrid.ts` and `tablespan.ts` do.
  **Invariant:** the error position is the code point just CONSUMED, except at
  markup declaration open, the one peek-based site, which reports at the code
  point it only looked at — `<!DOC>` fires `incorrectly-opened-comment` at the
  `D`. Columns count CODE POINTS, so an astral character advances by one.
  **Invariant:** the named character reference state matches BOTH spellings,
  which is why `gen-entities.mjs` now emits the 106 legacy names beside the
  2125-entry table. Measured: every legacy name is ALSO a semicolon key with an
  identical value, so this is a SPELLING PERMISSION rather than a second table
  — `allowsMissingSemicolon` is a predicate and `namedEntity` still answers for
  every name. In an attribute a semicolon-less match followed by `=` or an
  alphanumeric is NOT replaced, so `?a=1&copy=2` keeps its literal `&copy`
  while the same bytes in text give `©`. CommonMark reads the values and never
  the predicate, so its output cannot move;
  `test/commonmark-spec.test.ts`'s 652 cases are that fence.
  **Invariant:** RCDATA resolves character references and RAWTEXT, script data
  and PLAINTEXT do not — one `case` label apart, and no rendering reveals the
  difference until a `<title>` shows the five literal characters `&amp;`. NUL
  likewise differs by content model rather than globally.
  **Note on the oracle:** anchored by `html5lib-tests/tokenizer`, the suite
  browser engines share, vendored under `test/fixtures/html5lib/` with the
  mutation results recorded. `xmlViolation.test` is excluded STRUCTURALLY — its
  root key is `xmlViolationTests` rather than `tests` — never by file name.
```

Then run the repo's own sweep and confirm it reports neither module:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 6: Add the fixture table row**

`CLAUDE.md`'s real-world fixture table gains a row:

```markdown
| `fixtures/html5lib/` | `PROVENANCE.md` | The official html5lib-tests tokenizer suite — every state, both character-reference spellings, and the parse-error vocabulary with positions. The suite browser engines share, so it catches the class our own builders cannot: our tokenizer and our own expectations agreeing and both disagreeing with HTML5 |
```

- [ ] **Step 7: Add the CHANGELOG entry**

Under `## [Unreleased]`, in **Added**. The tokenizer is not yet public API, so the entry says what shipped and what it is for rather than naming a function a caller can reach:

```markdown
- **A conformant HTML5 tokenizer**, the first piece of HTML→PDF conversion
  (`zch2.1.1`). A literal transcription of the WHATWG state machine — every
  state, both character-reference spellings, and the full parse-error
  vocabulary with line and column — anchored by the official html5lib-tests
  tokenizer suite that browser engines share. It never throws: every string is
  a valid HTML document, so damage is reported as values rather than refusing
  the input, which is CommonMark's rule here and the opposite of `parseXml`.
  The bundled entity table gained the 106 names HTML5 matches without a
  trailing semicolon and CommonMark does not, so `?a=1&copy=2` keeps its query
  string in an attribute while the same bytes in text give `©`. Not yet reachable from
  public API — tree construction is `zch2.1.2`.
```

- [ ] **Step 8: Run the gates and commit**

```bash
npm run typecheck && npm test
git add src/htmltoken.ts test/html5lib-tokenizer.test.ts test/fixtures/html5lib/PROVENANCE.md CLAUDE.md CHANGELOG.md
git commit -m "feat(zch2.1.1): the full html5lib tokenizer suite green

Records the five mutation results in PROVENANCE.md, including any that
reddened nothing — a rule the suite does not cover is a gap to write down,
not one to leave for someone to find.

xmlViolation.test stays the only exclusion, and it is structural: its root
key is xmlViolationTests rather than tests, so the loader throws rather than
matching on a file name that could change shape underneath us."
```

- [ ] **Step 9: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-zch2.1.1
git pull --rebase && git push && git status
```

`git status` must show the branch up to date with origin. Work is not complete until the push succeeds.

---

## Self-review

**Spec coverage.** Every section of the design maps to a task: the legacy spelling permission → Task 1; the never-throws invariant and purity → Task 3 (asserted) and Task 8 (recorded in `CLAUDE.md`); the literal-transcription structure → Tasks 3–7, each naming its spec sections; the pull model and steering seam → Task 3's interface and Task 7's `setLastStartTag`; the four silent-when-wrong details → preprocessing (Task 3), the attribute rule and the windows-1252 override (Task 6), per-state NUL (Tasks 3 and 7); anchoring, the structural exclusion and the loader's three wrinkles → Task 2; the five mutation checks → Tasks 1, 3, 4, 5, 6, 7 individually and Task 8 collectively, with results recorded.

**Two things the plan adds that the spec did not settle**, both because writing the tasks forced the question:

1. **The error-position convention** — `lastPos()` by default, `pos()` at markup declaration open. The spec said positions would be asserted and did not say how they are derived. The five worked examples are from the vendored expectations, not reasoned about.
2. **`src/index.ts` is untouched.** Nothing here is public API until `zch2.1.2` supplies `parseHtml`. Exporting a tokenizer nobody can drive is an API we would then have to keep.

**Known soft spot, flagged rather than hidden:** Task 4 Step 3's note about `duplicate-attribute`'s expected column (11 for `<h a='b' a='d'>`) reasons from the vendored case rather than from a derivation. If the transcription puts it elsewhere, the fix is the `lastPos`/`pos` choice at that one site, not the duplicate logic — the token expectation (`{a: 'b'}`) pins the logic independently.
