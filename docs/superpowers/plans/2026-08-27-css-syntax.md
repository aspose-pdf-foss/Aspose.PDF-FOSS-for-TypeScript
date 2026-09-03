# CSS Syntax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement CSS Syntax Level 3 — the tokenizer and the component-value parser — passing all 149 vendored `css-parsing-tests` cases with no allowlist.

**Architecture:** Two pure leaves. `src/csstoken.ts` is §4: a `string → CssToken[]` function with 31 token types, knowing nothing of blocks or rules. `src/cssparse.ts` is §5: seven parser entry points over those tokens, never re-reading a character. A test-only serializer in `test/helpers/css-parsing.ts` renders our types into the corpus's JSON, written from the corpus README rather than from whatever our types make convenient.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-css-syntax-design.md`](../specs/2026-08-27-css-syntax-design.md)

**Issue:** `zch2.2.1`, under `zch2.2`, under epic `zch2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins, and this feature needs none.
- **ESM + NodeNext.** Every import specifier carries `.js`.
- **Nothing throws.** No `throw` in `src/csstoken.ts` or `src/cssparse.ts`. Syntax 3 defines a recovery for everything, including `bad-string` and `bad-url`, which are token types rather than failures.
- **Purity.** Neither may import `document.js`, `page.js`, any PDF object module, **or `htmldom.js`**. String in, structure out. Collecting `<style>` text is `zch2.2.3`'s.
- **Nothing is exported from `src/index.ts`.** Nothing downstream exists yet.
- **We implement the CORPUS's spec era**, not the current editor's draft — see the design's *The two spec eras*. `unicode-range`, the five match tokens (`~=` `|=` `^=` `$=` `*=`) and the column token (`||`) are tokenizer outputs here. A future reader "fixing" this toward the current draft reddens 11 cases; two mutations in Task 5 exist to make that immediate.
- **No allowlist and no bucket predicate.** All 149 cases run.
- **Never edit a vendored expectation.** If a case genuinely cannot be satisfied, stop and report it.
- **Run before closing any task:** `npm run typecheck` and `npm test`, both green. The full suite takes ~100s, so run them as separate commands or the 2-minute default timeout kills them.
- **Writing files:** this Windows/Git Bash setup eats backslashes in heredocs *and* in `node -e` one-liners, even with a quoted delimiter — and backticks inside a double-quoted string trigger command substitution and silently delete a word. Use the Write/Edit tools for any file containing escapes, and `git commit -F -` with a quoted heredoc for any message containing backticks. If a shell command must emit a backslash, build it with `String.fromCharCode(92)`. **This matters more here than in any previous issue: CSS escapes are the subject matter.**
- **CHANGELOG.md** gets no entry: nothing here is user-visible. `CLAUDE.md` gets its source-list entry in the final task.

## File Structure

| File | Responsibility |
|---|---|
| `test/fixtures/css-parsing/*.json` | **Vendor.** 8 files from css-parsing-tests. |
| `test/fixtures/css-parsing/PROVENANCE.md` | **Create.** Source, pin, hashes, case counts, the spec-era decision, mutation results. |
| `test/helpers/css-parsing.ts` | **Create.** Corpus loader + the JSON serializer. |
| `test/css-parsing-suite.test.ts` | **Create.** Loader and serializer tests — no tokenizer. |
| `src/csstoken.ts` | **Create.** §4, the tokenizer. |
| `test/csstoken.test.ts` | **Create.** Hand-built token cases. |
| `src/cssparse.ts` | **Create.** §5, the parser entry points. |
| `test/cssparse.test.ts` | **Create.** Hand-built parser cases. |
| `test/css-parsing.test.ts` | **Create.** Drives the vendored corpus. |
| `CLAUDE.md` | **Modify.** Final task. |

---

## Reference: the corpus's JSON shape

Read from the corpus README at the pinned commit and **verified against the
data**, which the README does not fully describe. Both halves matter: the
README omits four of the nine error kinds.

**Component values.** A token is an array whose first element names it, except
the ones that serialize as a bare string:

| Token | JSON |
|---|---|
| ident | `["ident", value]` |
| at-keyword | `["at-keyword", value]` |
| hash | `["hash", value, "id"｜"unrestricted"]` |
| string | `["string", value]` |
| url | `["url", value]` |
| number | `["number", repr, value, "integer"｜"number"]` |
| percentage | `["percentage", repr, value, "integer"｜"number"]` |
| dimension | `["dimension", repr, value, "integer"｜"number", unit]` |
| unicode-range | `["unicode-range", start, end]` |
| function | `["function", name, ...args]` |
| `{}` `[]` `()` block | `["{}", ...contents]` and so on |
| delim | the one-character string, e.g. `"&"` |
| whitespace | the single-space string `" "` |
| CDO / CDC | `"<!--"` / `"-->"` |
| colon / semicolon / comma | `":"` / `";"` / `","` |
| match tokens | `"~="` `"\|="` `"^="` `"$="` `"*="` |
| column | `"\|\|"` |

Note `dimension` is **five** elements though the README's prose says four —
the data is authoritative and shows `["dimension", "0", 0, "integer", "red"]`.

**Rules and declarations:**

| Node | JSON |
|---|---|
| at-rule | `["at-rule", name, prelude[], block[]｜null]` |
| qualified rule | `["qualified rule", prelude[], block[]]` |
| declaration | `["declaration", name, value[], important]` |

**Errors.** Nine kinds, measured from the data; the README documents only
five:

| Kind | Where it appears |
|---|---|
| `bad-string`, `bad-url` | component-value level |
| `eof-in-string`, `eof-in-url` | component-value level |
| `)`, `]` | unmatched close, component-value level |
| `empty` | an entry point given nothing |
| `invalid` | an entry point given something unparseable |
| `extra-input` | a single-value entry point given more than one |

All serialize as `["error", kind]`.

**Case counts**, measured — assert these so a corpus update reddens the build:

| File | Cases |
|---|---|
| `component_value_list.json` | 50 |
| `one_declaration.json` | 21 |
| `stylesheet.json` | 16 |
| `rule_list.json` | 15 |
| `one_rule.json` | 14 |
| `blocks_contents.json` | 13 |
| `declaration_list.json` | 10 |
| `one_component_value.json` | 10 |
| **total** | **149** |

---

## Task 1: Vendor the corpus and build its loader

Built before the tokenizer exists, against hand-built expectations — the rule
`zch2.1.1` and `zch2.1.2` both set: a loader validated only through a parser
cannot tell a loader bug from a parser bug.

**Files:**
- Vendor: `test/fixtures/css-parsing/*.json` (8 files)
- Create: `test/fixtures/css-parsing/PROVENANCE.md`
- Create: `test/helpers/css-parsing.ts`
- Test: `test/css-parsing-suite.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type CssSuite =
    | 'component_value_list' | 'one_component_value' | 'declaration_list'
    | 'one_declaration' | 'rule_list' | 'one_rule' | 'stylesheet'
    | 'blocks_contents';
  export interface CssCase { suite: CssSuite; index: number; input: string; expected: unknown; }
  export const CSS_SUITES: CssSuite[];
  export function loadCssCases(suites?: CssSuite[]): CssCase[];
  ```

- [ ] **Step 1: Vendor the fixtures**

```bash
mkdir -p test/fixtures/css-parsing
BASE=https://raw.githubusercontent.com/CourtBouillon/css-parsing-tests/203ce36bffd617db7f118c551e32794561fb273d
for f in component_value_list one_component_value declaration_list one_declaration \
         rule_list one_rule stylesheet blocks_contents; do
  curl -fsSL "$BASE/$f.json" -o "test/fixtures/css-parsing/$f.json" || echo "FAILED $f"
done
curl -fsSL "$BASE/LICENSE" -o test/fixtures/css-parsing/LICENSE
ls test/fixtures/css-parsing | wc -l   # expect 9 (8 json + LICENSE)
cd test/fixtures/css-parsing && sha256sum *.json | sort
```

**Do NOT vendor `An+B.json`** — its 128 cases are the `:nth-child()`
microsyntax, which is Selectors and so `zch2.2.2`'s. **Do NOT vendor any
`color_*.json`** — roughly 400 KB of CSS Color 4/5, which is `zch2.2.3`'s and
irrelevant to a PDF that needs sRGB.

- [ ] **Step 2: Write the failing test**

Create `test/css-parsing-suite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadCssCases, CSS_SUITES } from './helpers/css-parsing.js';

describe('the css-parsing-tests loader', () => {
  it('declares eight suites', () => {
    expect(CSS_SUITES.length).toBe(8);
  });

  // Counts asserted so a corpus update reddens the build rather than quietly
  // changing what zch2.2.1 tests.
  it('loads every case, with known per-suite counts', () => {
    expect(loadCssCases(['component_value_list']).length).toBe(50);
    expect(loadCssCases(['one_declaration']).length).toBe(21);
    expect(loadCssCases(['stylesheet']).length).toBe(16);
    expect(loadCssCases(['rule_list']).length).toBe(15);
    expect(loadCssCases(['one_rule']).length).toBe(14);
    expect(loadCssCases(['blocks_contents']).length).toBe(13);
    expect(loadCssCases(['declaration_list']).length).toBe(10);
    expect(loadCssCases(['one_component_value']).length).toBe(10);
    expect(loadCssCases().length).toBe(149);
  });

  // The file is a FLAT array of alternating input and expected, not an array
  // of pairs. A loader that reads it as pairs finds 74 cases and a trailing
  // undefined, which looks like a corpus problem rather than a reader bug.
  it('reads the flat alternating array', () => {
    const c = loadCssCases(['one_declaration']);
    expect(c[0]?.input).toBe('');
    expect(c[0]?.expected).toEqual(['error', 'empty']);
    expect(c[0]?.index).toBe(0);
    expect(c[1]?.index).toBe(1);
  });

  it('records which suite a case came from', () => {
    expect(loadCssCases(['stylesheet'])[0]?.suite).toBe('stylesheet');
  });

  it('rejects a suite that is not declared', () => {
    expect(() => loadCssCases(['nope' as never])).toThrow(/not a declared/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/css-parsing-suite.test.ts`
Expected: FAIL — `./helpers/css-parsing.js` does not exist.

- [ ] **Step 4: Write the loader**

Create `test/helpers/css-parsing.ts`:

```ts
/** Loader for CourtBouillon's css-parsing-tests corpus, plus the serializer
 *  that renders our types into its JSON — the oracle's other half.
 *
 *  Test-only. Nothing in `src/` may import this, the rule
 *  `test/helpers/wpt-tree.ts` and `test/helpers/md-html.ts` already set. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'css-parsing',
);

export type CssSuite =
  | 'component_value_list' | 'one_component_value' | 'declaration_list'
  | 'one_declaration' | 'rule_list' | 'one_rule' | 'stylesheet'
  | 'blocks_contents';

export const CSS_SUITES: CssSuite[] = [
  'component_value_list', 'one_component_value', 'declaration_list',
  'one_declaration', 'rule_list', 'one_rule', 'stylesheet', 'blocks_contents',
];

export interface CssCase {
  suite: CssSuite;
  index: number;
  input: string;
  expected: unknown;
}

/** Each file is a FLAT array of alternating input and expected value, not an
 *  array of pairs. Reading it as pairs yields half the cases and a trailing
 *  undefined, which reads as a corpus problem rather than a reader bug. */
export function loadCssCases(suites?: CssSuite[]): CssCase[] {
  const want = suites ?? CSS_SUITES;
  const out: CssCase[] = [];
  for (const suite of want) {
    if (!CSS_SUITES.includes(suite)) throw new Error(`${suite} is not a declared suite`);
    const raw = JSON.parse(readFileSync(join(DIR, `${suite}.json`), 'utf8')) as unknown[];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      out.push({
        suite,
        index: i / 2,
        input: raw[i] as string,
        expected: raw[i + 1],
      });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/css-parsing-suite.test.ts`
Expected: PASS, all 5 assertions. If a count is off, the corpus moved since
this plan was written — do **not** edit the expected number. Re-derive the
counts, confirm nothing was dropped upstream, and record the change in
`PROVENANCE.md`.

- [ ] **Step 6: Write the provenance document**

Create `test/fixtures/css-parsing/PROVENANCE.md`, filling the hash table from
Step 1:

```markdown
# css-parsing-tests — provenance

The conformance corpus for CSS Syntax Level 3, here to validate
`src/csstoken.ts` and `src/cssparse.ts` against expectations this repo did not
author. See `docs/superpowers/specs/2026-08-27-css-syntax-design.md`.

**Source:** <https://github.com/CourtBouillon/css-parsing-tests> (BSD-3-Clause,
vendored as `LICENSE`). Downloaded verbatim, not regenerated.

**Commit:** `203ce36bffd617db7f118c551e32794561fb273d` (2025-09-24).

| File | Bytes | Cases | SHA-256 |
|---|---|---|---|
| ... | ... | ... | ... |

149 cases across 8 files, every one run, with no allowlist and no bucket
predicate.

## What is deliberately NOT vendored

**`An+B.json`** (128 cases) is the `:nth-child()` microsyntax — Selectors, not
Syntax. It belongs to `zch2.2.2`, and only if that issue implements
`:nth-child` at all.

**The eight `color_*.json` files** (~400 KB) are CSS Color 4/5. Colour is not
part of Syntax 3: `#aaa` tokenizes as a hash token and `rgb(0,0,0)` as a
function token, and turning either into a colour is `zch2.2.3`'s job. A PDF
needs sRGB.

## THE SPEC ERA, and it is a decision

This corpus is pinned to the **2014-era** CSS Syntax 3 and still tokenizes
seven things the current editor's draft removed from the tokenizer:
`unicode-range`, the five match tokens (`~=` `|=` `^=` `$=` `*=`) and the
column token (`||`). **Eleven of the 149 cases turn on it** — all in
`component_value_list.json`, cases 38 through 48.

`src/csstoken.ts` implements the CORPUS's era, deliberately:

- It keeps the corpus running whole, with no bucket and no asserted
  exclusions, which is the strongest fence available here.
- `zch2.9` already records this repo following a pinned oracle against a newer
  spec, for HTML processing instructions, for exactly this reason.
- It helps `zch2.2.2`: `[href^="x"]` arrives as one `^=` token rather than two
  delims a selector parser would have to rejoin.

The cost is seven token types the live spec does not have, invisible to a
cascade. **Do not "fix" this toward the current draft** — two mutations below
exist to make that reddening immediate.

## The README is incomplete, and the data is authoritative

Two places where following the README alone produces a wrong implementation:

- It documents **five** error kinds; the data uses **nine**. `eof-in-string`,
  `eof-in-url`, `empty`, `invalid` and `extra-input` are all absent from the
  prose.
- It says a `<dimension>` is "an array of length 4" and then lists five
  elements. The data shows five: `["dimension", "0", 0, "integer", "red"]`.

## Mutation results

(Filled in by the final task.)
```

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck
npm test
git add test/fixtures/css-parsing test/helpers/css-parsing.ts test/css-parsing-suite.test.ts
git commit -F - <<'MSG'
test(zch2.2.1): vendor css-parsing-tests and its loader

Built before the tokenizer exists, against hand-built expectations: a loader
validated only through a parser cannot tell a loader bug from a parser bug.

Each file is a FLAT array of alternating input and expected value rather than
an array of pairs. Reading it as pairs yields half the cases and a trailing
undefined, which reads as a corpus problem rather than a reader bug.

149 cases across 8 files, counts asserted per suite. An+B.json is not
vendored — it is the :nth-child microsyntax and so Selectors, not Syntax —
and neither are the ~400KB of CSS Color 4/5 files, which are zch2.2.3's.

PROVENANCE records two things the README gets wrong, both of which would
produce a wrong implementation if followed: it documents five error kinds
where the data uses nine, and calls a dimension "length 4" while listing five
elements.
MSG
```

---

## Task 2: The serializer

Its own task because it is the oracle's other half, and because it can be
verified against the vendored expectations with no tokenizer at all:
serializing a hand-built token list must reproduce a known case's expected
JSON exactly.

**Files:**
- Modify: `test/helpers/css-parsing.ts`
- Test: `test/css-parsing-suite.test.ts`

**Interfaces:**
- Consumes: `CssToken` and the parser's node types — **but they do not exist
  yet**, so this task defines the serializer against the types Task 3 and
  Task 4 will produce, and those tasks must match. The exact shapes are in
  this task's Step 3.
- Produces: `export function serializeCss(value: unknown): unknown;`

Written from the corpus README and the measured data, **not** from whatever
our types make convenient — a serializer bent to fit the types hides bugs in
those types.

- [ ] **Step 1: Write the failing test**

Append to `test/css-parsing-suite.test.ts`:

```ts
import { serializeCss } from './helpers/css-parsing.js';

describe('the css-parsing-tests serializer', () => {
  // The whole point: reproduce a vendored expectation byte for byte from a
  // structure built by hand, before any tokenizer exists to produce one.
  it('reproduces a vendored expectation exactly', () => {
    const expected = loadCssCases(['one_declaration'])
      .find((c) => c.input === 'foo:')?.expected;
    const built = {
      kind: 'declaration', name: 'foo', value: [], important: false,
    };
    expect(serializeCss(built)).toEqual(expected);
  });

  it('writes the bare-string tokens', () => {
    expect(serializeCss({ kind: 'whitespace' })).toBe(' ');
    expect(serializeCss({ kind: 'colon' })).toBe(':');
    expect(serializeCss({ kind: 'semicolon' })).toBe(';');
    expect(serializeCss({ kind: 'comma' })).toBe(',');
    expect(serializeCss({ kind: 'cdo' })).toBe('<!--');
    expect(serializeCss({ kind: 'cdc' })).toBe('-->');
    expect(serializeCss({ kind: 'delim', value: '&' })).toBe('&');
  });

  // The seven the corpus's era tokenizes and the current draft does not.
  it('writes the era-specific tokens', () => {
    expect(serializeCss({ kind: 'match', value: '^=' })).toBe('^=');
    expect(serializeCss({ kind: 'column' })).toBe('||');
    expect(serializeCss({ kind: 'unicode-range', start: 1, end: 16 }))
      .toEqual(['unicode-range', 1, 16]);
  });

  // A number carries its REPRESENTATION and a type flag beside its value.
  // 1 and 1.0 have equal values and differ only in the flag.
  it('writes a number with its representation and type flag', () => {
    expect(serializeCss({ kind: 'number', repr: '1', value: 1, int: true }))
      .toEqual(['number', '1', 1, 'integer']);
    expect(serializeCss({ kind: 'number', repr: '1.0', value: 1, int: false }))
      .toEqual(['number', '1.0', 1, 'number']);
  });

  // A dimension is FIVE elements, though the README's prose says four.
  it('writes a dimension with five elements', () => {
    expect(serializeCss({ kind: 'dimension', repr: '2', value: 2, int: true, unit: 'em' }))
      .toEqual(['dimension', '2', 2, 'integer', 'em']);
  });

  it('writes a hash with its id-or-unrestricted type', () => {
    expect(serializeCss({ kind: 'hash', value: 'a', id: true }))
      .toEqual(['hash', 'a', 'id']);
    expect(serializeCss({ kind: 'hash', value: '1', id: false }))
      .toEqual(['hash', '1', 'unrestricted']);
  });

  it('writes blocks and functions with their contents inline', () => {
    expect(serializeCss({ kind: 'block', open: '{', contents: [{ kind: 'colon' }] }))
      .toEqual(['{}', ':']);
    expect(serializeCss({ kind: 'block', open: '[', contents: [] })).toEqual(['[]']);
    expect(serializeCss({ kind: 'function', name: 'f', args: [{ kind: 'comma' }] }))
      .toEqual(['function', 'f', ',']);
  });

  it('writes rules and errors', () => {
    expect(serializeCss({ kind: 'at-rule', name: 'foo', prelude: [], block: null }))
      .toEqual(['at-rule', 'foo', [], null]);
    expect(serializeCss({ kind: 'qualified-rule', prelude: [], block: [] }))
      .toEqual(['qualified rule', [], []]);
    expect(serializeCss({ kind: 'error', code: 'invalid' }))
      .toEqual(['error', 'invalid']);
  });

  it('serializes an array by mapping over it', () => {
    expect(serializeCss([{ kind: 'colon' }, { kind: 'whitespace' }])).toEqual([':', ' ']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/css-parsing-suite.test.ts`
Expected: FAIL — `serializeCss` is not exported.

- [ ] **Step 3: Write the serializer**

Add to `test/helpers/css-parsing.ts`. The input shapes below are the contract
Tasks 3 and 4 must produce:

```ts
/** Render our token and node types into the corpus's JSON.
 *
 *  Written from the corpus README and from the DATA, which disagree in two
 *  places where the data wins: a dimension is five elements though the prose
 *  says four, and there are nine error kinds where the prose lists five.
 *
 *  Deliberately NOT written from whatever our types make convenient — a
 *  serializer bent to fit the types hides bugs in those types. */
export function serializeCss(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(serializeCss);
  const v = value as Record<string, unknown>;
  switch (v['kind']) {
    case 'whitespace': return ' ';
    case 'colon': return ':';
    case 'semicolon': return ';';
    case 'comma': return ',';
    case 'cdo': return '<!--';
    case 'cdc': return '-->';
    case 'column': return '||';
    case 'delim': return v['value'];
    case 'match': return v['value'];
    case 'ident': return ['ident', v['value']];
    case 'at-keyword': return ['at-keyword', v['value']];
    case 'string': return ['string', v['value']];
    case 'url': return ['url', v['value']];
    case 'hash': return ['hash', v['value'], v['id'] === true ? 'id' : 'unrestricted'];
    case 'number':
      return ['number', v['repr'], v['value'], v['int'] === true ? 'integer' : 'number'];
    case 'percentage':
      return ['percentage', v['repr'], v['value'], v['int'] === true ? 'integer' : 'number'];
    case 'dimension':
      return ['dimension', v['repr'], v['value'],
        v['int'] === true ? 'integer' : 'number', v['unit']];
    case 'unicode-range': return ['unicode-range', v['start'], v['end']];
    case 'block': {
      const pair = v['open'] === '{' ? '{}' : v['open'] === '[' ? '[]' : '()';
      return [pair, ...(v['contents'] as unknown[]).map(serializeCss)];
    }
    // `args` is absent on the tokenizer's FLAT function token, which the
    // parser always wraps before anything is serialized. The `?? []` keeps a
    // leak from crashing here so it surfaces as a failed comparison against
    // the corpus, which names the case, rather than as a stack trace.
    case 'function':
      return ['function', v['name'],
        ...((v['args'] as unknown[] | undefined) ?? []).map(serializeCss)];
    case 'at-rule':
      return ['at-rule', v['name'], serializeCss(v['prelude']),
        v['block'] === null ? null : serializeCss(v['block'])];
    case 'qualified-rule':
      return ['qualified rule', serializeCss(v['prelude']), serializeCss(v['block'])];
    case 'declaration':
      return ['declaration', v['name'], serializeCss(v['value']), v['important']];
    case 'error': return ['error', v['code']];
    default: return value;
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/css-parsing-suite.test.ts`
Expected: PASS, all 14 assertions.

- [ ] **Step 5: Prove two rules load-bearing**

Change the `dimension` case to drop the unit (return four elements) and run
the file.
Expected: FAIL on the dimension case alone. Revert.

Change the `number` case to always emit `'integer'` and run the file.
Expected: FAIL on the number case alone. Revert.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck
npx vitest run test/css-parsing-suite.test.ts
git add test/helpers/css-parsing.ts test/css-parsing-suite.test.ts
git commit -F - <<'MSG'
test(zch2.2.1): the css-parsing-tests serializer

The oracle's other half, written from the corpus README and from the DATA
rather than from whatever our types make convenient — a serializer bent to
fit the types hides bugs in those types. Verified by reproducing a vendored
expectation from a hand-built structure, before any tokenizer exists.

The README and the data disagree twice and the data wins: a dimension is five
elements though the prose says four, and there are nine error kinds where the
prose lists five.

Measured load-bearing: dropping a dimension's unit reddens the dimension case
alone, and forcing every number's type flag to integer reddens the number
case alone.
MSG
```

---

## Task 3: The tokenizer

**Files:**
- Create: `src/csstoken.ts`
- Test: `test/csstoken.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type CssToken =
    | { kind: 'ident' | 'at-keyword' | 'string' | 'url'; value: string }
    | { kind: 'hash'; value: string; id: boolean }
    | { kind: 'delim' | 'match'; value: string }
    | { kind: 'number' | 'percentage'; repr: string; value: number; int: boolean }
    | { kind: 'dimension'; repr: string; value: number; int: boolean; unit: string }
    | { kind: 'unicode-range'; start: number; end: number }
    | { kind: 'function'; name: string }
    | { kind: 'error'; code: 'bad-string' | 'bad-url' | 'eof-in-string' | 'eof-in-url' }
    | { kind: 'whitespace' | 'colon' | 'semicolon' | 'comma' | 'cdo' | 'cdc' | 'column' }
    | { kind: 'open'; open: '{' | '[' | '(' }
    | { kind: 'close'; close: '}' | ']' | ')' };

  export function tokenize(css: string): CssToken[];
  ```

Note the tokenizer emits `function` as a **flat** token carrying only a name,
and `open`/`close` as flat tokens. Nesting is the parser's job — the
serializer's `block` and `function` shapes come from `cssparse.ts`, not here.

- [ ] **Step 1: Write the failing test**

Create `test/csstoken.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/csstoken.js';

describe('the CSS tokenizer', () => {
  it('tokenizes an ident, a colon and a whitespace run as three tokens', () => {
    expect(tokenize('a:  b')).toEqual([
      { kind: 'ident', value: 'a' },
      { kind: 'colon' },
      { kind: 'whitespace' },
      { kind: 'ident', value: 'b' },
    ]);
  });

  // A number carries its REPRESENTATION and a type flag beside its value.
  // 1 and 1.0 have equal values and differ only in the flag; +1 and 1 differ
  // only in the representation.
  it('keeps a number’s representation and type flag', () => {
    expect(tokenize('1')).toEqual([{ kind: 'number', repr: '1', value: 1, int: true }]);
    expect(tokenize('1.0')).toEqual([{ kind: 'number', repr: '1.0', value: 1, int: false }]);
    expect(tokenize('+1')).toEqual([{ kind: 'number', repr: '+1', value: 1, int: true }]);
  });

  it('distinguishes a dimension from a percentage from a number', () => {
    expect(tokenize('2em')).toEqual([
      { kind: 'dimension', repr: '2', value: 2, int: true, unit: 'em' },
    ]);
    expect(tokenize('50%')).toEqual([
      { kind: 'percentage', repr: '50', value: 50, int: true },
    ]);
  });

  // `url(` is a url-token whose value runs to the paren with no quoting;
  // `url (` is an ident then a function. A tokenizer that treats `url` as a
  // name everywhere is wrong for every unquoted URL.
  it('distinguishes url( from url (', () => {
    expect(tokenize('url(a)')).toEqual([{ kind: 'url', value: 'a' }]);
    expect(tokenize('url (a)')).toEqual([
      { kind: 'ident', value: 'url' },
      { kind: 'whitespace' },
      { kind: 'open', open: '(' },
      { kind: 'ident', value: 'a' },
      { kind: 'close', close: ')' },
    ]);
  });

  it('treats a quoted url as a function', () => {
    expect(tokenize('url("a")')).toEqual([
      { kind: 'function', name: 'url' },
      { kind: 'string', value: 'a' },
      { kind: 'close', close: ')' },
    ]);
  });

  // A bad string ends at the newline that broke it; a bad url consumes to the
  // closing paren. Collapsing either into its good form changes what the rest
  // of the stylesheet parses as.
  it('ends a bad string at the newline and a bad url at the paren', () => {
    expect(tokenize('"a\nb')).toEqual([
      { kind: 'error', code: 'bad-string' },
      { kind: 'whitespace' },
      { kind: 'ident', value: 'b' },
    ]);
    expect(tokenize('url(a"b)c')).toEqual([
      { kind: 'error', code: 'bad-url' },
      { kind: 'ident', value: 'c' },
    ]);
  });

  it('reports eof inside a string and inside a url separately', () => {
    expect(tokenize('"a')).toEqual([{ kind: 'error', code: 'eof-in-string' }]);
    expect(tokenize('url(a')).toEqual([{ kind: 'error', code: 'eof-in-url' }]);
  });

  it('marks a hash id or unrestricted', () => {
    expect(tokenize('#a')).toEqual([{ kind: 'hash', value: 'a', id: true }]);
    expect(tokenize('#1')).toEqual([{ kind: 'hash', value: '1', id: false }]);
  });

  // The corpus's era tokenizes these; the current editor's draft does not.
  // See PROVENANCE.md — this is a decision, not an oversight.
  it('tokenizes the era-specific match and column tokens', () => {
    expect(tokenize('~=')).toEqual([{ kind: 'match', value: '~=' }]);
    expect(tokenize('||')).toEqual([{ kind: 'column' }]);
    expect(tokenize('^=')).toEqual([{ kind: 'match', value: '^=' }]);
  });

  it('tokenizes a unicode range', () => {
    expect(tokenize('U+1')).toEqual([{ kind: 'unicode-range', start: 1, end: 1 }]);
    expect(tokenize('U+1-2')).toEqual([{ kind: 'unicode-range', start: 1, end: 2 }]);
    expect(tokenize('U+1?')).toEqual([{ kind: 'unicode-range', start: 16, end: 31 }]);
  });

  it('resolves an escape in an ident', () => {
    expect(tokenize('\\41')).toEqual([{ kind: 'ident', value: 'A' }]);
  });

  it('strips comments without joining the tokens either side', () => {
    expect(tokenize('a/**/b')).toEqual([
      { kind: 'ident', value: 'a' },
      { kind: 'ident', value: 'b' },
    ]);
  });

  it('never throws, on any input', () => {
    for (const s of ['', '"', 'url(', '\\', '/*', '@', '#', '\\\n', 'U+']) {
      expect(() => tokenize(s)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/csstoken.test.ts`
Expected: FAIL — `../src/csstoken.js` does not exist.

- [ ] **Step 3: Write the tokenizer**

Create `src/csstoken.ts`, transcribing CSS Syntax 3 §4 at
<https://drafts.csswg.org/css-syntax-3/> — but note the **spec era** caveat in
the Global Constraints: keep `unicode-range`, the five match tokens and the
column token, which the current draft has removed. The corpus is the
authority here.

Land the states in this order, running
`npx vitest run test/csstoken.test.ts` as each lands: comments and
whitespace; ident-like (including the `url(` versus `url (` fork); string;
number, dimension and percentage; hash; the match and column tokens;
unicode-range; the brackets, colon, semicolon, comma, CDO and CDC; delim as
the fallthrough.

**One invariant to carry into the code:** consuming a token must always
advance the cursor or reach EOF, the rule `lexer.ts` records for PDF. A token
returned at an unchanged position is an infinite loop rather than a wrong
parse.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/csstoken.test.ts`
Expected: PASS, all 13 assertions.

- [ ] **Step 5: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/csstoken.ts test/csstoken.test.ts
git commit -F - <<'MSG'
feat(zch2.2.1): the CSS tokenizer

CSS Syntax 3 §4 as a literal transcription: 31 token types plus EOF, a pure
string -> CssToken[] function that knows nothing of blocks or rules.

Never throws. Syntax 3 defines a recovery for everything, including the two
failure modes it gives their own token types — bad-string, which ends at the
newline that broke it, and bad-url, which consumes to the closing paren.
Collapsing either into its good form changes what the rest of the stylesheet
parses as. eof-in-string and eof-in-url are separate again, which the corpus
data shows and the corpus README does not mention.

Three rules asserted alone because each is silent when wrong: a number
carries its REPRESENTATION and a type flag beside its value, so 1 and 1.0
differ in the flag and +1 and 1 in the representation; `url(` is a url-token
while `url (` is an ident then a function; and a hash is id or unrestricted.

It emits the seven token types the CORPUS's spec era has and the current
editor's draft does not — unicode-range, the five match tokens and the column
token. That is a decision recorded in PROVENANCE.md, not an oversight.
MSG
```

---

## Task 4: The parser, and the corpus turned on

**Files:**
- Create: `src/cssparse.ts`
- Test: `test/cssparse.test.ts`, `test/css-parsing.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `CssToken` (Task 3); `serializeCss`, `loadCssCases` (Tasks 1–2).
- Produces:
  ```ts
  export type CssValue =
    | CssToken
    | { kind: 'block'; open: '{' | '[' | '('; contents: CssValue[] }
    | { kind: 'function'; name: string; args: CssValue[] };
  export interface CssDeclaration {
    kind: 'declaration'; name: string; value: CssValue[]; important: boolean;
  }
  export interface CssAtRule {
    kind: 'at-rule'; name: string; prelude: CssValue[]; block: CssValue[] | null;
  }
  export interface CssQualifiedRule {
    kind: 'qualified-rule'; prelude: CssValue[]; block: CssValue[];
  }
  export interface CssError { kind: 'error'; code: string; }

  export function parseComponentValueList(css: string): CssValue[];
  export function parseOneComponentValue(css: string): CssValue | CssError;
  export function parseDeclarationList(css: string): (CssDeclaration | CssAtRule | CssError)[];
  export function parseOneDeclaration(css: string): CssDeclaration | CssError;
  export function parseRuleList(css: string): (CssAtRule | CssQualifiedRule | CssError)[];
  export function parseOneRule(css: string): CssAtRule | CssQualifiedRule | CssError;
  export function parseStylesheet(css: string): (CssAtRule | CssQualifiedRule | CssError)[];
  export function parseBlocksContents(css: string):
    (CssDeclaration | CssAtRule | CssQualifiedRule | CssError)[];
  ```

Eight entry points, one per vendored suite. The `function` and `block` shapes
are built HERE from the tokenizer's flat `function`/`open`/`close` tokens.

**Invariant the parser owes the serializer:** no `open` or `close` token ever
reaches parser output. A matched pair becomes a `block` or a `function`; an
unmatched close becomes `{ kind: 'error', code: ')' }` or `']'`, which is what
`component_value_list` expects. The serializer has no case for `open`/`close`
and would pass one through as a raw object, so a leak shows up as a failed
comparison naming the case rather than as silently plausible output.

- [ ] **Step 1: Write the failing hand-built test**

Create `test/cssparse.test.ts`. Every expectation is **copied from the corpus
with its suite and index**, none invented:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseComponentValueList, parseOneComponentValue, parseOneDeclaration,
  parseRuleList, parseStylesheet,
} from '../src/cssparse.js';
import { serializeCss } from './helpers/css-parsing.js';

const s = (v: unknown) => serializeCss(v);

describe('the CSS parser', () => {
  // one_declaration case 0
  it('reports an empty declaration', () => {
    expect(s(parseOneDeclaration(''))).toEqual(['error', 'empty']);
  });

  // one_declaration case 9 — a declaration with an empty value is valid.
  it('parses a declaration with no value', () => {
    expect(s(parseOneDeclaration('foo:'))).toEqual(['declaration', 'foo', [], false]);
  });

  // one_declaration — !important is case-insensitive and the bang may be
  // separated from the word.
  it('reads important case-insensitively', () => {
    const d = parseOneDeclaration('foo: 9000  !Important') as { important: boolean };
    expect(d.important).toBe(true);
  });

  // rule_list case 3 — an at-rule with no block has a null block, not [].
  it('gives an at-rule with no block a null block', () => {
    expect(s(parseRuleList('@foo'))).toEqual([['at-rule', 'foo', [], null]]);
  });

  // rule_list — the prelude ends at the block, and the block's contents are
  // component values.
  it('splits an at-rule prelude from its block', () => {
    expect(s(parseRuleList('@foo bar{'))).toEqual([
      ['at-rule', 'foo', [' ', ['ident', 'bar']], []],
    ]);
  });

  // rule_list — a qualified rule's prelude is everything before the {.
  it('parses a qualified rule', () => {
    expect(s(parseRuleList('a{b:c}'))).toEqual([
      ['qualified rule', [['ident', 'a']], [['ident', 'b'], ':', ['ident', 'c']]],
    ]);
  });

  // component_value_list — nesting is the parser's job; the tokenizer emits
  // flat open and close tokens.
  it('nests blocks and functions', () => {
    expect(s(parseComponentValueList('[(a)]'))).toEqual([['[]', ['()', ['ident', 'a']]]]);
    expect(s(parseComponentValueList('f(a)'))).toEqual([['function', 'f', ['ident', 'a']]]);
  });

  // component_value_list — an unmatched close is an error VALUE, not a throw
  // and not a dropped token.
  it('reports an unmatched close bracket as an error value', () => {
    expect(s(parseComponentValueList(')'))).toEqual([['error', ')']]);
  });

  // one_component_value — an entry point taking ONE value rejects extra input.
  it('rejects extra input at a single-value entry point', () => {
    expect(s(parseOneComponentValue('a b'))).toEqual(['error', 'extra-input']);
  });

  // stylesheet — CDO and CDC are dropped at the top level of a stylesheet
  // and kept everywhere else.
  it('drops CDO and CDC at stylesheet top level but keeps them elsewhere', () => {
    expect(s(parseStylesheet('<!-- -->'))).toEqual([]);
    expect(s(parseComponentValueList('<!-- -->'))).toEqual(['<!--', ' ', '-->']);
  });

  it('never throws, on any input', () => {
    for (const src of ['', '{', '}', '@', 'a{', '"', 'url(', ';;;']) {
      expect(() => parseStylesheet(src)).not.toThrow();
      expect(() => parseComponentValueList(src)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/cssparse.test.ts`
Expected: FAIL — `../src/cssparse.js` does not exist.

- [ ] **Step 3: Write the parser**

Create `src/cssparse.ts`, transcribing CSS Syntax 3 §5. Land in this order:
consume a component value (which recurses into blocks and functions); the
list entry points; consume a declaration; consume a qualified rule and an
at-rule; the four single-item entry points, which share one wrapper that
skips leading whitespace, delegates, then requires EOF or reports
`extra-input`.

To read a real expectation rather than guess one, create this scratch file
and delete it in Step 6:

```ts
// test/_show.test.ts — SCRATCH, delete before committing.
import { it } from 'vitest';
import { loadCssCases, serializeCss } from './helpers/css-parsing.js';
import * as P from '../src/cssparse.js';

const ENTRY: Record<string, (s: string) => unknown> = {
  component_value_list: P.parseComponentValueList,
  one_component_value: P.parseOneComponentValue,
  declaration_list: P.parseDeclarationList,
  one_declaration: P.parseOneDeclaration,
  rule_list: P.parseRuleList,
  one_rule: P.parseOneRule,
  stylesheet: P.parseStylesheet,
  blocks_contents: P.parseBlocksContents,
};

it('show', () => {
  for (const spec of (process.env.SHOW ?? '').split(',').filter((x) => x !== '')) {
    const [suite, i] = spec.split('#');
    const c = loadCssCases([suite as never])[Number(i)];
    if (c === undefined) { console.log(`${spec}: no such case`); continue; }
    console.log(`=== ${spec}`);
    console.log('IN  : ' + JSON.stringify(c.input));
    console.log('WANT: ' + JSON.stringify(c.expected));
    console.log('GOT : ' + JSON.stringify(serializeCss(ENTRY[c.suite](c.input))));
  }
});
```

Run it as `SHOW="component_value_list#38" npx vitest run test/_show.test.ts`.

- [ ] **Step 4: Run the hand-built test to verify it passes**

Run: `npx vitest run test/cssparse.test.ts`
Expected: PASS, all 11 assertions.

- [ ] **Step 5: Turn on the corpus**

Create `test/css-parsing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadCssCases, serializeCss } from './helpers/css-parsing.js';
import type { CssSuite } from './helpers/css-parsing.js';
import * as P from '../src/cssparse.js';

const ENTRY: Record<CssSuite, (src: string) => unknown> = {
  component_value_list: P.parseComponentValueList,
  one_component_value: P.parseOneComponentValue,
  declaration_list: P.parseDeclarationList,
  one_declaration: P.parseOneDeclaration,
  rule_list: P.parseRuleList,
  one_rule: P.parseOneRule,
  stylesheet: P.parseStylesheet,
  blocks_contents: P.parseBlocksContents,
};

describe('css-parsing-tests', () => {
  // No allowlist and no bucket predicate: all 149 cases run. The per-suite
  // counts are asserted in test/css-parsing-suite.test.ts.
  for (const c of loadCssCases()) {
    it(`${c.suite}#${c.index}: ${JSON.stringify(c.input).slice(0, 60)}`, () => {
      expect(serializeCss(ENTRY[c.suite](c.input))).toEqual(c.expected);
    });
  }
});
```

Run: `npx vitest run test/css-parsing.test.ts`
Expected: 149 cases collected. Fix `src/csstoken.ts` and `src/cssparse.ts`
until all pass.

**Never edit a vendored expectation.** If the corpus contradicts this plan
about the spec, the corpus wins and the contradiction gets recorded —
`zch2.1.2`'s `select` finding, `zch2.1.3.1`'s `popUntilName` finding and
`zch2.1.3.2`'s three findings all arrived that way, and this issue's spec-era
finding arrived the same way while the plan was being written.

- [ ] **Step 6: Delete the scratch file and commit**

```bash
rm -f test/_show.test.ts
npm run typecheck
npm test
git add src/cssparse.ts test/cssparse.test.ts test/css-parsing.test.ts
git commit -F - <<'MSG'
feat(zch2.2.1): the component-value parser, and 149 corpus cases green

CSS Syntax 3 §5: eight entry points over the tokenizer's flat tokens, one per
vendored suite. Nesting is built here — the tokenizer emits flat function,
open and close tokens and knows nothing of blocks.

No allowlist and no bucket predicate: every case runs, which is the footing
zch2.1.1's 7,032 tokenizer cases stand on and the reason full implementation
was chosen over a subset.

Three rules asserted alone: an at-rule with no block has a NULL block rather
than an empty one; an unmatched close bracket is an error VALUE rather than a
throw or a dropped token; and CDO/CDC are dropped at a stylesheet's top level
while being kept everywhere else.
MSG
```

---

## Task 5: Mutations, docs, and close

**Files:**
- Modify: `test/fixtures/css-parsing/PROVENANCE.md`, `CLAUDE.md`

- [ ] **Step 1: Run the mutations and record what actually reddens**

Run each against
`npx vitest run test/css-parsing.test.ts test/csstoken.test.ts test/cssparse.test.ts test/css-parsing-suite.test.ts`,
note the count and the suites, then revert:

| # | Mutation | Expected |
|---|---|---|
| 1 | A number's `int` flag always `true` | the `1.0` cases |
| 2 | A number's `repr` replaced by `String(value)` | the `+1` / `01` cases |
| 3 | `bad-string` emitted as `string` | the unterminated-string cases |
| 4 | `bad-url` emitted as `url` | the unterminated-url cases |
| 5 | `url(` tokenized as a function token | every unquoted-url case |
| 6 | CDO/CDC not dropped at stylesheet top level | `stylesheet.json` |
| 7 | An at-rule's empty block emitted as `[]` rather than `null` | `rule_list`, `one_rule` |
| 8 | Escape handling removed from ident consumption | record the count |
| 9 | The match tokens emitted as two delims (the current draft's reading) | `component_value_list` 47, 48 |
| 10 | `unicode-range` emitted as ident + dimension (the current draft's reading) | `component_value_list` 38–46 |

Mutations 9 and 10 exist so that a future reader "fixing" this toward the
current editor's draft reddens something immediately rather than discovering
it later.

- [ ] **Step 2: Write the results into PROVENANCE.md**

Fill `## Mutation results` with the observed suite names and counts, **not the
predictions**. A mutation that reddens nothing is the important result: it
means the corpus does not cover that rule, and it is recorded as an uncovered
gap. **With 149 cases rather than thousands, expect more empty results than
`zch2.1` produced** — that expectation is in the design and confirming or
refuting it is part of this step.

- [ ] **Step 3: Add the CLAUDE.md source-list entry**

Insert immediately after the `htmldom.ts`/`htmlstack.ts`/`htmlforeign.ts`/
`htmltree.ts` entry:

```markdown
- **csstoken.ts**, **cssparse.ts** — CSS Syntax Level 3: the tokenizer (§4)
  and the component-value parser (§5). `csstoken.ts` is a pure
  `string → CssToken[]` function with 31 token types that knows nothing of
  blocks or rules; `cssparse.ts` is eight entry points over those tokens and
  never re-reads a character. Note the direction against `svgcss.ts`, which is
  a much smaller CSS subset for SVG `<style>` elements and shares no code with
  this. Nothing here produces PDF and nothing is exported from `index.ts`.
  **Invariant:** both are pure leaves and neither throws — no `Document`, no
  PDF object, no `node:` import, and no `htmldom.js`. String in, structure
  out. Collecting `<style>` element text is a walk over `HtmlElement` and so
  `zch2.2.3`'s, deliberately not here.
  **Invariant:** a number carries its REPRESENTATION and a type flag beside
  its value. `1` and `1.0` have equal values and differ only in the flag; `+1`
  and `1` differ only in the representation. Dropping either is invisible
  until something distinguishes them.
  **Invariant:** `url(` is a url-token whose value runs to the closing paren
  with no quoting, while `url (` is an ident then a function token. A
  tokenizer that treats `url` as a name everywhere produces a plausible tree
  that is wrong for every unquoted URL.
  **Invariant:** `bad-string` ends at the newline that broke it and `bad-url`
  consumes to the closing paren, and `eof-in-string`/`eof-in-url` are separate
  again. Collapsing any of them into a good token or a generic error changes
  what the rest of the stylesheet parses as — Syntax 3 gives them their own
  kinds precisely so recovery is defined rather than improvised.
  **Invariant, and it is a DECISION rather than an oversight:** the tokenizer
  implements the CORPUS's spec era, not the current editor's draft. It emits
  `unicode-range`, the five match tokens (`~=` `|=` `^=` `$=` `*=`) and the
  column token (`||`), all of which the live draft has removed from the
  tokenizer. Eleven of the 149 vendored cases turn on it. The reasons are in
  `test/fixtures/css-parsing/PROVENANCE.md`; the short version is that it
  keeps the corpus running whole with no bucket, `zch2.9` already records this
  repo following a pinned oracle against a newer spec, and it hands
  `zch2.2.2` an attribute selector as one `^=` token rather than two delims to
  rejoin. Two mutations exist so that "fixing" it reddens immediately.
  **Note on the oracle, and on its LIMITS:** anchored by CourtBouillon's
  `css-parsing-tests`, 149 cases across 8 files, all green with no allowlist.
  That is a real anchor for the token and block model and it is an order of
  magnitude smaller than the HTML corpora — 7,032 tokenizer cases and 1,936
  tree-construction cases. **`zch2.2.2` (selectors) and `zch2.2.3` (the
  cascade) have NO vendored oracle at all**: WPT ships reftests and
  `testharness.js` there, both needing a renderer or a JS engine. Their suites
  are hand-built, so a green build there means our tests agree with our code
  and must not be read as conformance the way this one legitimately can be.
```

Then run the repo's own sweep and confirm it names neither new module:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 4: Add the fixture-table row**

`CLAUDE.md`'s real-world fixture table gains:

```markdown
| `fixtures/css-parsing/` | `PROVENANCE.md` | CSS Syntax 3's conformance corpus, from CourtBouillon — 149 cases in 8 files, all run. Records a SPEC-ERA decision: the corpus still tokenizes `unicode-range` and the match tokens, which the current editor's draft removed, and we follow the corpus. Records two places the corpus README contradicts its own data, where the data wins |
```

- [ ] **Step 5: Run the gates, commit, close, push**

No `CHANGELOG.md` entry: nothing here is user-visible, and CLAUDE.md's
changelog rule is explicit that internal work does not earn one.

```bash
npm run typecheck
npm test
git add -A src test docs CLAUDE.md
git commit -F - <<'MSG'
feat(zch2.2.1): mutations recorded, docs, close

Ten mutations run and recorded in PROVENANCE.md with observed counts rather
than predictions; any that reddened nothing are written down as uncovered.
Two of them exist to make a future "fix" toward the current editor's draft
redden immediately.

No CHANGELOG entry: nothing here is user-visible.
MSG
bd close aspose-pdf-foss-for-ts-zch2.2.1
bd export -o .beads/issues.jsonl
git add .beads && git commit -F - <<'MSG'
chore(beads): close zch2.2.1
MSG
git pull --rebase && git push && git status -sb
```

`git status` must show the branch up to date with origin.

---

## Self-review

**Spec coverage.** The two modules and their purity → Tasks 3 and 4; the
vendored corpus, the eight files and the two deliberate exclusions → Task 1;
the serializer written from the README-plus-data → Task 2; the three
silent-when-wrong rules (number type flag, `url(`, bad-string/bad-url) →
Task 3's assertions and Task 5's mutations 1–5; the spec-era decision →
Global Constraints, Task 3, and mutations 9–10; "no allowlist, no bucket" →
Task 4 Step 5; the honest note about the sibling issues' missing oracle →
Task 5 Step 3.

**Three things the plan settles that the spec did not:**

1. **The tokenizer emits FLAT `function`, `open` and `close` tokens**, and
   nesting is built in `cssparse.ts`. The spec described two modules without
   saying where the tree appears; putting it in the parser is what lets
   `tokenize` stay a pure `string → CssToken[]` with no recursion.
2. **Task 2 defines the serializer's input shapes before Tasks 3 and 4 exist**,
   and those tasks must match. That inversion is deliberate: the serializer is
   written from the corpus rather than from our types, so the corpus gets to
   name the fields.
3. **Eight entry points, one per suite**, including `parseBlocksContents`
   which the spec did not enumerate.

**Known soft spot, flagged rather than hidden:** the hand-built expectations
in Task 4 Step 1 are transcribed from the corpus by eye, and unlike the WPT
plans there is no `.dat` file to diff them against — the corpus is JSON, so a
transcription error looks like a parser bug. If any of those eleven
assertions disagrees with the vendored case of the same name, **the vendored
case wins**; fix the hand-built one and note it.
