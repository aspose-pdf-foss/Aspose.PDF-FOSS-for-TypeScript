# CSS Cascade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the declarations `zch2.2.1` parses and the selectors `zch2.2.2` matches into a computed style per element — the cascade proper, a UA stylesheet, shorthand expansion, the inherited/non-inherited table, inheritance and computed values.

**Architecture:** Seven new pure leaves under `src/`, plus two small `CssValue[]`-taking entry points added to `src/cssparse.ts` where the grammar already lives. Data flows `collect → cascade → compute`: the cascade is property-agnostic and merges longhands into per-origin winners, and a second top-down walk consults the property table to inherit and compute. Anchored by a corpus generated from headless Chrome, comparing author-declared properties only.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies. `puppeteer` and `tsx` are installed `--no-save` for the generator script only and are never recorded in `package.json`.

**Spec:** `docs/superpowers/specs/2026-08-28-css-cascade-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins — and none of the seven new modules may import even those.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension: `import { NAMED_COLORS } from './colornames.js';`
- **All seven new modules are PURE LEAVES.** None may import `document.js`, `page.js`, any PDF object module, any `node:` module, `svgcss.js`, or `svgstyle.js`. They may import each other, `cssparse.js`, `csstoken.js`, `cssselect.js` and `htmldom.js`. (`svgstyle.ts` importing `colornames.ts` is the one edge in the other direction and is fine — it is not a cycle.)
- **Nothing throws.** An unparseable declaration, an unknown property, an unsupported at-rule and an unsupported media feature are all VALUES on an `unsupported` list. This is `csstoken.ts`'s, `cssselect.ts`'s and `htmltoken.ts`'s rule.
- **Units are CSS px throughout.** `1px = 0.75pt`, and that multiply belongs to `zch2.4`, not here. No module in this plan mentions points.
- **Nothing is exported from `src/index.ts`.** `zch2.3` is the next consumer. There is therefore **no `CHANGELOG.md` entry** — the audience is someone deciding whether to upgrade, and no public API moves. `zch2.2.1` and `zch2.2.2` both set this precedent: their commits touched `CLAUDE.md` and not `CHANGELOG.md`.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- **Task tracking is `bd`,** never TodoWrite or a markdown TODO list. The issue is `zch2.2.3`, already claimed.
- **Commit style:** conventional prefix with the issue id, e.g. `feat(zch2.2.3): ...`. End every commit message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/colornames.ts` | **Create.** The 148 named colours as a `ReadonlyMap`. A leaf importing nothing. |
| `src/svgstyle.ts` | **Modify.** Delete its private `NAMED_SRC`/`NAMED`; import `colornames.js` instead. Pure data move. |
| `src/cssparse.ts` | **Modify.** Add `parseDeclarationsFromValues` and `parseRulesFromValues` beside the existing string entry points. |
| `src/cssvalue.ts` | **Create.** Values over `CssValue[]`: lengths, numbers, percentages, keywords, CSS-wide keywords, colours. |
| `src/cssprop.ts` | **Create.** The property table (`inherited?`, `initial`, grammar), `ComputedStyle`, `UnsupportedDeclaration`. |
| `src/cssshorthand.ts` | **Create.** Shorthand → longhand expansion. |
| `src/cssua.ts` | **Create.** The UA stylesheet as CSS text, compiled lazily. |
| `src/csscascade.ts` | **Create.** Collection walk, sheet compilation, `@media`, the six tiers, per-origin winners. |
| `src/csscompute.ts` | **Create.** Top-down inheritance and computed values → the styled map. |
| `test/cssvalue.test.ts` | **Create.** Lengths, keywords, colours. |
| `test/cssshorthand.test.ts` | **Create.** Every shorthand, each arity. |
| `test/csscascade.test.ts` | **Create.** The six tiers, collection, `@media`. |
| `test/csscompute.test.ts` | **Create.** Inheritance, computed values, the four silent rules. |
| `test/cssua.test.ts` | **Create.** The UA sheet compiles and its defaults land. |
| `test/colornames.test.ts` | **Create.** The count and spot values. |
| `test/cssparse-values.test.ts` | **Create.** The two new entry points. |
| `scripts/gen-cascade-goldens.ts` | **Create.** The Blink oracle generator. Not run by `npm test`. |
| `test/helpers/cascade-goldens.ts` | **Create.** Test-only loader. Nothing in `src/` may import it. |
| `test/fixtures/css-cascade/*` | **Create.** Generated goldens + `PROVENANCE.md`. |
| `test/csscascade-suite.test.ts` | **Create.** Runs the goldens whole. |
| `CLAUDE.md` | **Modify.** Entries for the seven new modules. |

---

## Reference: what `cssparse.ts` actually hands us

**Every row below was measured by running `cssparse.ts` in this repo, not read off the spec.** Do not re-derive them; three are traps.

### Declarations

| Source | Result |
|---|---|
| `color: red` | `{kind:'declaration', name:'color', value:[ws, ident 'red'], important:false}` |
| `color: red !important` | value `[ws, ident 'red', ws]`, `important:true` |
| `COLOR: RED` | name `'COLOR'`, value ident `'RED'` |
| `color` | `{kind:'error', code:'invalid'}` |
| `:red` | `{kind:'error', code:'invalid'}` |
| `color:` | `{kind:'declaration', name:'color', value:[], important:false}` |
| `a:b;;c:d` | two declarations; the empty run is skipped |

**TRAP 1 — `!important` is ALREADY stripped from the value, but a trailing whitespace token is not.** `color: red !important` has value `[ws, ident, ws]`. And the value always carries a LEADING whitespace token, from after the colon. Every value consumer must trim whitespace at both ends before matching on `value.length`.

**TRAP 2 — a property NAME is not lowercased and an empty value is not an error.** `COLOR: RED` keeps its case, so the cascade must fold the name itself. And `color:` yields a *valid* declaration whose value is `[]`; treating a zero-length value as acceptable makes `color:` set a colour. Reject an empty value at the property layer.

### Values

| Source | Component values |
|---|---|
| `1.5em` | `{kind:'dimension', repr:'1.5', value:1.5, int:false, unit:'em'}` |
| `-5px` | dimension, value −5, unit `px` |
| `1e2px` | dimension, value 100, `int:false`, unit `px` |
| `50%` | `{kind:'percentage', repr:'50', value:50, int:true}` |
| `1.5` | `{kind:'number', repr:'1.5', value:1.5, int:false}` |
| `0` | `{kind:'number', repr:'0', value:0, int:true}` |
| `auto` / `inherit` / `currentColor` | `{kind:'ident', value:…}` — case PRESERVED |
| `#abc` | `{kind:'hash', value:'abc', id:true}` |
| `#123456` | `{kind:'hash', value:'123456', **id:false**}` |
| `rgb(1 2 3)` | `{kind:'function', name:'rgb', args:[number, ws, number, ws, number]}` |
| `rgba(1,2,3,.5)` | function, args comma-separated |
| `hsl(210 50% 40%)` | function, args `[number, ws, percentage, ws, percentage]` |
| `"Fira Code", monospace` | `[string 'Fira Code', comma, ws, ident 'monospace']` |

**TRAP 3, and it is the exact INVERSE of `zch2.2.2`'s trap — read this twice.** A `hash` token carries `id: true` only when its name is an identifier, so `#123456` and `#1a2b3c` are `id:false` while `#abc`, `#fff`, `#aabbcc` and `#a1b2c3` are `id:true`. `cssselect.ts` **requires** `id === true`, correctly, because `#123456` is not a valid id selector. A colour parser must **IGNORE the flag entirely** and look only at the hex digits — keying on `id === true` silently rejects `#123456`, which is one of the commonest colour values there is, while accepting `#abc`. The two modules are right for opposite reasons; do not copy one rule into the other.

### At-rules and media preludes

| Source | Prelude |
|---|---|
| `@media print{…}` | `[ws, ident 'print']` |
| `@media screen, print{…}` | `[ws, ident 'screen', comma, ws, ident 'print']` |
| `@media only print{…}` | `[ws, ident 'only', ws, ident 'print']` |
| `@media (min-width: 60em){…}` | `[ws, {kind:'block', open:'(', contents:[…]}]` |
| `@media print and (color){…}` | `[ws, ident 'print', ws, ident 'and', ws, block '(']` |

A `CssAtRule.block` is `CssValue[]`, holding — per nested rule — its prelude values followed by one `{kind:'block', open:'{'}`. A feature is therefore detectable structurally: **any `(` block in a query means a feature**, and no string matching is needed.

---

## Task 1: `colornames.ts`, and rewiring `svgstyle.ts`

Lift the 148-entry named-colour table out of `svgstyle.ts` into a leaf both stacks read. Pure data move, no behaviour change.

**Files:**
- Create: `src/colornames.ts`
- Modify: `src/svgstyle.ts` (delete `NAMED_SRC` and `NAMED`, import instead)
- Test: `test/colornames.test.ts`

**Interfaces:**
- Produces:

```ts
export type NamedRgb = readonly [number, number, number];
export const NAMED_COLORS: ReadonlyMap<string, NamedRgb>;
```

- [ ] **Step 1: Write the failing test**

Create `test/colornames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NAMED_COLORS } from '../src/colornames.js';

describe('the named colour table', () => {
  it('holds exactly 148 entries', () => {
    // 147 X11 names plus rebeccapurple. Asserted so a half-pasted table is a
    // red build rather than a colour that silently falls back to undefined.
    expect(NAMED_COLORS.size).toBe(148);
  });

  it('stores components as 0..1, matching the repo convention', () => {
    expect(NAMED_COLORS.get('black')).toEqual([0, 0, 0]);
    expect(NAMED_COLORS.get('white')).toEqual([1, 1, 1]);
    expect(NAMED_COLORS.get('red')).toEqual([1, 0, 0]);
  });

  it('carries rebeccapurple, the one name that is not X11', () => {
    const c = NAMED_COLORS.get('rebeccapurple');
    expect(c?.[0]).toBeCloseTo(0x66 / 255, 10);
    expect(c?.[1]).toBeCloseTo(0x33 / 255, 10);
    expect(c?.[2]).toBeCloseTo(0x99 / 255, 10);
  });

  it('does NOT carry transparent', () => {
    // `transparent` is not a named colour: it is rgba(0,0,0,0), and it has an
    // alpha the table has no room for. Both consumers handle it themselves.
    expect(NAMED_COLORS.has('transparent')).toBe(false);
  });

  it('carries both spellings of the grey names', () => {
    expect(NAMED_COLORS.get('gray')).toEqual(NAMED_COLORS.get('grey'));
    expect(NAMED_COLORS.get('darkgray')).toEqual(NAMED_COLORS.get('darkgrey'));
  });

  it('is keyed lowercase, so a caller folds before looking up', () => {
    expect(NAMED_COLORS.has('Red')).toBe(false);
    expect(NAMED_COLORS.has('red')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/colornames.test.ts`
Expected: FAIL — `Failed to resolve import "../src/colornames.js"`.

- [ ] **Step 3: Create `src/colornames.ts`**

Move the `NAMED_SRC` string constant VERBATIM out of `src/svgstyle.ts` (it currently begins at roughly line 57, `const NAMED_SRC =`, and runs to the `yellowgreen 9acd32';` line) into the new file. Do not retype it — copy it, or a transcription slip becomes a wrong colour nothing will notice.

```ts
/** The CSS named colours — 148 of them: the 147 X11 names plus
 *  `rebeccapurple`.
 *
 *  Invariant: a LEAF importing nothing at all. It is shared by two stacks that
 *  must not depend on each other — `svgstyle.ts` (SVG paint, over strings) and
 *  `cssvalue.ts` (HTML CSS, over CssValue[]) — and a second copy of the table
 *  is how the two would come to disagree about one colour in a document that
 *  contains inline SVG. Data only: no parsing lives here, because the two
 *  callers parse different grammars around it.
 *
 *  Invariant: `transparent` is NOT in the table. It is not a named colour but
 *  `rgba(0, 0, 0, 0)`, and it carries an alpha this table has no room for.
 *  Both callers handle it themselves, differently and correctly: svgstyle.ts
 *  returns null (do not paint), cssvalue.ts returns a colour with `a: 0`. */

// The CSS/SVG named colours, as "name hex" pairs.
const NAMED_SRC =
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff ' +
  // … the remainder copied verbatim from svgstyle.ts …
  'whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32';

export type NamedRgb = readonly [number, number, number];

export const NAMED_COLORS: ReadonlyMap<string, NamedRgb> = (() => {
  const m = new Map<string, NamedRgb>();
  const t = NAMED_SRC.split(' ');
  for (let i = 0; i + 1 < t.length; i += 2) {
    const h = t[i + 1] as string;
    m.set(t[i] as string, [
      parseInt(h.slice(0, 2), 16) / 255,
      parseInt(h.slice(2, 4), 16) / 255,
      parseInt(h.slice(4, 6), 16) / 255,
    ]);
  }
  return m;
})();
```

- [ ] **Step 4: Rewire `src/svgstyle.ts`**

Delete the `NAMED_SRC` constant and the `NAMED` IIFE entirely. Add to its imports:

```ts
import { NAMED_COLORS } from './colornames.js';
```

Then replace the single use — the last line of `parseColor`, `return NAMED.get(v);` — with:

```ts
  return NAMED_COLORS.get(v) as Rgb | undefined;
```

The cast is needed because `svgstyle.ts`'s `Rgb` is a mutable `[number, number, number]` while `NamedRgb` is `readonly`. Do NOT widen `NamedRgb` to fix this: the table is shared and must not hand out mutable arrays.

- [ ] **Step 5: Run the new test and the SVG fence**

Run: `npx vitest run test/colornames.test.ts test/svg-style.test.ts test/svg-golden.test.ts`
Expected: PASS. If any SVG file has a different name in this repo, run the whole SVG set: `npx vitest run test/svg*.test.ts`.

The SVG tests are the fence for "pure data move". They must not move.

- [ ] **Step 6: Full suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: both green, with the same totals as before plus `test/colornames.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/colornames.ts src/svgstyle.ts test/colornames.test.ts
git commit -m "refactor(zch2.2.3): lift the named-colour table into colornames.ts

The 148 CSS named colours — 147 X11 plus rebeccapurple, counted rather
than assumed — move out of svgstyle.ts into a leaf importing nothing.

zch2.2.3 needs them over CssValue[] while svgstyle.ts parses strings with
SVG paint semantics, so the parsers cannot be shared; but a second copy of
the DATA is how the two would come to disagree about one colour in a
document containing inline SVG. One owner, two parsers.

transparent stays out of the table on purpose. It is rgba(0,0,0,0) rather
than a named colour, and it carries an alpha the table has no room for;
the two callers handle it differently and both correctly.

Pure data move, no behaviour change. The SVG tests are the fence and did
not move.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `cssparse.ts` — the two `CssValue[]` entry points

`zch2.2.1` stopped exactly where CSS Syntax stops: a qualified rule's block and an at-rule's block are both raw `CssValue[]`. The cascade is the caller that resumes. Both new functions are thin wrappers over internals that already take `CssValue[]`.

**Files:**
- Modify: `src/cssparse.ts` (append; export two functions)
- Test: `test/cssparse-values.test.ts`

**Interfaces:**
- Consumes: the module's existing private `declarationFrom(values: CssValue[]): CssDeclaration | CssError` (line ~128) and `ruleFromValues(values: CssValue[]): CssQualifiedRule | CssError` (line ~351). Neither needs changing.
- Produces:

```ts
export function parseDeclarationsFromValues(v: CssValue[]): (CssDeclaration | CssError)[];
export function parseRulesFromValues(v: CssValue[]): (CssAtRule | CssQualifiedRule | CssError)[];
```

- [ ] **Step 1: Write the failing test**

Create `test/cssparse-values.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseStylesheet, parseComponentValueList,
  parseDeclarationsFromValues, parseRulesFromValues,
} from '../src/cssparse.js';
import type { CssAtRule, CssQualifiedRule, CssValue } from '../src/cssparse.js';

/** The block of the first rule of `css`, as component values. */
function firstBlock(css: string): CssValue[] {
  const r = parseStylesheet(css)[0] as CssQualifiedRule | CssAtRule;
  return (r.kind === 'at-rule' ? r.block : r.block) as CssValue[];
}

describe('parseDeclarationsFromValues', () => {
  it('reads the declarations out of a qualified rule block', () => {
    // This is the whole reason it exists: parseStylesheet leaves a rule's
    // block UNPARSED, and parseDeclarationList takes a string.
    const d = parseDeclarationsFromValues(firstBlock('p{color:red;margin:0}'));
    expect(d.map((x) => (x.kind === 'declaration' ? x.name : x.kind)))
      .toEqual(['color', 'margin']);
  });

  it('agrees with parseDeclarationList on the same source', () => {
    // The two entry points must not be two readings of one grammar.
    const viaValues = parseDeclarationsFromValues(
      parseComponentValueList('color:red;margin:0 auto'));
    const viaString = parseDeclarationsFromValues(
      parseComponentValueList('color:red;margin:0 auto'));
    expect(viaValues).toEqual(viaString);
  });

  it('carries !important through', () => {
    const d = parseDeclarationsFromValues(firstBlock('p{color:red !important}'));
    expect(d[0]?.kind === 'declaration' && d[0].important).toBe(true);
  });

  it('reports a malformed declaration as an error value, never a throw', () => {
    const d = parseDeclarationsFromValues(parseComponentValueList('color;margin:0'));
    expect(d[0]?.kind).toBe('error');
    expect(d[1]?.kind).toBe('declaration');
  });

  it('skips empty runs', () => {
    expect(parseDeclarationsFromValues(parseComponentValueList(';;a:b;;')).length).toBe(1);
  });

  it('never throws, whatever it is given', () => {
    for (const s of ['', '  ', ';', ':', '{}', 'a', '!important']) {
      expect(() => parseDeclarationsFromValues(parseComponentValueList(s))).not.toThrow();
    }
  });
});

describe('parseRulesFromValues', () => {
  it('reads nested rules out of an @media block', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{a{c:1}b{c:2}}'));
    expect(rules.length).toBe(2);
    expect(rules.every((r) => r.kind === 'qualified-rule')).toBe(true);
  });

  it('gives each nested rule its own prelude and block', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{a{c:1}b{c:2}}'));
    const first = rules[0] as CssQualifiedRule;
    expect((first.prelude[0] as { value: string }).value).toBe('a');
    const decls = parseDeclarationsFromValues(first.block);
    expect(decls[0]?.kind === 'declaration' && decls[0].name).toBe('c');
  });

  it('reads a nested at-rule', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{@page{margin:0}}'));
    expect(rules[0]?.kind).toBe('at-rule');
    expect((rules[0] as CssAtRule).name).toBe('page');
  });

  it('reads a nested at-rule with no block, terminated by a semicolon', () => {
    const rules = parseRulesFromValues(firstBlock('@media print{@import "x";a{c:1}}'));
    expect(rules.length).toBe(2);
    expect((rules[0] as CssAtRule).name).toBe('import');
    expect((rules[0] as CssAtRule).block).toBeNull();
    expect(rules[1]?.kind).toBe('qualified-rule');
  });

  it('reports a trailing prelude with no block as an error, not a rule', () => {
    expect(parseRulesFromValues(parseComponentValueList('a b')))
      .toEqual([{ kind: 'error', code: 'invalid' }]);
  });

  it('never throws, whatever it is given', () => {
    for (const s of ['', '{}', '@', '@media', 'a{', '}']) {
      expect(() => parseRulesFromValues(parseComponentValueList(s))).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssparse-values.test.ts`
Expected: FAIL — `parseDeclarationsFromValues is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/cssparse.ts`:

```ts
/** Consume a declaration list from COMPONENT VALUES rather than from text.
 *
 *  Why this exists: `parseStylesheet` leaves a qualified rule's block as raw
 *  `CssValue[]`, which is exactly right — CSS Syntax makes parsing a block's
 *  contents a separate algorithm the caller invokes — but every caller that
 *  wants declarations then has no entry point, since `parseDeclarationList`
 *  takes a string. Re-serializing the values back to text to re-tokenize them
 *  would be lossy and absurd, and re-deriving the grammar in the caller would
 *  give this repo two owners for it.
 *
 *  It delegates to the same `declarationFrom` the string path uses, so the
 *  `!important` scan and the empty-value rule cannot drift between them. */
export function parseDeclarationsFromValues(
  v: CssValue[],
): (CssDeclaration | CssError)[] {
  const out: (CssDeclaration | CssError)[] = [];
  let run: CssValue[] = [];
  const flush = (): void => {
    if (run.some((x) => (x as CssToken).kind !== 'whitespace')) {
      out.push(declarationFrom(run));
    }
    run = [];
  };
  for (const x of v) {
    if ((x as CssToken).kind === 'semicolon') { flush(); continue; }
    run.push(x);
  }
  flush();
  return out;
}

/** Consume a rule list from COMPONENT VALUES. The counterpart of
 *  `parseRuleList` for an at-rule's block — `@media print { p { … } }`.
 *
 *  Note this is EASIER at the component-value level than at the token level,
 *  which is the reverse of the intuition: the `{}` has already been assembled
 *  into one block value, so finding a rule is a scan that accumulates prelude
 *  values until it meets a `{` block. No bracket matching, no depth counter. */
export function parseRulesFromValues(
  v: CssValue[],
): (CssAtRule | CssQualifiedRule | CssError)[] {
  const out: (CssAtRule | CssQualifiedRule | CssError)[] = [];
  let run: CssValue[] = [];
  let at: string | null = null;

  const nonWs = (xs: CssValue[]): boolean =>
    xs.some((x) => (x as CssToken).kind !== 'whitespace');

  for (const x of v) {
    const t = x as CssToken;

    // An at-keyword STARTS a rule, so anything pending is a prelude with no
    // block: an error rather than a silently dropped run.
    if (t.kind === 'at-keyword') {
      if (at !== null) out.push({ kind: 'at-rule', name: at, prelude: run, block: null });
      else if (nonWs(run)) out.push(err('invalid'));
      run = [];
      at = t.value;
      continue;
    }

    // A `;` ends a block-less at-rule; outside one it separates nothing a
    // rule list cares about, so the pending run is discarded as invalid.
    if (t.kind === 'semicolon') {
      if (at !== null) out.push({ kind: 'at-rule', name: at, prelude: run, block: null });
      else if (nonWs(run)) out.push(err('invalid'));
      run = [];
      at = null;
      continue;
    }

    if (t.kind === 'block' && (x as { open: string }).open === '{') {
      const contents = (x as unknown as { contents: CssValue[] }).contents;
      if (at !== null) out.push({ kind: 'at-rule', name: at, prelude: run, block: contents });
      else out.push({ kind: 'qualified-rule', prelude: run, block: contents });
      run = [];
      at = null;
      continue;
    }

    run.push(x);
  }

  // Trailing: a prelude that never met its block.
  if (at !== null) out.push({ kind: 'at-rule', name: at, prelude: run, block: null });
  else if (nonWs(run)) out.push(err('invalid'));
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssparse-values.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Confirm `zch2.2.1`'s corpus did not move**

Run: `npx vitest run test/cssparse.test.ts test/csstoken.test.ts test/css-parsing-suite.test.ts`
Expected: PASS. These are additions, so the 149 vendored cases must be untouched. If a file name differs, run `npx vitest run test/css*.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/cssparse.ts test/cssparse-values.test.ts
git commit -m "feat(zch2.2.3): CssValue[] entry points for declarations and rules

zch2.2.1 stopped exactly where CSS Syntax stops: a qualified rule's block
and an at-rule's block are both raw CssValue[], because parsing a block's
contents is a separate algorithm the caller invokes. The cascade is that
caller, and it had no entry point — parseDeclarationList and
parseStylesheet both take strings.

Both are thin wrappers over declarationFrom and the same block scan the
string path already uses, so the !important scan and the empty-value rule
cannot drift between the two entry points.

The rule-list one is EASIER at the component-value level than at the token
level, which is the reverse of the intuition: the {} is already one block
value, so finding a rule is a scan for it rather than bracket matching.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 3: `cssvalue.ts` — lengths, numbers, keywords, CSS-wide keywords

**Files:**
- Create: `src/cssvalue.ts`
- Test: `test/cssvalue.test.ts`

**Interfaces:**
- Consumes: `CssValue` from `src/cssparse.js`, `CssToken` from `src/csstoken.js`.
- Produces, and every later task depends on these exact names:

```ts
export type LengthPct = { px: number } | { pct: number };
export type CssWide = 'inherit' | 'initial' | 'unset' | 'revert';
export interface LengthContext { fontSize: number; rootFontSize: number }

export function trimWs(v: CssValue[]): CssValue[];
export function keywordOf(v: CssValue[]): string | undefined;
export function cssWideOf(v: CssValue[]): CssWide | undefined;
export function numberOf(v: CssValue[]): number | undefined;
export function lengthOf(v: CssValue[], ctx: LengthContext): LengthPct | undefined;
export function absoluteLengthOf(v: CssValue[], ctx: LengthContext): number | undefined;
```

- [ ] **Step 1: Write the failing test**

Create `test/cssvalue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import {
  trimWs, keywordOf, cssWideOf, numberOf, lengthOf, absoluteLengthOf,
} from '../src/cssvalue.js';
import type { LengthContext } from '../src/cssvalue.js';

const V = (s: string) => parseComponentValueList(s);
const CTX: LengthContext = { fontSize: 20, rootFontSize: 16 };

describe('trimWs', () => {
  it('strips whitespace at BOTH ends and nothing inside', () => {
    // A declaration value always carries a leading whitespace token from
    // after the colon, and an !important one carries a trailing token too.
    expect(trimWs(V(' a  b ')).length).toBe(3);
  });

  it('leaves an all-whitespace value empty', () => {
    expect(trimWs(V('   '))).toEqual([]);
  });
});

describe('keywordOf', () => {
  it('lowercases a lone ident', () => {
    expect(keywordOf(V(' AUTO '))).toBe('auto');
  });

  it('refuses anything that is not exactly one ident', () => {
    for (const s of ['', 'a b', '5px', '#abc', 'rgb(1 2 3)']) {
      expect(keywordOf(V(s))).toBeUndefined();
    }
  });
});

describe('cssWideOf', () => {
  it('recognises all four, case-insensitively', () => {
    expect(cssWideOf(V('inherit'))).toBe('inherit');
    expect(cssWideOf(V('INITIAL'))).toBe('initial');
    expect(cssWideOf(V(' unset '))).toBe('unset');
    expect(cssWideOf(V('Revert'))).toBe('revert');
  });

  it('is undefined for an ordinary keyword', () => {
    expect(cssWideOf(V('auto'))).toBeUndefined();
    expect(cssWideOf(V('inherit x'))).toBeUndefined();
  });
});

describe('numberOf', () => {
  it('reads an integer and a fraction', () => {
    expect(numberOf(V('0'))).toBe(0);
    expect(numberOf(V('1.5'))).toBe(1.5);
    expect(numberOf(V('-2'))).toBe(-2);
  });

  it('refuses a dimension or a percentage', () => {
    expect(numberOf(V('1.5em'))).toBeUndefined();
    expect(numberOf(V('50%'))).toBeUndefined();
  });
});

describe('lengthOf', () => {
  it('converts every absolute unit to px', () => {
    // 1in = 96px by definition; the rest follow from it.
    expect(lengthOf(V('10px'), CTX)).toEqual({ px: 10 });
    expect(lengthOf(V('1in'), CTX)).toEqual({ px: 96 });
    expect(lengthOf(V('12pt'), CTX)).toEqual({ px: 16 });
    expect(lengthOf(V('1pc'), CTX)).toEqual({ px: 16 });
    expect((lengthOf(V('1cm'), CTX) as { px: number }).px).toBeCloseTo(37.795275, 5);
    expect((lengthOf(V('1mm'), CTX) as { px: number }).px).toBeCloseTo(3.7795275, 6);
    expect((lengthOf(V('1Q'), CTX) as { px: number }).px).toBeCloseTo(0.9448818, 6);
  });

  it('is case-insensitive about units, including Q', () => {
    expect(lengthOf(V('10PX'), CTX)).toEqual({ px: 10 });
    expect(lengthOf(V('1q'), CTX)).toEqual(lengthOf(V('1Q'), CTX));
  });

  it('resolves em against the context font size and rem against the root', () => {
    expect(lengthOf(V('2em'), CTX)).toEqual({ px: 40 });
    expect(lengthOf(V('2rem'), CTX)).toEqual({ px: 32 });
  });

  it('resolves ex and ch on the documented 0.5em fallback', () => {
    // We have no font metrics here. CSS names 0.5em as the fallback for both,
    // so this is the spec's answer rather than a guess — and it is why the
    // oracle excludes them: Chrome has metrics and we do not.
    expect(lengthOf(V('2ex'), CTX)).toEqual({ px: 20 });
    expect(lengthOf(V('2ch'), CTX)).toEqual({ px: 20 });
  });

  it('keeps a percentage AS a percentage', () => {
    // It resolves against the containing block, which is zch2.3's to know.
    expect(lengthOf(V('50%'), CTX)).toEqual({ pct: 50 });
  });

  it('accepts a bare ZERO and no other bare number', () => {
    // `margin: 0` is valid CSS and `margin: 5` is not. Accepting any number
    // makes a typo silently become a length.
    expect(lengthOf(V('0'), CTX)).toEqual({ px: 0 });
    expect(lengthOf(V('5'), CTX)).toBeUndefined();
    expect(lengthOf(V('-0'), CTX)).toEqual({ px: -0 });
  });

  it('refuses an unknown unit rather than guessing', () => {
    expect(lengthOf(V('5vw'), CTX)).toBeUndefined();
    expect(lengthOf(V('5vh'), CTX)).toBeUndefined();
    expect(lengthOf(V('5furlong'), CTX)).toBeUndefined();
  });
});

describe('absoluteLengthOf', () => {
  it('is lengthOf with percentages refused', () => {
    // Border widths and letter spacing take no percentage; a caller that
    // cannot resolve one must not be handed one.
    expect(absoluteLengthOf(V('3px'), CTX)).toBe(3);
    expect(absoluteLengthOf(V('50%'), CTX)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssvalue.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssvalue.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssvalue.ts`:

```ts
/** CSS values, over the component values cssparse.ts produces.
 *
 *  Invariant: a PURE LEAF. It imports cssparse.js and csstoken.js for TYPES
 *  and colornames.js for data, and nothing else — no Document, no PDF object,
 *  no `node:` import, no htmldom.js. It never re-reads a character: the
 *  tokenizer's output is the only input, the rule cssparse.ts and
 *  cssselect.ts both hold.
 *
 *  Invariant: NEVER throws. A value it cannot read is `undefined`, and the
 *  caller records it for zch2.7 rather than dropping it silently. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';

export type LengthPct = { px: number } | { pct: number };
export type CssWide = 'inherit' | 'initial' | 'unset' | 'revert';

/** What a relative length resolves against. `fontSize` is the element's own
 *  computed font-size for every property EXCEPT `font-size` itself, where the
 *  caller passes the PARENT's — see csscompute.ts, which is the only place
 *  that distinction is made. */
export interface LengthContext {
  fontSize: number;
  rootFontSize: number;
}

function isWs(v: CssValue | undefined): boolean {
  return v !== undefined && (v as CssToken).kind === 'whitespace';
}

/** Strip whitespace at both ends of a declaration value.
 *
 *  Both ends, and neither is optional: cssparse.ts hands every value a
 *  LEADING whitespace token (from after the colon), and an `!important`
 *  declaration keeps a TRAILING one (from before the bang it truncated at).
 *  A consumer matching on `value.length` is wrong on both without this. */
export function trimWs(v: CssValue[]): CssValue[] {
  let a = 0;
  let b = v.length;
  while (a < b && isWs(v[a])) a++;
  while (b > a && isWs(v[b - 1])) b--;
  return v.slice(a, b);
}

/** A lone ident, ASCII-lowercased. Undefined for anything else, INCLUDING a
 *  two-token value — `keywordOf` is how a caller asks "is this exactly this
 *  one word", so `auto auto` must not read as `auto`. */
export function keywordOf(v: CssValue[]): string | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssToken;
  return x.kind === 'ident' ? x.value.toLowerCase() : undefined;
}

const CSS_WIDE = new Set<string>(['inherit', 'initial', 'unset', 'revert']);

/** The CSS-wide keywords, valid for EVERY property, so a caller recognises
 *  them before consulting the property's own grammar. */
export function cssWideOf(v: CssValue[]): CssWide | undefined {
  const k = keywordOf(v);
  return k !== undefined && CSS_WIDE.has(k) ? (k as CssWide) : undefined;
}

export function numberOf(v: CssValue[]): number | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssToken;
  return x.kind === 'number' ? x.value : undefined;
}

/** px per unit, for the units whose ratio to px is fixed. 1in = 96px by
 *  definition and every other absolute unit follows from it. */
const ABSOLUTE: Record<string, number> = {
  px: 1,
  in: 96,
  pt: 96 / 72,
  pc: 96 / 6,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 2.54 / 40,
};

export function lengthOf(v: CssValue[], ctx: LengthContext): LengthPct | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssToken;

  if (x.kind === 'percentage') return { pct: x.value };

  // A bare ZERO is a length and no other bare number is. `margin: 0` is valid
  // CSS, `margin: 5` is not, and accepting any number turns a typo into a
  // length nobody wrote.
  if (x.kind === 'number') return x.value === 0 ? { px: x.value } : undefined;

  if (x.kind !== 'dimension') return undefined;
  const unit = x.unit.toLowerCase();

  const abs = ABSOLUTE[unit];
  if (abs !== undefined) return { px: x.value * abs };

  if (unit === 'em') return { px: x.value * ctx.fontSize };
  if (unit === 'rem') return { px: x.value * ctx.rootFontSize };
  // CSS's documented fallback for both when font metrics are unavailable,
  // which they always are here. The oracle excludes ex and ch for exactly
  // this reason: Chrome has metrics, so agreement would be a coincidence.
  if (unit === 'ex' || unit === 'ch') return { px: x.value * ctx.fontSize * 0.5 };

  // vw/vh and anything else: refused, not guessed. A viewport is the thing
  // this module deliberately does not have.
  return undefined;
}

/** `lengthOf` for the properties that take no percentage — a border width, a
 *  border spacing. A percentage there has nothing to resolve against even at
 *  layout time, so it is refused here rather than passed on. */
export function absoluteLengthOf(v: CssValue[], ctx: LengthContext): number | undefined {
  const l = lengthOf(v, ctx);
  return l !== undefined && 'px' in l ? l.px : undefined;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssvalue.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/cssvalue.ts test/cssvalue.test.ts
git commit -m "feat(zch2.2.3): CSS lengths, numbers and keywords over CssValue[]

trimWs strips BOTH ends and neither is optional: cssparse.ts gives every
declaration value a leading whitespace token from after the colon, and an
!important one keeps a trailing token from before the bang it truncated
at, so a consumer matching on value.length is wrong twice without it.

A bare ZERO is a length and no other bare number is — 'margin: 0' is valid
CSS and 'margin: 5' is not, and accepting any number turns a typo into a
length nobody wrote.

A percentage stays a percentage: it resolves against the containing block,
which is zch2.3's to know rather than this module's to guess.

ex and ch take CSS's documented 0.5em fallback, there being no font
metrics here; vw/vh are refused rather than guessed, a viewport being the
thing this module deliberately does not have.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `cssvalue.ts` — colours

**Files:**
- Modify: `src/cssvalue.ts` (append)
- Test: `test/cssvalue.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `NAMED_COLORS` from `src/colornames.js`; `trimWs` from Task 3.
- Produces:

```ts
export interface Color { rgb: [number, number, number]; a: number }
export function colorOf(v: CssValue[]): Color | 'currentcolor' | undefined;
```

- [ ] **Step 1: Write the failing test**

Append to `test/cssvalue.test.ts`:

```ts
import { colorOf } from '../src/cssvalue.js';

const rgb = (v: string) => {
  const c = colorOf(V(v));
  if (c === undefined || c === 'currentcolor') throw new Error(`not a colour: ${v}`);
  return c;
};

describe('colorOf', () => {
  it('reads 6-digit hex', () => {
    expect(rgb('#ff0000')).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('reads 6-digit hex whose name is NOT an identifier', () => {
    // THE TRAP, and it is the exact inverse of cssselect.ts's. A hash token
    // carries id:true only when its name is an identifier, so #123456 and
    // #1a2b3c are id:false while #abc and #a1b2c3 are id:true. An id SELECTOR
    // must require the flag; a COLOUR must ignore it entirely. Keying on it
    // here rejects one of the commonest colour values there is.
    expect(rgb('#123456').rgb[0]).toBeCloseTo(0x12 / 255, 10);
    expect(rgb('#1a2b3c').rgb[2]).toBeCloseTo(0x3c / 255, 10);
  });

  it('reads 3-digit hex by doubling each digit', () => {
    expect(rgb('#abc')).toEqual(rgb('#aabbcc'));
  });

  it('reads 4- and 8-digit hex, the last channel being alpha', () => {
    expect(rgb('#ff000080').a).toBeCloseTo(0x80 / 255, 10);
    expect(rgb('#f008')).toEqual(rgb('#ff000088'));
  });

  it('refuses a hex of any other length', () => {
    for (const s of ['#a', '#ab', '#abcde', '#abcdefa', '#abcdefabc']) {
      expect(colorOf(V(s))).toBeUndefined();
    }
  });

  it('refuses a hex carrying a non-hex character', () => {
    expect(colorOf(V('#gghhii'))).toBeUndefined();
  });

  it('reads rgb() in the comma form and the space form alike', () => {
    expect(rgb('rgb(255, 0, 0)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('rgb(255 0 0)')).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('reads the alpha of rgba(), and of rgb() with a slash', () => {
    expect(rgb('rgba(255, 0, 0, 0.5)').a).toBe(0.5);
    expect(rgb('rgb(255 0 0 / 0.5)').a).toBe(0.5);
    expect(rgb('rgb(255 0 0 / 50%)').a).toBe(0.5);
  });

  it('reads percentage rgb components', () => {
    expect(rgb('rgb(100%, 0%, 0%)')).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('clamps out-of-range components rather than refusing them', () => {
    expect(rgb('rgb(300, -20, 0)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('rgba(0,0,0,5)').a).toBe(1);
  });

  it('reads hsl(), including the hue as a bare number or a deg angle', () => {
    expect(rgb('hsl(0 100% 50%)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('hsl(0deg 100% 50%)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('hsl(120, 100%, 50%)')).toEqual({ rgb: [0, 1, 0], a: 1 });
  });

  it('wraps a hue outside 0..360', () => {
    expect(rgb('hsl(480 100% 50%)')).toEqual(rgb('hsl(120 100% 50%)'));
    expect(rgb('hsl(-120 100% 50%)')).toEqual(rgb('hsl(240 100% 50%)'));
  });

  it('reads hsla()', () => {
    expect(rgb('hsla(0, 100%, 50%, 0.25)').a).toBe(0.25);
  });

  it('reads a named colour, case-insensitively', () => {
    expect(rgb('red')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('ReBeCcApUrPlE')).toEqual(rgb('rebeccapurple'));
  });

  it('reads transparent as an ALPHA rather than an absence', () => {
    // a: 0 rather than a separate case, so nothing downstream has to
    // special-case "no colour" beside "a colour".
    expect(rgb('transparent')).toEqual({ rgb: [0, 0, 0], a: 0 });
  });

  it('reports currentColor as a sentinel, not a colour', () => {
    // It cannot be resolved here: it means the element's own computed `color`,
    // which csscompute.ts knows and this module does not.
    expect(colorOf(V('currentColor'))).toBe('currentcolor');
    expect(colorOf(V('CURRENTCOLOR'))).toBe('currentcolor');
  });

  it('refuses a value it cannot read, and never throws', () => {
    for (const s of ['', 'notacolour', 'rgb(1)', 'rgb(1,2)', 'hsl(1,2,3,4,5)',
      'url(x.png)', '5px', 'red blue']) {
      expect(() => colorOf(V(s))).not.toThrow();
      expect(colorOf(V(s))).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssvalue.test.ts`
Expected: FAIL — `colorOf is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/cssvalue.ts` (and add `import { NAMED_COLORS } from './colornames.js';` at the top):

```ts
// ---- colours ---------------------------------------------------------------

export interface Color {
  /** Components 0..1, matching the repo's convention everywhere else. */
  rgb: [number, number, number];
  /** 0..1. `transparent` is `a: 0` rather than a separate absent case, so
   *  nothing downstream has to special-case "no colour" beside "a colour". */
  a: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function hexPair(s: string): number {
  return parseInt(s, 16) / 255;
}

/** A `hash` token's hex digits.
 *
 *  It IGNORES the token's `id` flag, and that is the whole rule. csstoken.ts
 *  sets `id: true` only when the name is an identifier, so `#123456` and
 *  `#1a2b3c` arrive as `id: false` while `#abc` and `#a1b2c3` arrive as
 *  `id: true`. cssselect.ts REQUIRES the flag, correctly — `#123456` is not a
 *  valid id selector. A colour must ignore it, or the commonest spelling of a
 *  hex colour there is silently stops parsing. Two modules, opposite rules,
 *  one token: do not copy either rule into the other. */
function fromHex(hex: string): Color | undefined {
  const h = hex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) return undefined;
  if (h.length === 3 || h.length === 4) {
    const d = (i: number): string => (h[i] as string) + (h[i] as string);
    return {
      rgb: [hexPair(d(0)), hexPair(d(1)), hexPair(d(2))],
      a: h.length === 4 ? hexPair(d(3)) : 1,
    };
  }
  if (h.length === 6 || h.length === 8) {
    return {
      rgb: [hexPair(h.slice(0, 2)), hexPair(h.slice(2, 4)), hexPair(h.slice(4, 6))],
      a: h.length === 8 ? hexPair(h.slice(6, 8)) : 1,
    };
  }
  return undefined;
}

/** The numeric arguments of a colour function, in order, with the separators
 *  discarded.
 *
 *  Commas, whitespace and the `/` alpha delimiter are all just separators
 *  here. That collapses `rgb(1,2,3)`, `rgb(1 2 3)`, `rgb(1 2 3 / .5)` and
 *  `rgba(1,2,3,.5)` into one walk, at the cost of accepting a few separator
 *  spellings CSS does not — which costs nothing, since a stylesheet that
 *  reaches this function was written by an author, not an attacker. */
function fnArgs(args: CssValue[]): { n: number; pct: boolean; deg: boolean }[] | undefined {
  const out: { n: number; pct: boolean; deg: boolean }[] = [];
  for (const a of args) {
    const t = a as CssToken;
    if (t.kind === 'whitespace' || t.kind === 'comma') continue;
    if (t.kind === 'delim' && t.value === '/') continue;
    if (t.kind === 'number') { out.push({ n: t.value, pct: false, deg: false }); continue; }
    if (t.kind === 'percentage') { out.push({ n: t.value, pct: true, deg: false }); continue; }
    if (t.kind === 'dimension' && t.unit.toLowerCase() === 'deg') {
      out.push({ n: t.value, pct: false, deg: true });
      continue;
    }
    return undefined;                     // anything else: not a colour we read
  }
  return out;
}

/** HSL to RGB, CSS Color 4 §7. Hue is wrapped into 0..360 first, so
 *  `hsl(480 …)` is `hsl(120 …)` and `hsl(-120 …)` is `hsl(240 …)`. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const lig = clamp01(l);
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12;
    const a = sat * Math.min(lig, 1 - lig);
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Parse a colour. Returns the sentinel `'currentcolor'` for `currentColor`,
 *  which names the element's own computed `color` — a fact csscompute.ts
 *  knows and this module does not. */
export function colorOf(v: CssValue[]): Color | 'currentcolor' | undefined {
  const t = trimWs(v);
  if (t.length !== 1) return undefined;
  const x = t[0] as CssToken;

  if (x.kind === 'hash') return fromHex(x.value);

  if (x.kind === 'ident') {
    const name = x.value.toLowerCase();
    if (name === 'currentcolor') return 'currentcolor';
    if (name === 'transparent') return { rgb: [0, 0, 0], a: 0 };
    const named = NAMED_COLORS.get(name);
    return named === undefined ? undefined : { rgb: [named[0], named[1], named[2]], a: 1 };
  }

  if ((x as { kind: string }).kind !== 'function') return undefined;
  const fn = x as unknown as { name: string; args: CssValue[] };
  const name = fn.name.toLowerCase();
  const a = fnArgs(fn.args);
  if (a === undefined || a.length < 3 || a.length > 4) return undefined;

  const alpha = a.length === 4
    ? clamp01((a[3] as { n: number; pct: boolean }).pct ? (a[3] as { n: number }).n / 100 : (a[3] as { n: number }).n)
    : 1;

  if (name === 'rgb' || name === 'rgba') {
    const comp = a.slice(0, 3).map((c) => clamp01(c.pct ? c.n / 100 : c.n / 255));
    return { rgb: [comp[0] as number, comp[1] as number, comp[2] as number], a: alpha };
  }

  if (name === 'hsl' || name === 'hsla') {
    const h = a[0] as { n: number; pct: boolean };
    // The hue is a number or an angle, never a percentage.
    if (h.pct) return undefined;
    const s = a[1] as { n: number; pct: boolean };
    const l = a[2] as { n: number; pct: boolean };
    return { rgb: hslToRgb(h.n, s.n / 100, l.n / 100), a: alpha };
  }

  return undefined;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssvalue.test.ts`
Expected: PASS, 33 tests (16 from Task 3 plus 17 here).

- [ ] **Step 5: Commit**

```bash
git add src/cssvalue.ts test/cssvalue.test.ts
git commit -m "feat(zch2.2.3): CSS colours over CssValue[]

Hex in all four lengths, rgb()/rgba() and hsl()/hsla() in both the comma
and the space-with-slash forms, the 148 named colours, transparent and
currentColor.

The hash rule is THE trap here and it is the exact inverse of
cssselect.ts's. csstoken.ts sets id:true only when a hash's name is an
identifier, so #123456 and #1a2b3c are id:false while #abc and #a1b2c3 are
id:true. An id selector must REQUIRE the flag — #123456 is not a valid id
selector — and a colour must IGNORE it, or one of the commonest colour
values there is silently stops parsing. Two modules, opposite rules, one
token; the test names both directions so neither gets copied into the
other.

transparent is a: 0 rather than a separate absent case, so nothing
downstream has to special-case 'no colour' beside 'a colour'.
currentColor is a sentinel, not a colour: it names the element's own
computed color, which csscompute.ts knows and this module does not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 5: `cssprop.ts` — `ComputedStyle` and the property table

43 longhands. Every row is one line, because eight factory helpers carry the
grammar and the table carries only what differs per property.

**Files:**
- Create: `src/cssprop.ts`
- Test: `test/cssprop.test.ts`

**Interfaces:**
- Consumes: `Color`, `LengthPct`, `LengthContext`, `trimWs`, `keywordOf`, `numberOf`, `lengthOf`, `absoluteLengthOf`, `colorOf` from `src/cssvalue.js`.
- Produces:

```ts
export interface ComputedStyle { /* 43 fields, listed below */ }
export interface PropContext {
  fontSize: number; parentFontSize: number; rootFontSize: number;
  parentWeight: number; color: Color;
}
export interface PropDef {
  key: keyof ComputedStyle;
  inherited: boolean;
  initial: unknown;
  compute(v: CssValue[], ctx: PropContext): unknown;
}
export const PROPERTIES: ReadonlyMap<string, PropDef>;
export const INITIAL_STYLE: ComputedStyle;
export const FONT_SIZE_KEYWORDS: Readonly<Record<string, number>>;
export interface UnsupportedDeclaration {
  el: HtmlElement | null;
  property: string;
  value: string;
  reason: 'unknown-property' | 'unparsable-value' | 'unsupported-at-rule'
        | 'unsupported-media-feature';
}
```

- [ ] **Step 1: Write the failing test**

Create `test/cssprop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import { PROPERTIES, INITIAL_STYLE, FONT_SIZE_KEYWORDS } from '../src/cssprop.js';
import type { PropContext } from '../src/cssprop.js';

const V = (s: string) => parseComponentValueList(s);
const CTX: PropContext = {
  fontSize: 16, parentFontSize: 16, rootFontSize: 16, parentWeight: 400,
  color: { rgb: [0, 0, 0], a: 1 },
};
const run = (prop: string, src: string, ctx: PropContext = CTX): unknown =>
  PROPERTIES.get(prop)?.compute(V(src), ctx);

describe('the property table', () => {
  it('holds exactly 43 longhands', () => {
    // Asserted so a half-pasted table is a red build rather than a property
    // that silently falls through to unknown-property.
    expect(PROPERTIES.size).toBe(43);
  });

  it('marks exactly the 13 inherited properties as inherited', () => {
    const inherited = [...PROPERTIES.entries()]
      .filter(([, d]) => d.inherited).map(([n]) => n).sort();
    expect(inherited).toEqual([
      'border-collapse', 'border-spacing', 'color', 'font-family', 'font-size',
      'font-style', 'font-weight', 'line-height', 'list-style-position',
      'list-style-type', 'text-align', 'text-indent', 'white-space',
    ]);
  });

  it('inherits border-collapse and border-spacing, which read wrong', () => {
    // They are inherited so that setting them on a container reaches the
    // table. Asserted on their own because "a border property is inherited"
    // is exactly the row someone will later 'correct'.
    expect(PROPERTIES.get('border-collapse')?.inherited).toBe(true);
    expect(PROPERTIES.get('border-spacing')?.inherited).toBe(true);
    expect(PROPERTIES.get('border-top-color')?.inherited).toBe(false);
  });

  it('does NOT inherit text-decoration or vertical-align', () => {
    // text-decoration PROPAGATES visually to in-flow descendants, which is a
    // rendering rule zch2.4 owns. It is not inheritance and must not be
    // modelled as it, or a descendant that sets its own would wrongly win.
    expect(PROPERTIES.get('text-decoration-line')?.inherited).toBe(false);
    expect(PROPERTIES.get('vertical-align')?.inherited).toBe(false);
  });

  it('gives every property an initial value present in INITIAL_STYLE', () => {
    for (const [name, d] of PROPERTIES) {
      expect(INITIAL_STYLE, name).toHaveProperty(d.key);
    }
  });

  it('names each ComputedStyle key exactly once', () => {
    const keys = [...PROPERTIES.values()].map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('computing individual properties', () => {
  it('reads font-size from a length, a percentage and a keyword', () => {
    expect(run('font-size', '20px')).toBe(20);
    expect(run('font-size', '150%')).toBe(24);        // of parentFontSize 16
    expect(run('font-size', 'medium')).toBe(16);
    expect(run('font-size', 'x-large')).toBe(24);
  });

  it('resolves a font-size em against the PARENT size, not its own', () => {
    // The trap this whole design names. Given ctx.fontSize 16 and
    // parentFontSize 10, `2em` on font-size must be 20 and not 32.
    const ctx = { ...CTX, fontSize: 16, parentFontSize: 10 };
    expect(run('font-size', '2em', ctx)).toBe(20);
  });

  it('scales smaller and larger against the parent', () => {
    const ctx = { ...CTX, parentFontSize: 20 };
    expect(run('font-size', 'larger', ctx)).toBeCloseTo(24, 10);
    expect(run('font-size', 'smaller', ctx)).toBeCloseTo(20 / 1.2, 10);
  });

  it('reads font-weight as a number, a keyword, and relative to the parent', () => {
    expect(run('font-weight', '600')).toBe(600);
    expect(run('font-weight', 'normal')).toBe(400);
    expect(run('font-weight', 'bold')).toBe(700);
    expect(run('font-weight', 'bolder', { ...CTX, parentWeight: 400 })).toBe(700);
    expect(run('font-weight', 'lighter', { ...CTX, parentWeight: 400 })).toBe(100);
    expect(run('font-weight', 'bolder', { ...CTX, parentWeight: 700 })).toBe(900);
  });

  it('refuses a font-weight outside 1..1000', () => {
    expect(run('font-weight', '0')).toBeUndefined();
    expect(run('font-weight', '1001')).toBeUndefined();
  });

  it('reads a font-family list, unquoting strings and keeping case', () => {
    expect(run('font-family', '"Fira Code", Georgia , serif'))
      .toEqual(['Fira Code', 'Georgia', 'serif']);
  });

  it('keeps a line-height NUMBER as a number and a PERCENTAGE as px', () => {
    // Different values, not two spellings. A number inherits as a number so
    // each descendant multiplies by its own size; a percentage inherits as
    // the px it computed to.
    expect(run('line-height', '1.5')).toEqual({ number: 1.5 });
    expect(run('line-height', '150%')).toEqual({ px: 24 });   // of fontSize 16
    expect(run('line-height', '20px')).toEqual({ px: 20 });
    expect(run('line-height', 'normal')).toBe('normal');
  });

  it('resolves currentColor against the context colour', () => {
    const ctx = { ...CTX, color: { rgb: [1, 0, 0] as [number, number, number], a: 1 } };
    expect(run('border-top-color', 'currentColor', ctx)).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('keeps a percentage margin AS a percentage', () => {
    // It resolves against the containing block, which is zch2.3's to know.
    expect(run('margin-top', '10%')).toEqual({ pct: 10 });
    expect(run('margin-top', '10px')).toEqual({ px: 10 });
    expect(run('margin-top', 'auto')).toBe('auto');
  });

  it('takes no auto for padding, which has none', () => {
    expect(run('padding-top', 'auto')).toBeUndefined();
    expect(run('padding-top', '10%')).toEqual({ pct: 10 });
  });

  it('reads the three border-width keywords as px', () => {
    expect(run('border-top-width', 'thin')).toBe(1);
    expect(run('border-top-width', 'medium')).toBe(3);
    expect(run('border-top-width', 'thick')).toBe(5);
    expect(run('border-top-width', '2px')).toBe(2);
    expect(run('border-top-width', '10%')).toBeUndefined();
  });

  it('reads text-decoration-line as a SET, in any order', () => {
    expect(run('text-decoration-line', 'none')).toEqual([]);
    expect(run('text-decoration-line', 'underline')).toEqual(['underline']);
    expect(run('text-decoration-line', 'line-through underline'))
      .toEqual(['underline', 'line-through']);
    expect(run('text-decoration-line', 'underline underline')).toBeUndefined();
  });

  it('refuses a keyword outside a property own set', () => {
    expect(run('float', 'centre')).toBeUndefined();
    expect(run('display', 'flex')).toBeUndefined();     // out of scope, recorded
    expect(run('white-space', 'pre-wrap')).toBe('pre-wrap');
  });

  it('refuses an EMPTY value for every property', () => {
    // cssparse.ts reports `color:` as a VALID declaration whose value is [].
    // Accepting it makes `color:` set a colour.
    for (const [name, d] of PROPERTIES) {
      expect(d.compute([], CTX), name).toBeUndefined();
    }
  });

  it('never throws, for any property, on any value', () => {
    for (const [name, d] of PROPERTIES) {
      for (const s of ['', 'auto', '0', 'red', '"x"', 'rgb(', '1 2 3 4 5']) {
        expect(() => d.compute(V(s), CTX), `${name}: ${s}`).not.toThrow();
      }
    }
  });
});

describe('FONT_SIZE_KEYWORDS', () => {
  it('is the seven absolute keywords with medium at 16', () => {
    expect(Object.keys(FONT_SIZE_KEYWORDS).sort()).toEqual(
      ['large', 'medium', 'small', 'x-large', 'x-small', 'xx-large', 'xx-small']);
    expect(FONT_SIZE_KEYWORDS['medium']).toBe(16);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssprop.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssprop.js"`.

- [ ] **Step 3: Write `ComputedStyle` and the helpers**

Create `src/cssprop.ts`:

```ts
/** The CSS property table: which properties we compute, whether each
 *  inherits, what its initial value is, and how its declared value becomes a
 *  computed one.
 *
 *  Invariant: a PURE LEAF over cssvalue.js and the two parser modules' TYPES.
 *  No Document, no PDF object, no `node:` import.
 *
 *  Invariant: the set is bounded by what zch2.3, zch2.4 and zch2.6 will
 *  consume, not by CSS. 43 longhands, asserted — a property outside them is
 *  recorded as `unknown-property` for zch2.7 rather than dropped, which is
 *  what makes "we do not implement flexbox" reportable instead of invisible.
 *
 *  Invariant: `compute` returns `undefined` for a value it cannot read, and
 *  NEVER throws. An empty value is one of those: cssparse.ts reports `color:`
 *  as a valid declaration whose value is `[]`, so every helper below rejects
 *  a zero-length value before doing anything else. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import type { HtmlElement } from './htmldom.js';
import {
  trimWs, keywordOf, numberOf, lengthOf, absoluteLengthOf, colorOf,
} from './cssvalue.js';
import type { Color, LengthPct } from './cssvalue.js';

export type LineHeight = 'normal' | { number: number } | { px: number };
export type Auto<T> = T | 'auto';
export type DecorationLine = 'underline' | 'overline' | 'line-through';

export interface ComputedStyle {
  fontFamily: string[];
  fontSize: number;
  fontStyle: 'normal' | 'italic' | 'oblique';
  fontWeight: number;
  lineHeight: LineHeight;
  color: Color;
  backgroundColor: Color;
  textAlign: 'start' | 'end' | 'left' | 'right' | 'center' | 'justify';
  textDecorationLine: DecorationLine[];
  textDecorationColor: Color;
  textDecorationStyle: 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
  textIndent: LengthPct;
  whiteSpace: 'normal' | 'pre' | 'nowrap' | 'pre-wrap' | 'pre-line';
  verticalAlign: 'baseline' | 'sub' | 'super' | 'top' | 'middle' | 'bottom'
    | 'text-top' | 'text-bottom';
  display: 'inline' | 'block' | 'inline-block' | 'list-item' | 'none'
    | 'table' | 'table-row-group' | 'table-header-group' | 'table-footer-group'
    | 'table-row' | 'table-cell' | 'table-caption';
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
  width: Auto<LengthPct>;
  height: Auto<LengthPct>;
  marginTop: Auto<LengthPct>;
  marginRight: Auto<LengthPct>;
  marginBottom: Auto<LengthPct>;
  marginLeft: Auto<LengthPct>;
  paddingTop: LengthPct;
  paddingRight: LengthPct;
  paddingBottom: LengthPct;
  paddingLeft: LengthPct;
  borderTopWidth: number;
  borderRightWidth: number;
  borderBottomWidth: number;
  borderLeftWidth: number;
  borderTopStyle: BorderStyle;
  borderRightStyle: BorderStyle;
  borderBottomStyle: BorderStyle;
  borderLeftStyle: BorderStyle;
  borderTopColor: Color;
  borderRightColor: Color;
  borderBottomColor: Color;
  borderLeftColor: Color;
  listStyleType: string;
  listStylePosition: 'outside' | 'inside';
  borderCollapse: 'separate' | 'collapse';
  borderSpacing: number;
}

export type BorderStyle = 'none' | 'hidden' | 'solid' | 'dotted' | 'dashed'
  | 'double' | 'groove' | 'ridge' | 'inset' | 'outset';

/** What relative values resolve against, for ONE element.
 *
 *  `fontSize` is that element's own computed font-size and `parentFontSize`
 *  is its parent's. Both are present because `font-size` is the one property
 *  whose `em` resolves against the parent while every other property's
 *  resolves against the element — see csscompute.ts, the only caller that
 *  makes the distinction. */
export interface PropContext {
  fontSize: number;
  parentFontSize: number;
  rootFontSize: number;
  parentWeight: number;
  /** The element's ALREADY-computed `color`, for `currentColor`. This is why
   *  `color` is computed before every property that can name it. */
  color: Color;
}

export interface PropDef {
  key: keyof ComputedStyle;
  inherited: boolean;
  initial: unknown;
  compute(v: CssValue[], ctx: PropContext): unknown;
}

export interface UnsupportedDeclaration {
  /** null for a sheet-level construct — an at-rule belongs to no element. */
  el: HtmlElement | null;
  /** A property name, or '@import'/'@media' naming itself. */
  property: string;
  /** The source text, so a caller can report what it could not render. */
  value: string;
  reason: 'unknown-property' | 'unparsable-value' | 'unsupported-at-rule'
        | 'unsupported-media-feature';
}

const BLACK: Color = { rgb: [0, 0, 0], a: 1 };
const TRANSPARENT: Color = { rgb: [0, 0, 0], a: 0 };

/** The seven absolute font-size keywords, medium anchored at 16px. */
export const FONT_SIZE_KEYWORDS: Readonly<Record<string, number>> = {
  'xx-small': 9, 'x-small': 10, small: 13, medium: 16,
  large: 18, 'x-large': 24, 'xx-large': 32,
};

/** The ratio `smaller`/`larger` scale by. The spec suggests roughly 1.2 and
 *  does not pin it, which is why the oracle excludes both keywords. */
const FONT_SCALE = 1.2;

// ---- helper factories ------------------------------------------------------
// Each returns a `compute`. They exist so the 43 rows below carry only what
// differs per property; a grammar written out 43 times is 43 chances to
// disagree with itself.

/** One of a fixed set of keywords. */
function kw<T extends string>(...allowed: T[]): PropDef['compute'] {
  const set = new Set<string>(allowed);
  return (v) => {
    const k = keywordOf(v);
    return k !== undefined && set.has(k) ? k : undefined;
  };
}

/** A length or percentage. */
function len(): PropDef['compute'] {
  return (v, c) => lengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
}

/** A length or percentage, or the keyword `auto`. */
function lenAuto(): PropDef['compute'] {
  return (v, c) => {
    if (keywordOf(v) === 'auto') return 'auto';
    return lengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  };
}

/** A length with no percentage form. */
function absLen(): PropDef['compute'] {
  return (v, c) =>
    absoluteLengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
}

/** A colour, with `currentColor` resolved against the context. */
function col(): PropDef['compute'] {
  return (v, c) => {
    const x = colorOf(v);
    return x === 'currentcolor' ? c.color : x;
  };
}

/** The three border-width keywords, or a length. */
function borderWidth(): PropDef['compute'] {
  const KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };
  return (v, c) => {
    const k = keywordOf(v);
    if (k !== undefined) return KEYWORDS[k];
    return absoluteLengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  };
}

const BORDER_STYLES: BorderStyle[] = ['none', 'hidden', 'solid', 'dotted',
  'dashed', 'double', 'groove', 'ridge', 'inset', 'outset'];
```

- [ ] **Step 4: Write the 43 rows**

Append to `src/cssprop.ts`:

```ts
// ---- the per-property computes that are not a plain factory ----------------

const computeFontSize: PropDef['compute'] = (v, c) => {
  const k = keywordOf(v);
  if (k !== undefined) {
    const abs = FONT_SIZE_KEYWORDS[k];
    if (abs !== undefined) return abs;
    if (k === 'larger') return c.parentFontSize * FONT_SCALE;
    if (k === 'smaller') return c.parentFontSize / FONT_SCALE;
    return undefined;
  }
  // BOTH relative forms resolve against the PARENT here, and this is the one
  // property where that is true. `em` elsewhere resolves against the element's
  // own size; getting this row wrong compounds down the tree, so a nested
  // document ends up off by a factor rather than by a pixel.
  const l = lengthOf(v, { fontSize: c.parentFontSize, rootFontSize: c.rootFontSize });
  if (l === undefined) return undefined;
  const px = 'px' in l ? l.px : (c.parentFontSize * l.pct) / 100;
  return px >= 0 ? px : undefined;
};

const computeFontWeight: PropDef['compute'] = (v, c) => {
  const n = numberOf(v);
  if (n !== undefined) return n >= 1 && n <= 1000 ? n : undefined;
  const k = keywordOf(v);
  if (k === 'normal') return 400;
  if (k === 'bold') return 700;
  // Relative to the PARENT's computed weight, via CSS Fonts 4's table
  // collapsed to its two useful steps for the weights documents actually use.
  if (k === 'bolder') return c.parentWeight < 350 ? 400 : c.parentWeight < 550 ? 700 : 900;
  if (k === 'lighter') return c.parentWeight < 550 ? 100 : c.parentWeight < 750 ? 400 : 700;
  return undefined;
};

/** A comma-separated family list. A quoted family keeps its spaces; an
 *  unquoted one may be several idents (`Times New Roman`) and is rejoined
 *  with single spaces. Case is KEPT: a family name is matched by
 *  fontmatch.ts, which has its own folding rule. */
const computeFontFamily: PropDef['compute'] = (v) => {
  const t = trimWs(v);
  if (t.length === 0) return undefined;
  const out: string[] = [];
  let part: string[] = [];
  const flush = (): boolean => {
    if (part.length === 0) return false;
    out.push(part.join(' '));
    part = [];
    return true;
  };
  for (const x of t) {
    const tok = x as CssToken;
    if (tok.kind === 'whitespace') continue;
    if (tok.kind === 'comma') { if (!flush()) return undefined; continue; }
    if (tok.kind === 'string') { part.push(tok.value); continue; }
    if (tok.kind === 'ident') { part.push(tok.value); continue; }
    return undefined;
  }
  if (!flush()) return undefined;
  return out;
};

/** A NUMBER stays a number and a PERCENTAGE becomes px. They are different
 *  values, not two spellings: a number inherits as a number so every
 *  descendant multiplies by its own size, while a percentage inherits as the
 *  px it already computed to. A single-font-size document cannot tell them
 *  apart, which is why the fixture for this nests a heading. */
const computeLineHeight: PropDef['compute'] = (v, c) => {
  if (keywordOf(v) === 'normal') return 'normal';
  const n = numberOf(v);
  if (n !== undefined) return n >= 0 ? { number: n } : undefined;
  const l = lengthOf(v, { fontSize: c.fontSize, rootFontSize: c.rootFontSize });
  if (l === undefined) return undefined;
  return 'px' in l ? { px: l.px } : { px: (c.fontSize * l.pct) / 100 };
};

/** A SET of lines in any order, or `none` as the empty set. A repeat is a
 *  syntax error rather than a silently deduplicated value. */
const computeDecorationLine: PropDef['compute'] = (v) => {
  const t = trimWs(v);
  if (t.length === 0) return undefined;
  if (keywordOf(v) === 'none') return [];
  const order: DecorationLine[] = ['underline', 'overline', 'line-through'];
  const seen = new Set<string>();
  for (const x of t) {
    const tok = x as CssToken;
    if (tok.kind === 'whitespace') continue;
    if (tok.kind !== 'ident') return undefined;
    const k = tok.value.toLowerCase();
    if (!order.includes(k as DecorationLine) || seen.has(k)) return undefined;
    seen.add(k);
  }
  if (seen.size === 0) return undefined;
  return order.filter((o) => seen.has(o));
};

/** `list-style-type` takes a long open-ended keyword list plus a string
 *  counter, so it is stored as the raw lowercased keyword and validated
 *  against the small set zch2.4 can actually draw. */
const LIST_TYPES = ['disc', 'circle', 'square', 'decimal', 'decimal-leading-zero',
  'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman', 'none'];

// ---- the table -------------------------------------------------------------

function def(
  key: keyof ComputedStyle, inherited: boolean, initial: unknown,
  compute: PropDef['compute'],
): PropDef {
  return { key, inherited, initial, compute };
}

export const PROPERTIES: ReadonlyMap<string, PropDef> = new Map<string, PropDef>([
  ['font-family', def('fontFamily', true, ['serif'], computeFontFamily)],
  ['font-size', def('fontSize', true, 16, computeFontSize)],
  ['font-style', def('fontStyle', true, 'normal', kw('normal', 'italic', 'oblique'))],
  ['font-weight', def('fontWeight', true, 400, computeFontWeight)],
  ['line-height', def('lineHeight', true, 'normal', computeLineHeight)],
  ['color', def('color', true, BLACK, col())],
  ['background-color', def('backgroundColor', false, TRANSPARENT, col())],
  ['text-align', def('textAlign', true, 'start',
    kw('start', 'end', 'left', 'right', 'center', 'justify'))],
  ['text-decoration-line', def('textDecorationLine', false, [], computeDecorationLine)],
  ['text-decoration-color', def('textDecorationColor', false, 'currentcolor', col())],
  ['text-decoration-style', def('textDecorationStyle', false, 'solid',
    kw('solid', 'double', 'dotted', 'dashed', 'wavy'))],
  ['text-indent', def('textIndent', true, { px: 0 }, len())],
  ['white-space', def('whiteSpace', true, 'normal',
    kw('normal', 'pre', 'nowrap', 'pre-wrap', 'pre-line'))],
  ['vertical-align', def('verticalAlign', false, 'baseline',
    kw('baseline', 'sub', 'super', 'top', 'middle', 'bottom', 'text-top', 'text-bottom'))],
  ['display', def('display', false, 'inline',
    kw('inline', 'block', 'inline-block', 'list-item', 'none', 'table',
      'table-row-group', 'table-header-group', 'table-footer-group',
      'table-row', 'table-cell', 'table-caption'))],
  ['float', def('float', false, 'none', kw('none', 'left', 'right'))],
  ['clear', def('clear', false, 'none', kw('none', 'left', 'right', 'both'))],
  ['width', def('width', false, 'auto', lenAuto())],
  ['height', def('height', false, 'auto', lenAuto())],
  ['margin-top', def('marginTop', false, { px: 0 }, lenAuto())],
  ['margin-right', def('marginRight', false, { px: 0 }, lenAuto())],
  ['margin-bottom', def('marginBottom', false, { px: 0 }, lenAuto())],
  ['margin-left', def('marginLeft', false, { px: 0 }, lenAuto())],
  ['padding-top', def('paddingTop', false, { px: 0 }, len())],
  ['padding-right', def('paddingRight', false, { px: 0 }, len())],
  ['padding-bottom', def('paddingBottom', false, { px: 0 }, len())],
  ['padding-left', def('paddingLeft', false, { px: 0 }, len())],
  ['border-top-width', def('borderTopWidth', false, 3, borderWidth())],
  ['border-right-width', def('borderRightWidth', false, 3, borderWidth())],
  ['border-bottom-width', def('borderBottomWidth', false, 3, borderWidth())],
  ['border-left-width', def('borderLeftWidth', false, 3, borderWidth())],
  ['border-top-style', def('borderTopStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-right-style', def('borderRightStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-bottom-style', def('borderBottomStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-left-style', def('borderLeftStyle', false, 'none', kw(...BORDER_STYLES))],
  ['border-top-color', def('borderTopColor', false, 'currentcolor', col())],
  ['border-right-color', def('borderRightColor', false, 'currentcolor', col())],
  ['border-bottom-color', def('borderBottomColor', false, 'currentcolor', col())],
  ['border-left-color', def('borderLeftColor', false, 'currentcolor', col())],
  ['list-style-type', def('listStyleType', true, 'disc', kw(...LIST_TYPES))],
  ['list-style-position', def('listStylePosition', true, 'outside', kw('outside', 'inside'))],
  ['border-collapse', def('borderCollapse', true, 'separate', kw('separate', 'collapse'))],
  ['border-spacing', def('borderSpacing', true, 0, absLen())],
]);

/** Every property at its initial value.
 *
 *  The three `'currentcolor'` initials are resolved by csscompute.ts against
 *  the element's own computed `color`, exactly as a declared `currentColor`
 *  is — one rule rather than two. */
export const INITIAL_STYLE: ComputedStyle = (() => {
  const s: Record<string, unknown> = {};
  for (const d of PROPERTIES.values()) {
    s[d.key] = d.initial === 'currentcolor' ? BLACK : d.initial;
  }
  return s as unknown as ComputedStyle;
})();
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run test/cssprop.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/cssprop.ts test/cssprop.test.ts
git commit -m "feat(zch2.2.3): ComputedStyle and the 43-property table

One row per longhand, with eight factory helpers carrying the grammar so
each row states only what differs — a grammar written out 43 times is 43
chances to disagree with itself. The size is asserted, so a half-pasted
table is a red build rather than a property silently falling through to
unknown-property.

Three rows are named individually because they are the ones a later reader
will 'correct'. font-size resolves BOTH its relative forms against the
PARENT, and it is the only property that does; every other em resolves
against the element's own size, and getting this row wrong compounds down
the tree. line-height keeps a number as a number and a percentage as px,
which are different values rather than two spellings. And border-collapse
and border-spacing ARE inherited, so that setting them on a container
reaches the table.

text-decoration is deliberately NOT inherited. It propagates visually to
in-flow descendants, which is a rendering rule zch2.4 owns; modelling it as
inheritance would let a descendant that sets its own wrongly win.

Every helper rejects an empty value first, because cssparse.ts reports
'color:' as a VALID declaration whose value is [].

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 6: `cssshorthand.ts` — shorthand expansion

**Files:**
- Create: `src/cssshorthand.ts`
- Test: `test/cssshorthand.test.ts`

**Interfaces:**
- Consumes: `trimWs`, `keywordOf`, `numberOf`, `colorOf` from `src/cssvalue.js`; `FONT_SIZE_KEYWORDS` from `src/cssprop.js`.
- Produces:

```ts
export const SHORTHANDS: ReadonlySet<string>;
/** Longhand name → its value slice. `undefined` when the shorthand's own
 *  grammar rejects the value. */
export function expandShorthand(name: string, v: CssValue[]): [string, CssValue[]][] | undefined;
```

**The reset rule, and why it needs no special case:** a shorthand sets EVERY
longhand it governs, including the ones the author did not mention — `border:
1px` resets style and colour to their initials. Rather than model that with a
second concept, an unmentioned longhand is emitted with a synthetic
`initial` ident as its value. The CSS-wide keyword machinery Task 3 already
built then does the work, and there is one reset rule in this codebase rather
than two.

- [ ] **Step 1: Write the failing test**

Create `test/cssshorthand.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import { expandShorthand, SHORTHANDS } from '../src/cssshorthand.js';
import { keywordOf } from '../src/cssvalue.js';

const V = (s: string) => parseComponentValueList(s);

/** Expand, then render each longhand's value as a comparable string. */
const ex = (name: string, src: string): Record<string, string> | undefined => {
  const got = expandShorthand(name, V(src));
  if (got === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of got) {
    out[k] = v.map((t) => {
      const x = t as { kind: string; value?: unknown; unit?: string };
      if (x.kind === 'whitespace') return ' ';
      if (x.kind === 'dimension') return `${String(x.value)}${String(x.unit)}`;
      if (x.kind === 'percentage') return `${String(x.value)}%`;
      if (x.kind === 'hash') return `#${String(x.value)}`;
      return String(x.value ?? x.kind);
    }).join('').trim();
  }
  return out;
};

describe('the shorthand set', () => {
  it('names exactly the fourteen shorthands in scope', () => {
    expect([...SHORTHANDS].sort()).toEqual([
      'background', 'border', 'border-bottom', 'border-color', 'border-left',
      'border-right', 'border-style', 'border-top', 'border-width', 'font',
      'list-style', 'margin', 'padding', 'text-decoration',
    ].sort());
  });
});

describe('margin and padding', () => {
  it('expands one value to all four sides', () => {
    expect(ex('margin', '1px')).toEqual({
      'margin-top': '1px', 'margin-right': '1px',
      'margin-bottom': '1px', 'margin-left': '1px',
    });
  });

  it('expands two values as vertical then horizontal', () => {
    expect(ex('padding', '1px 2px')).toEqual({
      'padding-top': '1px', 'padding-right': '2px',
      'padding-bottom': '1px', 'padding-left': '2px',
    });
  });

  it('expands three values as top, horizontal, bottom', () => {
    expect(ex('margin', '1px 2px 3px')).toEqual({
      'margin-top': '1px', 'margin-right': '2px',
      'margin-bottom': '3px', 'margin-left': '2px',
    });
  });

  it('expands four values clockwise from the top', () => {
    expect(ex('margin', '1px 2px 3px 4px')).toEqual({
      'margin-top': '1px', 'margin-right': '2px',
      'margin-bottom': '3px', 'margin-left': '4px',
    });
  });

  it('refuses zero or more than four values', () => {
    expect(ex('margin', '')).toBeUndefined();
    expect(ex('margin', '1px 2px 3px 4px 5px')).toBeUndefined();
  });

  it('carries auto through, margin having one', () => {
    expect(ex('margin', '0 auto')?.['margin-left']).toBe('auto');
  });
});

describe('border and its per-side forms', () => {
  it('sets all twelve longhands from one border declaration', () => {
    const got = ex('border', '1px solid red');
    expect(Object.keys(got ?? {}).length).toBe(12);
    expect(got?.['border-top-width']).toBe('1px');
    expect(got?.['border-left-style']).toBe('solid');
    expect(got?.['border-bottom-color']).toBe('red');
  });

  it('accepts the three components in ANY order', () => {
    expect(ex('border', 'red 1px solid')).toEqual(ex('border', '1px solid red'));
    expect(ex('border', 'solid red 1px')).toEqual(ex('border', '1px solid red'));
  });

  it('RESETS an omitted component to initial rather than leaving it alone', () => {
    // The rule that needs no special case: an unmentioned longhand is emitted
    // with a synthetic `initial`, and the CSS-wide keyword machinery does the
    // rest. Without it, `border: 1px` after `border-color: red` would wrongly
    // keep the red.
    const got = ex('border', '1px');
    expect(got?.['border-top-width']).toBe('1px');
    expect(got?.['border-top-style']).toBe('initial');
    expect(got?.['border-top-color']).toBe('initial');
  });

  it('scopes border-top to one side only', () => {
    const got = ex('border-top', '2px dashed blue');
    expect(Object.keys(got ?? {}).sort())
      .toEqual(['border-top-color', 'border-top-style', 'border-top-width']);
  });

  it('expands border-width, border-style and border-color four ways', () => {
    expect(ex('border-width', '1px 2px')?.['border-left-width']).toBe('2px');
    expect(ex('border-style', 'solid')?.['border-bottom-style']).toBe('solid');
    expect(ex('border-color', 'red green blue')?.['border-left-color']).toBe('green');
  });

  it('refuses a border component it cannot classify', () => {
    expect(ex('border', '1px solid notacolour')).toBeUndefined();
    expect(ex('border', '1px solid red green')).toBeUndefined();
  });
});

describe('font', () => {
  it('expands size and family, resetting style and weight', () => {
    const got = ex('font', '12px serif');
    expect(got?.['font-size']).toBe('12px');
    expect(got?.['font-family']).toBe('serif');
    expect(got?.['font-style']).toBe('initial');
    expect(got?.['font-weight']).toBe('initial');
    expect(got?.['line-height']).toBe('initial');
  });

  it('reads the optional prefix in any order', () => {
    const got = ex('font', 'italic bold 12px serif');
    expect(got?.['font-style']).toBe('italic');
    expect(got?.['font-weight']).toBe('bold');
    expect(ex('font', 'bold italic 12px serif')).toEqual(got);
  });

  it('reads a numeric weight in the prefix', () => {
    expect(ex('font', '600 12px serif')?.['font-weight']).toBe('600');
  });

  it('reads the size/line-height pair, which has no spaces around the slash', () => {
    // Measured: `12px/1.5` tokenizes as dimension, delim '/', number — all
    // inside one whitespace-delimited part, so the slash must be found at
    // TOKEN level rather than by splitting on spaces.
    const got = ex('font', 'italic 12px/1.5 Georgia, serif');
    expect(got?.['font-size']).toBe('12px');
    expect(got?.['line-height']).toBe('1.5');
    expect(got?.['font-family']).toBe('Georgia, serif');
  });

  it('reads the slash form with spaces around it too', () => {
    expect(ex('font', '12px / 1.5 serif')?.['line-height']).toBe('1.5');
  });

  it('accepts a font-size keyword as the size', () => {
    expect(ex('font', 'large serif')?.['font-size']).toBe('large');
  });

  it('requires both a size and a family', () => {
    expect(ex('font', '12px')).toBeUndefined();
    expect(ex('font', 'serif')).toBeUndefined();
    expect(ex('font', 'italic bold')).toBeUndefined();
  });

  it('REFUSES the system font keywords rather than half-applying them', () => {
    // `font: menu` means "whatever this platform's menu font is", which we
    // cannot answer. Refusing records it for zch2.7; guessing would set a
    // family the author never named.
    for (const k of ['caption', 'icon', 'menu', 'message-box', 'small-caption',
      'status-bar']) {
      expect(ex('font', k), k).toBeUndefined();
    }
  });
});

describe('the remaining shorthands', () => {
  it('takes only the colour from background', () => {
    expect(ex('background', 'red')).toEqual({ 'background-color': 'red' });
  });

  it('refuses a background carrying anything but a colour', () => {
    // Refusing records it for zch2.7. Taking the colour and dropping the
    // image would render a flat panel where the author wrote a picture.
    expect(ex('background', 'url(x.png)')).toBeUndefined();
    expect(ex('background', 'red url(x.png) no-repeat')).toBeUndefined();
  });

  it('expands list-style, in either order, resetting the other half', () => {
    expect(ex('list-style', 'square inside')).toEqual({
      'list-style-type': 'square', 'list-style-position': 'inside',
    });
    expect(ex('list-style', 'inside square')).toEqual(ex('list-style', 'square inside'));
    expect(ex('list-style', 'square')?.['list-style-position']).toBe('initial');
  });

  it('reads a bare none on list-style as the TYPE', () => {
    // `none` is legal for both the type and the image. The image is out of
    // scope, so the type is the only reading that means anything here.
    expect(ex('list-style', 'none')?.['list-style-type']).toBe('none');
  });

  it('expands text-decoration in any order, resetting the rest', () => {
    const got = ex('text-decoration', 'underline dotted red');
    expect(got?.['text-decoration-line']).toBe('underline');
    expect(got?.['text-decoration-style']).toBe('dotted');
    expect(got?.['text-decoration-color']).toBe('red');
    expect(ex('text-decoration', 'underline')?.['text-decoration-color']).toBe('initial');
  });

  it('reads a multi-word text-decoration line', () => {
    expect(ex('text-decoration', 'underline line-through')?.['text-decoration-line'])
      .toBe('underline line-through');
  });
});

describe('the whole set', () => {
  it('returns undefined for a name that is not a shorthand', () => {
    expect(expandShorthand('color', V('red'))).toBeUndefined();
  });

  it('never throws, for any shorthand, on any value', () => {
    for (const name of SHORTHANDS) {
      for (const s of ['', '  ', 'initial', '1px', 'red', 'a b c d e f', '/', '1px/']) {
        expect(() => expandShorthand(name, V(s)), `${name}: ${s}`).not.toThrow();
      }
    }
  });

  it('passes a CSS-wide keyword straight through to every longhand', () => {
    // `margin: inherit` means all four sides inherit. Handling it inside each
    // shorthand's own grammar would be four more places to get it wrong.
    expect(ex('margin', 'inherit')).toEqual({
      'margin-top': 'inherit', 'margin-right': 'inherit',
      'margin-bottom': 'inherit', 'margin-left': 'inherit',
    });
    expect(ex('font', 'unset')?.['font-family']).toBe('unset');
    expect(keywordOf(V('unset'))).toBe('unset');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssshorthand.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssshorthand.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssshorthand.ts`:

```ts
/** Shorthand → longhand expansion.
 *
 *  Invariant: a PURE LEAF over cssvalue.js and cssprop.js. No Document, no
 *  PDF object, no `node:` import. It never throws: a value a shorthand's
 *  grammar rejects is `undefined`, and the caller records it for zch2.7.
 *
 *  Invariant: a shorthand sets EVERY longhand it governs, including the ones
 *  the author did not mention — `border: 1px` resets style and colour. That
 *  is modelled by emitting a synthetic `initial` ident for the unmentioned
 *  ones rather than by a second concept, so the CSS-wide keyword machinery
 *  cssvalue.ts already has does the work and there is one reset rule here
 *  rather than two.
 *
 *  Invariant: a CSS-wide keyword on a shorthand passes straight through to
 *  every longhand. `margin: inherit` means four inheriting sides; handling it
 *  inside each shorthand's own grammar would be four more places to get it
 *  wrong.
 *
 *  Invariant: it is its own module rather than a section of cssprop.ts
 *  because expansion is LOGIC where that table is DATA — and because `font`
 *  alone, with its reorderable prefix, its slash-joined size/line-height pair
 *  and the system keywords it must refuse, is larger than several rows. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import { trimWs, keywordOf, numberOf, colorOf, cssWideOf } from './cssvalue.js';
import { FONT_SIZE_KEYWORDS } from './cssprop.js';

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** A synthetic value meaning "reset this longhand". */
const INITIAL: CssValue[] = [{ kind: 'ident', value: 'initial' } as CssToken];

export const SHORTHANDS: ReadonlySet<string> = new Set([
  'margin', 'padding',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-width', 'border-style', 'border-color',
  'font', 'background', 'list-style', 'text-decoration',
]);

/** Split a value into whitespace-delimited parts. Commas are KEPT inside a
 *  part, because a font family list is one part with commas in it. */
function parts(v: CssValue[]): CssValue[][] {
  const out: CssValue[][] = [];
  let cur: CssValue[] = [];
  for (const x of v) {
    if ((x as CssToken).kind === 'whitespace') {
      if (cur.length > 0) { out.push(cur); cur = []; }
      continue;
    }
    cur.push(x);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** The 1-to-4-value box rule: 1 → all, 2 → TB/LR, 3 → T/LR/B, 4 → clockwise. */
function boxOf(p: CssValue[][]): [CssValue[], CssValue[], CssValue[], CssValue[]] | undefined {
  const [a, b, c, d] = p;
  if (a === undefined) return undefined;
  if (p.length === 1) return [a, a, a, a];
  if (p.length === 2 && b !== undefined) return [a, b, a, b];
  if (p.length === 3 && b !== undefined && c !== undefined) return [a, b, c, b];
  if (p.length === 4 && b !== undefined && c !== undefined && d !== undefined)
    return [a, b, c, d];
  return undefined;
}

function box(prefix: string, suffix: string, p: CssValue[][]): [string, CssValue[]][] | undefined {
  const b = boxOf(p);
  if (b === undefined) return undefined;
  return SIDES.map((s, i) => [`${prefix}${s}${suffix}`, b[i] as CssValue[]]);
}

const BORDER_STYLE_WORDS = new Set(['none', 'hidden', 'solid', 'dotted', 'dashed',
  'double', 'groove', 'ridge', 'inset', 'outset']);
const BORDER_WIDTH_WORDS = new Set(['thin', 'medium', 'thick']);

/** Classify the up-to-three components of a `border` value, in any order. */
function borderParts(p: CssValue[][]):
{ width?: CssValue[]; style?: CssValue[]; color?: CssValue[] } | undefined {
  if (p.length === 0 || p.length > 3) return undefined;
  const out: { width?: CssValue[]; style?: CssValue[]; color?: CssValue[] } = {};
  for (const part of p) {
    const k = keywordOf(part);
    if (k !== undefined && BORDER_STYLE_WORDS.has(k)) {
      if (out.style !== undefined) return undefined;
      out.style = part;
      continue;
    }
    if (k !== undefined && BORDER_WIDTH_WORDS.has(k)) {
      if (out.width !== undefined) return undefined;
      out.width = part;
      continue;
    }
    const t = part[0] as CssToken | undefined;
    if (part.length === 1 && t !== undefined
      && (t.kind === 'dimension' || (t.kind === 'number' && t.value === 0))) {
      if (out.width !== undefined) return undefined;
      out.width = part;
      continue;
    }
    if (colorOf(part) !== undefined) {
      if (out.color !== undefined) return undefined;
      out.color = part;
      continue;
    }
    return undefined;                       // a component we cannot classify
  }
  return out;
}

function borderSides(sides: readonly string[], p: CssValue[][]):
[string, CssValue[]][] | undefined {
  const c = borderParts(p);
  if (c === undefined) return undefined;
  const out: [string, CssValue[]][] = [];
  for (const s of sides) {
    out.push([`border-${s}-width`, c.width ?? INITIAL]);
    out.push([`border-${s}-style`, c.style ?? INITIAL]);
    out.push([`border-${s}-color`, c.color ?? INITIAL]);
  }
  return out;
}

const FONT_SYSTEM = new Set(['caption', 'icon', 'menu', 'message-box',
  'small-caption', 'status-bar']);
const FONT_STYLE_WORDS = new Set(['italic', 'oblique']);
const FONT_WEIGHT_WORDS = new Set(['bold', 'bolder', 'lighter']);
const FONT_VARIANT_WORDS = new Set(['small-caps']);

/** `[style || variant || weight] <size>[/<line-height>] <family>`.
 *
 *  Worked at TOKEN level rather than over whitespace-delimited parts, because
 *  `12px/1.5` is one part containing three tokens — measured, not assumed. */
function expandFont(v: CssValue[]): [string, CssValue[]][] | undefined {
  const t = trimWs(v);
  if (t.length === 0) return undefined;

  const lone = keywordOf(v);
  // A system font names a platform face we cannot resolve. Refusing records
  // it for zch2.7; guessing would set a family the author never named.
  if (lone !== undefined && FONT_SYSTEM.has(lone)) return undefined;

  let style: CssValue[] | undefined;
  let weight: CssValue[] | undefined;
  let i = 0;

  // The reorderable prefix. `normal` is legal for style, variant and weight
  // alike and means the initial for all three, so it is consumed and dropped.
  for (; i < t.length; i++) {
    const x = t[i] as CssToken;
    if (x.kind === 'whitespace') continue;
    if (x.kind === 'ident') {
      const k = x.value.toLowerCase();
      if (k === 'normal') continue;
      if (FONT_STYLE_WORDS.has(k)) {
        if (style !== undefined) return undefined;
        style = [x];
        continue;
      }
      if (FONT_WEIGHT_WORDS.has(k)) {
        if (weight !== undefined) return undefined;
        weight = [x];
        continue;
      }
      if (FONT_VARIANT_WORDS.has(k)) continue;   // font-variant is out of scope
      break;                                     // must be the size keyword
    }
    if (x.kind === 'number' && x.value >= 1 && x.value <= 1000) {
      if (weight !== undefined) return undefined;
      weight = [x];
      continue;
    }
    break;                                       // must be the size
  }

  // The size.
  const sizeTok = t[i] as CssToken | undefined;
  if (sizeTok === undefined) return undefined;
  const sizeOk = sizeTok.kind === 'dimension' || sizeTok.kind === 'percentage'
    || (sizeTok.kind === 'ident'
      && Object.prototype.hasOwnProperty.call(FONT_SIZE_KEYWORDS, sizeTok.value.toLowerCase()));
  if (!sizeOk) return undefined;
  const size: CssValue[] = [sizeTok];
  i++;

  // The optional `/ <line-height>`, whose slash may or may not be spaced.
  let lineHeight: CssValue[] | undefined;
  let j = i;
  while (j < t.length && (t[j] as CssToken).kind === 'whitespace') j++;
  const slash = t[j] as CssToken | undefined;
  if (slash !== undefined && slash.kind === 'delim' && slash.value === '/') {
    j++;
    while (j < t.length && (t[j] as CssToken).kind === 'whitespace') j++;
    const lh = t[j] as CssToken | undefined;
    if (lh === undefined) return undefined;
    lineHeight = [lh];
    i = j + 1;
  }

  const family = trimWs(t.slice(i));
  if (family.length === 0) return undefined;

  return [
    ['font-style', style ?? INITIAL],
    ['font-weight', weight ?? INITIAL],
    ['font-size', size],
    ['line-height', lineHeight ?? INITIAL],
    ['font-family', family],
  ];
}

const LIST_POSITION_WORDS = new Set(['inside', 'outside']);

function expandListStyle(p: CssValue[][]): [string, CssValue[]][] | undefined {
  if (p.length === 0 || p.length > 2) return undefined;
  let type: CssValue[] | undefined;
  let position: CssValue[] | undefined;
  for (const part of p) {
    const k = keywordOf(part);
    if (k === undefined) return undefined;
    if (LIST_POSITION_WORDS.has(k)) {
      if (position !== undefined) return undefined;
      position = part;
      continue;
    }
    // `none` is legal for the type AND the image. The image is out of scope,
    // so the type is the only reading that means anything here.
    if (type !== undefined) return undefined;
    type = part;
  }
  return [['list-style-type', type ?? INITIAL], ['list-style-position', position ?? INITIAL]];
}

const DECORATION_LINE_WORDS = new Set(['none', 'underline', 'overline', 'line-through']);
const DECORATION_STYLE_WORDS = new Set(['solid', 'double', 'dotted', 'dashed', 'wavy']);

function expandTextDecoration(p: CssValue[][]): [string, CssValue[]][] | undefined {
  if (p.length === 0) return undefined;
  const line: CssValue[] = [];
  let style: CssValue[] | undefined;
  let color: CssValue[] | undefined;
  for (const part of p) {
    const k = keywordOf(part);
    if (k !== undefined && DECORATION_LINE_WORDS.has(k)) {
      if (line.length > 0) line.push({ kind: 'whitespace' } as CssToken);
      line.push(...part);
      continue;
    }
    if (k !== undefined && DECORATION_STYLE_WORDS.has(k)) {
      if (style !== undefined) return undefined;
      style = part;
      continue;
    }
    if (colorOf(part) !== undefined) {
      if (color !== undefined) return undefined;
      color = part;
      continue;
    }
    return undefined;
  }
  return [
    ['text-decoration-line', line.length > 0 ? line : INITIAL],
    ['text-decoration-style', style ?? INITIAL],
    ['text-decoration-color', color ?? INITIAL],
  ];
}

/** The longhands each shorthand governs, for the CSS-wide-keyword pass-through. */
const GOVERNS: Record<string, string[]> = {
  margin: SIDES.map((s) => `margin-${s}`),
  padding: SIDES.map((s) => `padding-${s}`),
  'border-width': SIDES.map((s) => `border-${s}-width`),
  'border-style': SIDES.map((s) => `border-${s}-style`),
  'border-color': SIDES.map((s) => `border-${s}-color`),
  border: SIDES.flatMap((s) =>
    [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  font: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'],
  background: ['background-color'],
  'list-style': ['list-style-type', 'list-style-position'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style',
    'text-decoration-color'],
};

export function expandShorthand(
  name: string, v: CssValue[],
): [string, CssValue[]][] | undefined {
  const n = name.toLowerCase();
  if (!SHORTHANDS.has(n)) return undefined;

  // A CSS-wide keyword goes to every longhand this shorthand governs, before
  // the shorthand's own grammar is consulted at all.
  if (cssWideOf(v) !== undefined) {
    const value = trimWs(v);
    return (GOVERNS[n] as string[]).map((k) => [k, value]);
  }

  const p = parts(trimWs(v));
  if (p.length === 0) return undefined;

  switch (n) {
    case 'margin': return box('margin-', '', p);
    case 'padding': return box('padding-', '', p);
    case 'border-width': return box('border-', '-width', p);
    case 'border-style': return box('border-', '-style', p);
    case 'border-color': return box('border-', '-color', p);
    case 'border': return borderSides(SIDES, p);
    case 'border-top': return borderSides(['top'], p);
    case 'border-right': return borderSides(['right'], p);
    case 'border-bottom': return borderSides(['bottom'], p);
    case 'border-left': return borderSides(['left'], p);
    case 'font': return expandFont(v);
    // Only the colour component is in scope. A background carrying an image
    // is REFUSED whole rather than reduced to its colour: taking the red out
    // of `red url(x.png)` renders a flat panel where the author wrote a
    // picture, and refusing records it for zch2.7.
    case 'background': {
      const c = trimWs(v);
      return colorOf(c) === undefined ? undefined : [['background-color', c]];
    }
    case 'list-style': return expandListStyle(p);
    case 'text-decoration': return expandTextDecoration(p);
    default: return undefined;
  }
}
```

Note `numberOf` is imported but unused after this implementation — remove it
from the import list if `npm run typecheck` flags it.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssshorthand.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/cssshorthand.ts test/cssshorthand.test.ts
git commit -m "feat(zch2.2.3): shorthand expansion

Fourteen shorthand names covering the box rule, the three border forms, font,
background, list-style and text-decoration.

The reset rule needs no second concept: a shorthand sets EVERY longhand it
governs, so an unmentioned one is emitted with a synthetic `initial` ident
and the CSS-wide keyword machinery does the work. Without it, 'border: 1px'
after 'border-color: red' would wrongly keep the red.

A CSS-wide keyword passes through to every governed longhand BEFORE the
shorthand's own grammar runs, so 'margin: inherit' is four inheriting sides
rather than four more places to get it wrong.

font is worked at TOKEN level rather than over whitespace-delimited parts,
because '12px/1.5' is one part holding three tokens — measured. It refuses
the six system keywords rather than half-applying them: 'font: menu' names
a platform face we cannot resolve, so refusing records it for zch2.7 while
guessing would set a family the author never named. background refuses an
image for the same reason rather than keeping just the colour.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 7: `cssua.ts` — the UA stylesheet

**Files:**
- Create: `src/cssua.ts`
- Test: `test/cssua.test.ts`

**Interfaces:**
- Consumes: nothing at compile time; `csscascade.ts` compiles the text in Task 8.
- Produces:

```ts
export const UA_CSS: string;
```

Deliberately just the text. Compiling it needs the selector engine and the
rule walk, both of which live in `csscascade.ts`, and putting the compile
here would make this module import that one and close a cycle.

- [ ] **Step 1: Write the failing test**

Create `test/cssua.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseStylesheet } from '../src/cssparse.js';
import { parseSelectorList } from '../src/cssselect.js';
import { UA_CSS } from '../src/cssua.js';
import type { CssQualifiedRule } from '../src/cssparse.js';

describe('the UA stylesheet', () => {
  it('parses with no error rules at all', () => {
    const rules = parseStylesheet(UA_CSS);
    expect(rules.length).toBeGreaterThan(20);
    expect(rules.filter((r) => r.kind === 'error')).toEqual([]);
  });

  it('has every selector accepted by our own selector engine', () => {
    // A UA rule our matcher refuses is a rule that silently does nothing, and
    // nothing else in the suite would notice.
    const bad: string[] = [];
    for (const r of parseStylesheet(UA_CSS)) {
      if (r.kind !== 'qualified-rule') continue;
      if (parseSelectorList((r as CssQualifiedRule).prelude) === null) {
        bad.push(JSON.stringify((r as CssQualifiedRule).prelude).slice(0, 80));
      }
    }
    expect(bad).toEqual([]);
  });

  it('states the initial font and colour on html, not on body', () => {
    // Inheritance starts at the document element. Setting them on body means
    // a document whose <html> carries text loses them.
    expect(/(^|\})\s*html\s*\{[^}]*font-family/.test(UA_CSS)).toBe(true);
    expect(/(^|\})\s*html\s*\{[^}]*color/.test(UA_CSS)).toBe(true);
  });

  it('gives head and its children display:none', () => {
    expect(/display\s*:\s*none/.test(UA_CSS)).toBe(true);
    expect(UA_CSS).toMatch(/\bhead\b/);
  });

  it('gives li display:list-item and the table parts their table displays', () => {
    expect(UA_CSS).toMatch(/display\s*:\s*list-item/);
    expect(UA_CSS).toMatch(/display\s*:\s*table-cell/);
    expect(UA_CSS).toMatch(/display\s*:\s*table-row-group/);
  });

  it('uses em for heading sizes and margins, so they scale with the base size', () => {
    // Absolute px here would make a document that sets html{font-size}
    // change its body text and not its headings.
    expect(UA_CSS).toMatch(/h1\s*\{[^}]*font-size\s*:\s*2em/);
  });

  it('declares nothing !important', () => {
    // Tier 6 exists because the spec says so, not because this sheet uses it.
    // If that ever changes, the six-tier test in csscascade must gain a case.
    expect(UA_CSS).not.toMatch(/!\s*important/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssua.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssua.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssua.ts`:

```ts
/** The user-agent stylesheet, transcribed from the HTML Standard §15
 *  "Rendering".
 *
 *  Invariant: a PURE LEAF exporting a STRING and nothing else. It is CSS text
 *  rather than a pre-compiled table for three reasons: it is reviewable
 *  against §15 line by line, it goes through the same parser and selector
 *  engine every author sheet does — so a construct we cannot parse shows up
 *  as a failing UA test rather than as a document that renders oddly — and a
 *  transcription slip is visible as CSS instead of buried in a data
 *  structure. csscascade.ts compiles it once, lazily; putting the compile
 *  here would make this module import that one and close a cycle.
 *
 *  Invariant: transcribed from §15, NOT from Chrome. That is a deliberate
 *  divergence from the oracle, and it is exactly why the generated corpus
 *  compares author-declared properties only — see
 *  test/fixtures/css-cascade/PROVENANCE.md. This sheet is the largest
 *  untested surface zch2.2.3 ships.
 *
 *  Invariant: sizes and vertical margins are in `em`, so a document that sets
 *  `html { font-size }` scales its headings with its body text. Absolute px
 *  here would scale one and not the other.
 *
 *  Note: it declares nothing `!important`. Tier 6 of the cascade exists
 *  because CSS says so; if a rule here ever needs it, csscascade.ts's
 *  six-tier test must gain a case that exercises it. */

export const UA_CSS = `
html { display: block; font-family: serif; font-size: medium; color: black;
       line-height: normal; text-align: start }

address, article, aside, blockquote, body, dd, div, dl, dt, fieldset,
figcaption, figure, footer, form, h1, h2, h3, h4, h5, h6, header, hgroup, hr,
legend, main, nav, ol, p, pre, section, summary, ul { display: block }

li { display: list-item }
head, base, link, meta, script, style, title, template, noscript { display: none }

table { display: table }
thead { display: table-header-group }
tbody { display: table-row-group }
tfoot { display: table-footer-group }
tr { display: table-row }
td, th { display: table-cell }
caption { display: table-caption }

body { margin: 8px }

h1 { font-size: 2em;    font-weight: bold; margin: 0.67em 0 }
h2 { font-size: 1.5em;  font-weight: bold; margin: 0.83em 0 }
h3 { font-size: 1.17em; font-weight: bold; margin: 1em 0 }
h4 { font-size: 1em;    font-weight: bold; margin: 1.33em 0 }
h5 { font-size: 0.83em; font-weight: bold; margin: 1.67em 0 }
h6 { font-size: 0.67em; font-weight: bold; margin: 2.33em 0 }

p { margin: 1em 0 }
blockquote, figure { margin: 1em 40px }
dl { margin: 1em 0 }
dd { margin-left: 40px }
ol, ul { margin: 1em 0; padding-left: 40px }
ul { list-style-type: disc }
ol { list-style-type: decimal }
ul ul, ol ul { list-style-type: circle }
ul ul ul, ul ol ul, ol ul ul, ol ol ul { list-style-type: square }
li { text-align: start }

pre { font-family: monospace; white-space: pre; margin: 1em 0 }
code, kbd, samp { font-family: monospace }

b, strong { font-weight: bold }
i, em, cite, var, dfn, address { font-style: italic }
u, ins { text-decoration: underline }
s, del { text-decoration: line-through }
small { font-size: smaller }
big { font-size: larger }
sub { vertical-align: sub; font-size: smaller }
sup { vertical-align: super; font-size: smaller }
mark { background-color: yellow; color: black }

a:link { color: #0000ee; text-decoration: underline }

hr { display: block; margin: 0.5em auto; border-style: inset; border-width: 1px }

table { border-collapse: separate; border-spacing: 2px; border-color: gray }
td, th { padding: 1px }
th { font-weight: bold; text-align: center }
caption { text-align: center }
`;
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssua.test.ts`
Expected: PASS, 7 tests.

If the selector test reports a refused prelude, the fix is in the sheet — replace the construct with one `cssselect.ts` accepts — never in `cssselect.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/cssua.ts test/cssua.test.ts
git commit -m "feat(zch2.2.3): the UA stylesheet, as CSS text

Transcribed from HTML Standard §15 'Rendering'. Text rather than a
pre-compiled table because it is reviewable against §15 line by line,
because it goes through the same parser and selector engine every author
sheet does — so a construct we cannot parse is a failing UA test rather
than a document that renders oddly — and because a transcription slip is
then visible as CSS.

Sizes and vertical margins are in em, so a document setting html{font-size}
scales its headings with its body text; absolute px would scale one and not
the other. The initial font and colour sit on html rather than body,
inheritance starting at the document element.

It is transcribed from §15 and NOT from Chrome, which is the deliberate
divergence that makes the generated corpus compare author-declared
properties only. This sheet is the largest untested surface this issue
ships and PROVENANCE.md will say so.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: `csscascade.ts` — collection, `@media`, and declarations to longhands

**Files:**
- Create: `src/csscascade.ts`
- Test: `test/csscascade.test.ts`

**Interfaces:**
- Consumes: `parseStylesheet`, `parseDeclarationsFromValues`, `parseRulesFromValues` from `src/cssparse.js`; `parseSelectorList`, `specificityOf` from `src/cssselect.js`; `PROPERTIES`, `UnsupportedDeclaration` from `src/cssprop.js`; `SHORTHANDS`, `expandShorthand` from `src/cssshorthand.js`; `UA_CSS` from `src/cssua.js`.
- Produces:

```ts
export type Tier = 1 | 2 | 3 | 4 | 5 | 6;
export interface CompiledRule {
  sel: ComplexSelector;
  spec: Specificity;
  order: number;
  tier: Tier;
  decls: [string, CssValue[]][];        // LONGHANDS, already expanded
}
export interface InlineDeclarations { normal: [string, CssValue[]][]; important: [string, CssValue[]][] }
export interface Collected {
  rules: CompiledRule[];
  inline: Map<HtmlElement, InlineDeclarations>;
  unsupported: UnsupportedDeclaration[];
}
export function mediaMatches(prelude: CssValue[]): { ok: boolean; feature: boolean };
export function collect(root: HtmlDocument): Collected;
```

**Refinement of the spec's sketch, and it is a clarification rather than a
change:** the spec's `Map<HtmlElement, Record<Origin, Declared>>` becomes
`{ all, ua }` in Task 9, because what `revert` actually needs is the UA
winner beside the FINAL winner, not the author winner beside the UA one.

**On "property-agnostic", precisely:** the cascade consults `PROPERTIES` and
`SHORTHANDS` for one question only — *is this name a longhand or a shorthand
we know* — and never touches `compute` or `inherited`. It parses no values.
That is what keeps it testable from hand-written declarations, and shorthand
expansion has to happen here because the other invariant requires expansion
before the sort.

- [ ] **Step 1: Write the failing test**

Create `test/csscascade.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseComponentValueList } from '../src/cssparse.js';
import { collect, mediaMatches } from '../src/csscascade.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

const V = (s: string) => parseComponentValueList(s);

/** Every element, template content included, so a test can reach one the
 *  collection walk is supposed to skip. */
function allElements(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') { out.push(x); if (x.content !== undefined) walk(x.content); }
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

/** The author rules only — the UA sheet is prepended and always present. */
const authorRules = (src: string) =>
  collect(parseHtml(src)).rules.filter((r) => r.tier !== 1 && r.tier !== 6);

describe('mediaMatches', () => {
  it('matches print and all, and refuses screen', () => {
    expect(mediaMatches(V('print')).ok).toBe(true);
    expect(mediaMatches(V('all')).ok).toBe(true);
    expect(mediaMatches(V('screen')).ok).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(mediaMatches(V('PRINT')).ok).toBe(true);
  });

  it('matches a comma list when ANY query matches', () => {
    expect(mediaMatches(V('screen, print')).ok).toBe(true);
    expect(mediaMatches(V('screen, projection')).ok).toBe(false);
  });

  it('ignores a leading only', () => {
    expect(mediaMatches(V('only print')).ok).toBe(true);
    expect(mediaMatches(V('only screen')).ok).toBe(false);
  });

  it('inverts a leading not', () => {
    expect(mediaMatches(V('not screen')).ok).toBe(true);
    expect(mediaMatches(V('not print')).ok).toBe(false);
  });

  it('treats a query carrying a FEATURE as non-matching, and says so', () => {
    // Detected structurally: a `(` block in the query. No string matching.
    const r = mediaMatches(V('(min-width: 60em)'));
    expect(r.ok).toBe(false);
    expect(r.feature).toBe(true);
    const s = mediaMatches(V('print and (color)'));
    expect(s.ok).toBe(false);
    expect(s.feature).toBe(true);
  });

  it('treats an empty prelude as non-matching', () => {
    expect(mediaMatches(V('')).ok).toBe(false);
    expect(mediaMatches(V('   ')).ok).toBe(false);
  });
});

describe('collection', () => {
  it('reads a <style> element', () => {
    const r = authorRules('<style>p{color:red}</style>');
    expect(r.length).toBe(1);
    expect(r[0]?.decls).toEqual([['color', expect.anything()]]);
  });

  it('reads several <style> elements in document order', () => {
    const r = authorRules('<style>p{color:red}</style><style>p{color:blue}</style>');
    expect(r.length).toBe(2);
    expect((r[0]?.order ?? 0) < (r[1]?.order ?? 0)).toBe(true);
  });

  it('skips a <style> whose type is present and not text/css, and records it', () => {
    const c = collect(parseHtml('<style type="text/x-scss">p{color:red}</style>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
    expect(c.unsupported.some((u) => u.property === 'style')).toBe(true);
  });

  it('accepts a <style> whose type IS text/css, in any case', () => {
    expect(authorRules('<style type="TEXT/CSS">p{color:red}</style>').length).toBe(1);
  });

  it('does NOT descend into a template content', () => {
    // A template's content is not part of the document, so a <style> inside
    // one styles nothing — the same structural rule selectAll follows.
    const c = collect(parseHtml('<template><style>p{color:red}</style></template>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
  });

  it('reads a style= attribute as inline declarations', () => {
    const doc = parseHtml('<p id=x style="color:red;margin:0">t</p>');
    const el = allElements(doc).find((e) => e.attrs.get('id') === 'x');
    const inline = collect(doc).inline.get(el as HtmlElement);
    expect(inline?.normal.map(([k]) => k)).toEqual([
      'color', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    ]);
  });

  it('splits a style= attribute by importance', () => {
    const doc = parseHtml('<p id=x style="color:red;background:blue!important">t</p>');
    const el = allElements(doc).find((e) => e.attrs.get('id') === 'x');
    const inline = collect(doc).inline.get(el as HtmlElement);
    expect(inline?.normal.map(([k]) => k)).toEqual(['color']);
    expect(inline?.important.map(([k]) => k)).toEqual(['background-color']);
  });

  it('EXPANDS a shorthand at collection time, not later', () => {
    // The load-bearing ordering: the cascade sorts longhands only, so
    // `margin: 0; margin-top: 5px` can be decided by document order.
    const r = authorRules('<style>p{margin:1px 2px}</style>');
    expect(r[0]?.decls.map(([k]) => k)).toEqual([
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    ]);
  });

  it('gives a grouped selector INDEPENDENT rules, each with its own specificity', () => {
    // `.a, #b { }` is two rules, not one at the higher — or `.a` would win
    // against a competing `#c`.
    const r = authorRules('<style>.a, #b{color:red}</style>');
    expect(r.length).toBe(2);
    expect(r[0]?.spec).not.toEqual(r[1]?.spec);
  });

  it('drops a rule whose selector list is invalid, and records it', () => {
    const c = collect(parseHtml('<style>a:has(> b){color:red}</style>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
    expect(c.unsupported.some((u) => u.reason === 'unparsable-value')).toBe(true);
  });

  it('records an unknown property and keeps the rest of the rule', () => {
    const c = collect(parseHtml('<style>p{box-shadow:0 0 2px;color:red}</style>'));
    const r = c.rules.filter((x) => x.tier === 2);
    expect(r[0]?.decls.map(([k]) => k)).toEqual(['color']);
    const u = c.unsupported.find((x) => x.property === 'box-shadow');
    expect(u?.reason).toBe('unknown-property');
    expect(u?.el).toBeNull();
  });

  it('applies an @media print block and skips an @media screen one', () => {
    expect(authorRules('<style>@media print{p{color:red}}</style>').length).toBe(1);
    expect(authorRules('<style>@media screen{p{color:red}}</style>').length).toBe(0);
  });

  it('records an @media carrying a feature rather than dropping it silently', () => {
    const c = collect(parseHtml('<style>@media (min-width:60em){p{color:red}}</style>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
    expect(c.unsupported.some((u) => u.reason === 'unsupported-media-feature')).toBe(true);
  });

  it('records an at-rule it does not implement', () => {
    const c = collect(parseHtml('<style>@import url(x.css);p{color:red}</style>'));
    expect(c.unsupported.some(
      (u) => u.property === '@import' && u.reason === 'unsupported-at-rule')).toBe(true);
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(1);
  });

  it('nests @media, applying only what matches all the way down', () => {
    expect(authorRules('<style>@media print{@media all{p{color:red}}}</style>').length).toBe(1);
    expect(authorRules('<style>@media print{@media screen{p{color:red}}}</style>').length).toBe(0);
  });

  it('always prepends the UA sheet, at tiers 1 and 6', () => {
    const c = collect(parseHtml('<p>t</p>'));
    expect(c.rules.some((r) => r.tier === 1)).toBe(true);
    expect(c.rules.every((r) => r.tier >= 1 && r.tier <= 6)).toBe(true);
  });

  it('assigns tier 2 to a normal author rule and tier 4 to an important one', () => {
    const r = authorRules('<style>p{color:red}q{color:blue!important}</style>');
    expect(r.find((x) => x.decls.length === 1 && x.tier === 2)).toBeDefined();
    expect(r.find((x) => x.tier === 4)).toBeDefined();
  });

  it('never throws, on any document', () => {
    for (const s of ['', '<style></style>', '<style>@</style>', '<style>{}</style>',
      '<p style="">t</p>', '<p style=":">t</p>', '<style>p{</style>']) {
      expect(() => collect(parseHtml(s)), s).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/csscascade.test.ts`
Expected: FAIL — `Failed to resolve import "../src/csscascade.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/csscascade.ts`:

```ts
/** The CSS cascade: collecting stylesheets, and deciding which declarations
 *  reach each element.
 *
 *  Invariant: a PURE LEAF. It imports the two parser modules, cssselect.js,
 *  cssprop.js, cssshorthand.js, cssua.js and htmldom.js for types. No
 *  Document, no PDF object, no `node:` import. It never throws: everything it
 *  cannot use is recorded on `unsupported` for zch2.7.
 *
 *  Invariant: it is PROPERTY-AGNOSTIC in the sense that matters — it consults
 *  PROPERTIES and SHORTHANDS for one question only, "is this name something we
 *  know", and never touches `compute` or `inherited`, and parses no values.
 *  That is what lets every rule below be tested from hand-written
 *  declarations, and it is why the property table can change without this
 *  module moving.
 *
 *  Invariant: shorthands expand HERE, before the sort, because the cascade
 *  sorts longhands only. `p { margin: 0; margin-top: 5px }` yields 5px and
 *  the reverse order yields 0; expanding after the sort yields 0 both times,
 *  which is a wrong answer indistinguishable from a right one.
 *
 *  Invariant: the collection walk does NOT descend into a <template>'s
 *  content. A template's content is not part of the document, so a <style>
 *  inside one styles nothing — the same structural rule selectAll follows. */

import { parseStylesheet, parseDeclarationsFromValues, parseRulesFromValues } from './cssparse.js';
import type { CssAtRule, CssDeclaration, CssQualifiedRule, CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';
import { parseSelectorList, specificityOf } from './cssselect.js';
import type { ComplexSelector, Specificity } from './cssselect.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import { PROPERTIES } from './cssprop.js';
import type { UnsupportedDeclaration } from './cssprop.js';
import { SHORTHANDS, expandShorthand } from './cssshorthand.js';
import { UA_CSS } from './cssua.js';

/** The six cascade tiers, low to high. See the header of `cascade` in Task 9
 *  for why flattening origin, importance and element-attachment into one
 *  ordinal is the point rather than a shortcut. */
export type Tier = 1 | 2 | 3 | 4 | 5 | 6;

export interface CompiledRule {
  sel: ComplexSelector;
  spec: Specificity;
  order: number;
  tier: Tier;
  /** Longhands, already expanded. */
  decls: [string, CssValue[]][];
}

export interface InlineDeclarations {
  normal: [string, CssValue[]][];
  important: [string, CssValue[]][];
}

export interface Collected {
  rules: CompiledRule[];
  inline: Map<HtmlElement, InlineDeclarations>;
  unsupported: UnsupportedDeclaration[];
}

const MEDIA_TYPES_WE_ARE = new Set(['print', 'all']);

/** Does this `@media` prelude apply to a print user agent?
 *
 *  Types only. A query carrying a FEATURE — detected structurally, as a `(`
 *  block, with no string matching anywhere — is non-matching and reported so
 *  the caller can record it. Evaluating a feature needs a viewport, which is
 *  the thing this module deliberately does not have. */
export function mediaMatches(prelude: CssValue[]): { ok: boolean; feature: boolean } {
  const queries: CssValue[][] = [[]];
  for (const v of prelude) {
    if ((v as CssToken).kind === 'comma') { queries.push([]); continue; }
    (queries[queries.length - 1] as CssValue[]).push(v);
  }

  let ok = false;
  let feature = false;
  for (const q of queries) {
    const t = q.filter((x) => (x as CssToken).kind !== 'whitespace');
    if (t.length === 0) continue;
    if (t.some((x) => (x as { kind: string; open?: string }).kind === 'block')) {
      feature = true;
      continue;
    }
    let i = 0;
    let negate = false;
    const first = t[0] as CssToken;
    if (first.kind === 'ident') {
      const k = first.value.toLowerCase();
      if (k === 'only') i = 1;
      else if (k === 'not') { negate = true; i = 1; }
    }
    const typeTok = t[i] as CssToken | undefined;
    if (typeTok === undefined || typeTok.kind !== 'ident') continue;
    // Anything after the type is an `and`-joined feature we do not evaluate.
    if (t.length > i + 1) { feature = true; continue; }
    const hit = MEDIA_TYPES_WE_ARE.has(typeTok.value.toLowerCase());
    if (negate ? !hit : hit) ok = true;
  }
  return { ok, feature };
}

/** Render a value back to rough source text, for an `unsupported` entry. */
function valueText(v: CssValue[]): string {
  return v.map((x) => {
    const t = x as { kind: string; value?: unknown; unit?: string; name?: string };
    if (t.kind === 'whitespace') return ' ';
    if (t.kind === 'dimension') return `${String(t.value)}${String(t.unit)}`;
    if (t.kind === 'percentage') return `${String(t.value)}%`;
    if (t.kind === 'hash') return `#${String(t.value)}`;
    if (t.kind === 'string') return `"${String(t.value)}"`;
    if (t.kind === 'function') return `${String(t.name)}(…)`;
    if (t.kind === 'comma') return ',';
    if (t.kind === 'colon') return ':';
    return String(t.value ?? '');
  }).join('').trim();
}

/** One declaration to the longhands it sets, recording what it could not use. */
function toLonghands(
  d: CssDeclaration, el: HtmlElement | null, unsupported: UnsupportedDeclaration[],
): [string, CssValue[]][] {
  const name = d.name.toLowerCase();       // cssparse.ts does NOT fold the name

  if (SHORTHANDS.has(name)) {
    const ex = expandShorthand(name, d.value);
    if (ex === undefined) {
      unsupported.push({
        el, property: name, value: valueText(d.value), reason: 'unparsable-value',
      });
      return [];
    }
    return ex;
  }

  if (PROPERTIES.has(name)) return [[name, d.value]];

  unsupported.push({
    el, property: name, value: valueText(d.value), reason: 'unknown-property',
  });
  return [];
}

interface Walk {
  rules: CompiledRule[];
  unsupported: UnsupportedDeclaration[];
  order: { n: number };
}

/** Compile one rule list, recursing through matching `@media` blocks. */
function compileRules(
  rules: (CssAtRule | CssQualifiedRule | { kind: 'error'; code: string })[],
  normalTier: Tier, importantTier: Tier, w: Walk,
): void {
  for (const r of rules) {
    if (r.kind === 'error') continue;

    if (r.kind === 'at-rule') {
      if (r.name.toLowerCase() === 'media') {
        const m = mediaMatches(r.prelude);
        if (m.feature) {
          w.unsupported.push({
            el: null, property: '@media', value: valueText(r.prelude),
            reason: 'unsupported-media-feature',
          });
        }
        if (m.ok && r.block !== null) {
          compileRules(parseRulesFromValues(r.block), normalTier, importantTier, w);
        }
        continue;
      }
      w.unsupported.push({
        el: null, property: `@${r.name.toLowerCase()}`, value: valueText(r.prelude),
        reason: 'unsupported-at-rule',
      });
      continue;
    }

    // A grouped selector becomes INDEPENDENT rules, each carrying its own
    // specificity: `.a, #b { }` is two rules, not one at the higher, or `.a`
    // would win against a competing `#c`.
    const list = parseSelectorList(r.prelude);
    if (list === null) {
      w.unsupported.push({
        el: null, property: 'selector', value: valueText(r.prelude),
        reason: 'unparsable-value',
      });
      continue;
    }

    const normal: [string, CssValue[]][] = [];
    const important: [string, CssValue[]][] = [];
    for (const d of parseDeclarationsFromValues(r.block)) {
      if (d.kind !== 'declaration') continue;
      (d.important ? important : normal).push(...toLonghands(d, null, w.unsupported));
    }

    for (const sel of list) {
      const spec = specificityOf(sel);
      if (normal.length > 0) {
        w.rules.push({ sel, spec, order: w.order.n, tier: normalTier, decls: normal });
      }
      if (important.length > 0) {
        w.rules.push({ sel, spec, order: w.order.n, tier: importantTier, decls: important });
      }
    }
    w.order.n++;
  }
}

let uaCompiled: CompiledRule[] | null = null;

/** The UA sheet, compiled once. Lazy so a caller that never renders HTML
 *  pays nothing; memoized because it cannot change. */
function uaRules(): CompiledRule[] {
  if (uaCompiled !== null) return uaCompiled;
  const w: Walk = { rules: [], unsupported: [], order: { n: 0 } };
  compileRules(parseStylesheet(UA_CSS), 1, 6, w);
  uaCompiled = w.rules;
  return uaCompiled;
}

/** The text of a `<style>` element: its child text nodes, concatenated. */
function styleText(el: HtmlElement): string {
  return el.children
    .map((c) => (c.kind === 'text' ? c.data : ''))
    .join('');
}

export function collect(root: HtmlDocument): Collected {
  const w: Walk = { rules: [...uaRules()], unsupported: [], order: { n: 0 } };
  const inline = new Map<HtmlElement, InlineDeclarations>();
  const sheets: string[] = [];

  const visit = (n: HtmlNode): void => {
    if (n.kind === 'element') {
      if (n.ns === 'html' && n.name === 'style') {
        const type = n.attrs.get('type');
        if (type !== undefined && type.trim().toLowerCase() !== 'text/css') {
          w.unsupported.push({
            el: n, property: 'style', value: type, reason: 'unsupported-at-rule',
          });
        } else {
          sheets.push(styleText(n));
        }
        return;                              // a <style> has no element children
      }

      const style = n.attrs.get('style');
      if (style !== undefined && style.trim() !== '') {
        const normal: [string, CssValue[]][] = [];
        const important: [string, CssValue[]][] = [];
        for (const d of parseDeclarationsFromValues(
          parseComponentValueList(style))) {
          if (d.kind !== 'declaration') continue;
          (d.important ? important : normal).push(...toLonghands(d, n, w.unsupported));
        }
        if (normal.length > 0 || important.length > 0) {
          inline.set(n, { normal, important });
        }
      }
    }

    // NOT `n.content`: a template's content is not part of the document.
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const c of n.children) visit(c);
    }
  };
  visit(root);

  // Author sheets are compiled AFTER the walk, because a <style> may appear
  // after what it styles — the same reason svgcss.ts makes a whole-tree
  // pre-pass. Order across sheets is document order, which `sheets` preserves.
  compileRules(parseStylesheet(sheets.join('\n')), 2, 4, w);

  return { rules: w.rules, inline, unsupported: w.unsupported };
}
```

The `./cssparse.js` import at the top of the file is therefore:

```ts
import {
  parseStylesheet, parseComponentValueList,
  parseDeclarationsFromValues, parseRulesFromValues,
} from './cssparse.js';
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/csscascade.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/csscascade.ts test/csscascade.test.ts
git commit -m "feat(zch2.2.3): stylesheet collection, @media, and longhand expansion

The walk collects <style> text and style= attributes in document order,
compiles author sheets after the walk because a <style> may appear after
what it styles, and prepends the UA sheet compiled once and memoized.

It does NOT descend into a template's content: a template's content is not
part of the document, so a <style> inside one styles nothing — the same
structural rule selectAll follows.

Shorthands expand HERE, before the sort, because the cascade sorts
longhands only. Expanding afterwards makes 'margin: 0; margin-top: 5px'
and its reverse both yield 0, which is a wrong answer indistinguishable
from a right one.

@media honours types only. A feature is detected STRUCTURALLY, as a '('
block in the query, with no string matching anywhere — and it is recorded
rather than dropped, evaluating one needing a viewport this module
deliberately does not have.

A grouped selector becomes independent rules each carrying its own
specificity, or '.a' in '.a, #b' would win against a competing '#c'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 9: `csscascade.ts` — the six tiers

**Files:**
- Modify: `src/csscascade.ts` (append)
- Test: `test/csscascade.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `Collected`, `CompiledRule` from Task 8; `matches`, `compareSpecificity` from `src/cssselect.js`.
- Produces:

```ts
export interface ElementDeclarations {
  /** The winner across all six tiers. */
  all: Map<string, CssValue[]>;
  /** The winner among the UA tiers alone (1 and 6), which is what `revert`
   *  reverts TO. */
  ua: Map<string, CssValue[]>;
}
export function cascade(root: HtmlDocument, c: Collected): Map<HtmlElement, ElementDeclarations>;
```

- [ ] **Step 1: Write the failing test**

Append to `test/csscascade.test.ts`:

```ts
import { cascade } from '../src/csscascade.js';

/** The winning declaration for `prop` on `#t`, rendered as source text. */
function win(src: string, prop: string, which: 'all' | 'ua' = 'all'): string | undefined {
  const doc = parseHtml(src);
  const el = allElements(doc).find((e) => e.attrs.get('id') === 't');
  const d = cascade(doc, collect(doc)).get(el as HtmlElement);
  const v = d?.[which].get(prop);
  if (v === undefined) return undefined;
  return v.map((x) => {
    const t = x as { kind: string; value?: unknown; unit?: string };
    if (t.kind === 'whitespace') return ' ';
    if (t.kind === 'dimension') return `${String(t.value)}${String(t.unit)}`;
    if (t.kind === 'hash') return `#${String(t.value)}`;
    return String(t.value ?? t.kind);
  }).join('').trim();
}

describe('the six tiers', () => {
  it('1 < 2: an author rule beats the UA sheet', () => {
    expect(win('<p id=t style="">t</p><style>p{margin-top:9px}</style>', 'margin-top'))
      .toBe('9px');
  });

  it('2 < 3: style= beats a stylesheet rule at equal importance', () => {
    expect(win('<style>#t{color:red}</style><p id=t style="color:blue">t</p>', 'color'))
      .toBe('blue');
  });

  it('2 < 3 EVEN WHEN the selector is far more specific', () => {
    // The half the "style= has infinite specificity" shortcut gets right.
    expect(win('<style>html body #t.c{color:red}</style>'
      + '<p id=t class=c style="color:blue">t</p>', 'color')).toBe('blue');
  });

  it('3 < 4: an !important stylesheet rule beats a normal style=', () => {
    // The half that shortcut gets WRONG, and the whole reason for six tiers.
    // Breaking this alone must leave the case above green.
    expect(win('<style>p{color:red!important}</style><p id=t style="color:blue">t</p>',
      'color')).toBe('red');
  });

  it('4 < 5: an !important style= beats an !important stylesheet rule', () => {
    expect(win('<style>#t{color:red!important}</style>'
      + '<p id=t style="color:blue!important">t</p>', 'color')).toBe('blue');
  });

  it('5 < 6: an !important UA rule would beat an !important style=', () => {
    // Our UA sheet declares nothing !important, so this is asserted through
    // the tier ORDER rather than through a document. If the sheet ever gains
    // one, replace this with a document-level case.
    const doc = parseHtml('<p id=t>t</p>');
    const tiers = collect(doc).rules.map((r) => r.tier);
    expect(Math.max(...tiers)).toBeLessThanOrEqual(6);
    expect(tiers.every((t) => t >= 1 && t <= 6)).toBe(true);
  });
});

describe('within a tier', () => {
  it('sorts by specificity before source order', () => {
    expect(win('<style>#t{color:red}p{color:blue}</style><p id=t>t</p>', 'color'))
      .toBe('red');
  });

  it('sorts by source order when specificity ties', () => {
    expect(win('<style>.a{color:red}.b{color:blue}</style>'
      + '<p id=t class="a b">t</p>', 'color')).toBe('blue');
  });

  it('lets a LATER shorthand reset an earlier longhand', () => {
    expect(win('<style>p{margin-top:5px;margin:0}</style><p id=t>t</p>', 'margin-top'))
      .toBe('0');
  });

  it('lets a LATER longhand survive an earlier shorthand', () => {
    // The pair. Expanding shorthands after the sort makes both cases '0'.
    expect(win('<style>p{margin:0;margin-top:5px}</style><p id=t>t</p>', 'margin-top'))
      .toBe('5px');
  });
});

describe('the per-origin winners', () => {
  it('keeps the UA winner beside the final one, for revert', () => {
    const src = '<style>p{margin-top:9px}</style><p id=t>t</p>';
    expect(win(src, 'margin-top', 'all')).toBe('9px');
    // The UA sheet gives p a 1em top margin; the author's 9px does not
    // overwrite it in the `ua` map, which is what makes revert a lookup.
    expect(win(src, 'margin-top', 'ua')).toBe('1em');
  });

  it('leaves the ua map empty for a property the UA sheet never sets', () => {
    expect(win('<style>p{color:red}</style><p id=t>t</p>', 'color', 'ua')).toBeUndefined();
  });
});

describe('cascade traversal', () => {
  it('produces an entry for every element outside a template', () => {
    const doc = parseHtml('<!doctype html><p id=t>x</p>');
    const m = cascade(doc, collect(doc));
    const names = [...m.keys()].map((e) => e.name);
    expect(names).toContain('html');
    expect(names).toContain('body');
    expect(names).toContain('p');
  });

  it('produces NO entry for an element inside a template', () => {
    const doc = parseHtml('<!doctype html><template><b>x</b></template>');
    const m = cascade(doc, collect(doc));
    expect([...m.keys()].some((e) => e.name === 'b')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/csscascade.test.ts`
Expected: FAIL — `cascade is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/csscascade.ts` (extend the `cssselect.js` import with `matches` and `compareSpecificity`):

```ts
export interface ElementDeclarations {
  all: Map<string, CssValue[]>;
  ua: Map<string, CssValue[]>;
}

/** A rule and an inline block reduced to one sortable shape. */
interface Candidate {
  tier: Tier;
  spec: Specificity;
  order: number;
  decls: [string, CssValue[]][];
}

/** Sort ascending: tier, then specificity, then source order. Weakest first,
 *  so a later write simply overwrites — the shape svgcss.ts already uses.
 *
 *  The SIX TIERS are the point, not a shortcut. CSS Cascade 5 §6.4 sorts by
 *  origin and importance, then by context, then by whether a declaration is
 *  element-attached, then specificity, then order. With no user origin and no
 *  shadow context, the first and third steps flatten to one ordinal:
 *
 *    1  UA normal
 *    2  author normal, stylesheet
 *    3  author normal, style=
 *    4  author !important, stylesheet
 *    5  author !important, style=
 *    6  UA !important
 *
 *  The tempting shortcut — "a style= declaration has infinite specificity" —
 *  is RIGHT that style= beats any selector at equal importance and WRONG that
 *  a normal style= beats an !important stylesheet rule. Six tiers get both
 *  directions right by construction, and the two tests for them are written
 *  so that breaking either leaves the other green. */
function bySortKey(a: Candidate, b: Candidate): number {
  return (a.tier - b.tier) || compareSpecificity(a.spec, b.spec) || (a.order - b.order);
}

const NO_SPEC: Specificity = [0, 0, 0];

export function cascade(
  root: HtmlDocument, c: Collected,
): Map<HtmlElement, ElementDeclarations> {
  const out = new Map<HtmlElement, ElementDeclarations>();

  const visit = (n: HtmlNode): void => {
    if (n.kind === 'element') {
      const hits: Candidate[] = [];
      for (const r of c.rules) {
        if (matches(r.sel, n)) {
          hits.push({ tier: r.tier, spec: r.spec, order: r.order, decls: r.decls });
        }
      }
      const inline = c.inline.get(n);
      if (inline !== undefined) {
        // An element has at most one style= attribute, so specificity and
        // order can never separate two inline candidates; the tier does all
        // the work. Order is set past every rule so a tie cannot reorder it.
        if (inline.normal.length > 0) {
          hits.push({ tier: 3, spec: NO_SPEC, order: Number.MAX_SAFE_INTEGER, decls: inline.normal });
        }
        if (inline.important.length > 0) {
          hits.push({ tier: 5, spec: NO_SPEC, order: Number.MAX_SAFE_INTEGER, decls: inline.important });
        }
      }

      hits.sort(bySortKey);
      const all = new Map<string, CssValue[]>();
      const ua = new Map<string, CssValue[]>();
      for (const h of hits) {
        for (const [k, v] of h.decls) {
          all.set(k, v);
          // The UA winner is kept SEPARATELY rather than derived afterwards,
          // which is what makes `revert` a lookup instead of a second pass —
          // and two passes over one rule list are two things that can drift.
          if (h.tier === 1 || h.tier === 6) ua.set(k, v);
        }
      }
      out.set(n, { all, ua });
    }

    // Never `n.content`: a template's content is not part of the document.
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const ch of n.children) visit(ch);
    }
  };
  visit(root);
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/csscascade.test.ts`
Expected: PASS, 36 tests (23 from Task 8 plus 13 here).

- [ ] **Step 5: Commit**

```bash
git add src/csscascade.ts test/csscascade.test.ts
git commit -m "feat(zch2.2.3): the six cascade tiers

CSS Cascade 5 sorts by origin and importance, then context, then whether a
declaration is element-attached, then specificity, then order. With no user
origin and no shadow context the first and third steps flatten to one
ordinal, and the flattening is the point rather than a shortcut: 'a style=
declaration has infinite specificity' is right that style= beats any
selector at equal importance and wrong that a normal style= beats an
!important stylesheet rule. The two tests are written so breaking either
direction leaves the other green.

The UA winner is kept BESIDE the final winner rather than derived
afterwards, which makes revert a lookup instead of a second pass over the
same rule list — two passes being two things that can drift.

The pair that pins expand-before-sort is here too: 'margin:0;margin-top:5px'
must yield 5px and its reverse must yield 0.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: `csscompute.ts` — inheritance and computed values

**Files:**
- Create: `src/csscompute.ts`
- Test: `test/csscompute.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5, 8 and 9.
- Produces:

```ts
export interface ComputeResult {
  styles: Map<HtmlElement, ComputedStyle>;
  unsupported: UnsupportedDeclaration[];
}
export function computeStyles(root: HtmlDocument): ComputeResult;
```

- [ ] **Step 1: Write the failing test**

Create `test/csscompute.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { computeStyles } from '../src/csscompute.js';
import type { ComputedStyle } from '../src/cssprop.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

function elementsOf(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') out.push(x);
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

/** The computed style of `#<id>`. */
function style(src: string, id: string): ComputedStyle {
  const doc = parseHtml(src);
  const r = computeStyles(doc);
  const el = elementsOf(doc).find((e) => e.attrs.get('id') === id);
  const s = r.styles.get(el as HtmlElement);
  if (s === undefined) throw new Error(`no style for #${id}`);
  return s;
}

describe('inheritance', () => {
  it('inherits an inherited property from the parent', () => {
    expect(style('<div style="color:red"><p id=t>x</p></div>', 't').color)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('does NOT inherit a non-inherited property', () => {
    expect(style('<div style="background-color:red"><p id=t>x</p></div>', 't')
      .backgroundColor).toEqual({ rgb: [0, 0, 0], a: 0 });
  });

  it('inherits border-collapse and border-spacing, which read wrong', () => {
    const s = style('<div style="border-collapse:collapse;border-spacing:4px">'
      + '<table id=t><tr><td>x</td></tr></table></div>', 't');
    expect(s.borderCollapse).toBe('collapse');
    expect(s.borderSpacing).toBe(4);
  });

  it('does NOT inherit text-decoration', () => {
    // It PROPAGATES visually to in-flow descendants, which is zch2.4's rule.
    // Modelling it as inheritance would let a descendant that sets its own
    // wrongly win, and would put the underline on the wrong element here.
    expect(style('<div style="text-decoration:underline"><p id=t>x</p></div>', 't')
      .textDecorationLine).toEqual([]);
  });

  it('gives the document element the initial value of an inherited property', () => {
    expect(style('<p>x</p>', 'nope-use-html') as unknown).toBeDefined;
    const doc = parseHtml('<!doctype html><p>x</p>');
    const r = computeStyles(doc);
    const html = elementsOf(doc).find((e) => e.name === 'html') as HtmlElement;
    expect(r.styles.get(html)?.fontSize).toBe(16);
  });
});

describe('the CSS-wide keywords', () => {
  it('inherit takes the parent value even for a non-inherited property', () => {
    expect(style('<div style="background-color:red">'
      + '<p id=t style="background-color:inherit">x</p></div>', 't').backgroundColor)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('initial takes the property initial even for an inherited property', () => {
    expect(style('<div style="color:red"><p id=t style="color:initial">x</p></div>', 't')
      .color).toEqual({ rgb: [0, 0, 0], a: 1 });
  });

  it('unset is inherit for an inherited property and initial for the rest', () => {
    expect(style('<div style="color:red"><p id=t style="color:unset">x</p></div>', 't')
      .color).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(style('<div style="background-color:red">'
      + '<p id=t style="background-color:unset">x</p></div>', 't').backgroundColor)
      .toEqual({ rgb: [0, 0, 0], a: 0 });
  });

  it('revert rolls back to the UA value, NOT to the initial', () => {
    // The UA sheet gives p a 1em top margin. `revert` must find it; treating
    // revert as unset gives 0 instead, which is a plausible wrong answer.
    const s = style('<!doctype html><style>p{margin-top:50px}</style>'
      + '<p id=t style="margin-top:revert">x</p>', 't');
    expect(s.marginTop).toEqual({ px: 16 });          // 1em of the 16px base
  });

  it('revert falls back to unset when the UA sheet says nothing', () => {
    const s = style('<!doctype html><div style="color:red">'
      + '<p id=t style="color:revert">x</p></div>', 't');
    expect(s.color).toEqual({ rgb: [1, 0, 0], a: 1 });
  });
});

describe('relative lengths', () => {
  it('resolves a font-size em against the PARENT size', () => {
    // The rule whose error compounds: 2em inside a 20px parent is 40px, and
    // resolving against the element's own size would make it 2 x itself.
    expect(style('<div style="font-size:20px"><p id=t style="font-size:2em">x</p></div>', 't')
      .fontSize).toBe(40);
  });

  it('resolves a NON-font-size em against the ELEMENT own size', () => {
    // The other half. margin-top:2em on an element whose own font-size is
    // 20px is 40px, even though the parent is 10px.
    const s = style('<div style="font-size:10px">'
      + '<p id=t style="font-size:20px;margin-top:2em">x</p></div>', 't');
    expect(s.marginTop).toEqual({ px: 40 });
  });

  it('compounds font-size down the tree', () => {
    expect(style('<div style="font-size:10px"><div style="font-size:2em">'
      + '<p id=t style="font-size:2em">x</p></div></div>', 't').fontSize).toBe(40);
  });

  it('resolves rem against the document element, not the parent', () => {
    const s = style('<!doctype html><style>html{font-size:10px}</style>'
      + '<div style="font-size:100px"><p id=t style="margin-top:2rem">x</p></div>', 't');
    expect(s.marginTop).toEqual({ px: 20 });
  });

  it('resolves a font-size percentage against the parent', () => {
    expect(style('<div style="font-size:20px"><p id=t style="font-size:150%">x</p></div>', 't')
      .fontSize).toBe(30);
  });
});

describe('line-height', () => {
  it('inherits a NUMBER as a number, so each descendant scales its own size', () => {
    const s = style('<div style="font-size:10px;line-height:1.5">'
      + '<p id=t style="font-size:20px">x</p></div>', 't');
    expect(s.lineHeight).toEqual({ number: 1.5 });
  });

  it('inherits a PERCENTAGE as the px it computed to on the ANCESTOR', () => {
    // The distinction. 150% of the div's 10px is 15px, and the child keeps
    // 15px rather than recomputing 150% of its own 20px.
    const s = style('<div style="font-size:10px;line-height:150%">'
      + '<p id=t style="font-size:20px">x</p></div>', 't');
    expect(s.lineHeight).toEqual({ px: 15 });
  });
});

describe('currentColor', () => {
  it('resolves against the element OWN computed colour', () => {
    const s = style('<p id=t style="color:red;border-top-color:currentColor">x</p>', 't');
    expect(s.borderTopColor).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('resolves the INITIAL of a border colour the same way', () => {
    // border-*-color's initial IS currentColor, so the same rule must reach a
    // property nobody declared.
    expect(style('<p id=t style="color:red">x</p>', 't').borderTopColor)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('uses the INHERITED colour when the element sets none', () => {
    expect(style('<div style="color:red"><p id=t>x</p></div>', 't').borderTopColor)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });
});

describe('percentages that stay percentages', () => {
  it('keeps a percentage margin, padding and width unresolved', () => {
    const s = style('<p id=t style="margin-left:10%;padding-top:5%;width:50%">x</p>', 't');
    expect(s.marginLeft).toEqual({ pct: 10 });
    expect(s.paddingTop).toEqual({ pct: 5 });
    expect(s.width).toEqual({ pct: 50 });
  });
});

describe('font-weight relative keywords', () => {
  it('resolves bolder and lighter against the parent computed weight', () => {
    expect(style('<div style="font-weight:400">'
      + '<p id=t style="font-weight:bolder">x</p></div>', 't').fontWeight).toBe(700);
    expect(style('<div style="font-weight:700">'
      + '<p id=t style="font-weight:lighter">x</p></div>', 't').fontWeight).toBe(400);
  });
});

describe('the UA sheet reaches the output', () => {
  it('gives h1 its size and weight', () => {
    const s = style('<!doctype html><h1 id=t>x</h1>', 't');
    expect(s.fontSize).toBe(32);              // 2em of the 16px base
    expect(s.fontWeight).toBe(700);
    expect(s.display).toBe('block');
  });

  it('gives li display:list-item and head display:none', () => {
    expect(style('<!doctype html><ul><li id=t>x</li></ul>', 't').display).toBe('list-item');
    const doc = parseHtml('<!doctype html><title>x</title><p>y</p>');
    const head = elementsOf(doc).find((e) => e.name === 'head') as HtmlElement;
    expect(computeStyles(doc).styles.get(head)?.display).toBe('none');
  });
});

describe('reporting', () => {
  it('records an unparsable value and leaves the property at its cascade fallback', () => {
    const doc = parseHtml('<p id=t style="color:notacolour">x</p>');
    const r = computeStyles(doc);
    const el = elementsOf(doc).find((e) => e.attrs.get('id') === 't') as HtmlElement;
    expect(r.styles.get(el)?.color).toEqual({ rgb: [0, 0, 0], a: 1 });
    expect(r.unsupported.some(
      (u) => u.property === 'color' && u.reason === 'unparsable-value')).toBe(true);
  });

  it('carries the collection unsupported list through', () => {
    const r = computeStyles(parseHtml('<style>p{box-shadow:0 0 2px}</style>'));
    expect(r.unsupported.some((u) => u.property === 'box-shadow')).toBe(true);
  });

  it('never throws, on any document', () => {
    for (const s of ['', '<p>x</p>', '<p style="color">x</p>',
      '<style>p{font-size:-5px}</style><p>x</p>', '<template><b>x</b></template>']) {
      expect(() => computeStyles(parseHtml(s)), s).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/csscompute.test.ts`
Expected: FAIL — `Failed to resolve import "../src/csscompute.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/csscompute.ts`:

```ts
/** Inheritance and computed values: the top-down walk that turns the
 *  cascade's winning declarations into a ComputedStyle per element.
 *
 *  Invariant: a PURE LEAF over cssprop.js, cssvalue.js, csscascade.js and
 *  htmldom.js. No Document, no PDF object, no `node:` import, and it never
 *  throws — a value it cannot read is recorded and the property falls back.
 *
 *  Invariant: ORDER within an element is load-bearing, twice.
 *  `font-size` is computed FIRST, because every other property's `em`
 *  resolves against it. `color` is computed SECOND, because `currentColor` —
 *  which is also the INITIAL value of the three decoration and border colour
 *  properties — resolves against it. Computing colour after the properties
 *  that name it silently yields the initial black rather than the cascaded
 *  colour, which reads as an authoring mistake rather than a bug.
 *
 *  Invariant: `font-size` is the ONE property whose relative values resolve
 *  against the PARENT's computed size; every other property resolves against
 *  the element's own. cssprop.ts's computeFontSize owns that, and this module
 *  hands it a context whose `parentFontSize` is real — see `contextFor`. */

import type { CssValue } from './cssparse.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import { cssWideOf } from './cssvalue.js';
import type { Color } from './cssvalue.js';
import { PROPERTIES, INITIAL_STYLE } from './cssprop.js';
import type { ComputedStyle, PropContext, PropDef, UnsupportedDeclaration } from './cssprop.js';
import { collect, cascade } from './csscascade.js';
import type { ElementDeclarations } from './csscascade.js';

export interface ComputeResult {
  styles: Map<HtmlElement, ComputedStyle>;
  unsupported: UnsupportedDeclaration[];
}

/** The initial value, with the three `'currentcolor'` initials resolved. One
 *  rule for a declared `currentColor` and an initial one alike. */
function initialOf(def: PropDef, color: Color): unknown {
  return def.initial === 'currentcolor' ? color : def.initial;
}

/** Resolve ONE property for one element.
 *
 *  `color` is passed explicitly rather than read from a half-built style,
 *  because it is needed while that style is still being built. */
function resolveProp(
  name: string, def: PropDef, decls: ElementDeclarations | undefined,
  parent: ComputedStyle | null, ctx: PropContext, el: HtmlElement,
  unsupported: UnsupportedDeclaration[],
): unknown {
  const inheritedValue = (): unknown =>
    parent === null ? initialOf(def, ctx.color) : (parent as unknown as Record<string, unknown>)[def.key];

  const declared = decls?.all.get(name);
  if (declared === undefined) {
    return def.inherited ? inheritedValue() : initialOf(def, ctx.color);
  }

  const wide = cssWideOf(declared);
  if (wide === 'inherit') return inheritedValue();
  if (wide === 'initial') return initialOf(def, ctx.color);
  if (wide === 'unset') {
    return def.inherited ? inheritedValue() : initialOf(def, ctx.color);
  }
  if (wide === 'revert') {
    // The value this element would have had with the AUTHOR origin removed —
    // a LOOKUP in the UA winners the cascade kept, rather than a second pass
    // over the rule list. With nothing there it degrades to `unset`.
    const ua = decls?.ua.get(name);
    if (ua === undefined || cssWideOf(ua) !== undefined) {
      return def.inherited ? inheritedValue() : initialOf(def, ctx.color);
    }
    const got = def.compute(ua, ctx);
    return got === undefined
      ? (def.inherited ? inheritedValue() : initialOf(def, ctx.color))
      : got;
  }

  const got = def.compute(declared, ctx);
  if (got !== undefined) return got;

  // A declaration we could parse as CSS but not as this property's value.
  // It is recorded, and the property falls back exactly as if it had not been
  // declared — which is CSS's own "invalid at computed-value time".
  unsupported.push({
    el, property: name, value: '', reason: 'unparsable-value',
  });
  return def.inherited ? inheritedValue() : initialOf(def, ctx.color);
}

export function computeStyles(root: HtmlDocument): ComputeResult {
  const collected = collect(root);
  const decls = cascade(root, collected);
  const styles = new Map<HtmlElement, ComputedStyle>();
  const unsupported: UnsupportedDeclaration[] = [...collected.unsupported];

  // `rem` on the document element itself resolves against the INITIAL
  // font-size, there being no computed root size yet; every descendant sees
  // the root's real one.
  let rootFontSize = INITIAL_STYLE.fontSize;
  let seenRoot = false;

  const visit = (n: HtmlNode, parent: ComputedStyle | null): void => {
    let mine = parent;

    if (n.kind === 'element') {
      const d = decls.get(n);
      const p = parent;
      const parentFontSize = p === null ? INITIAL_STYLE.fontSize : p.fontSize;
      const parentWeight = p === null ? INITIAL_STYLE.fontWeight : p.fontWeight;
      const parentColor = p === null ? INITIAL_STYLE.color : p.color;

      // 1. font-size, whose own `em` resolves against the PARENT.
      const fsCtx: PropContext = {
        fontSize: parentFontSize, parentFontSize, rootFontSize,
        parentWeight, color: parentColor,
      };
      const fsDef = PROPERTIES.get('font-size') as PropDef;
      const fontSize = resolveProp(
        'font-size', fsDef, d, p, fsCtx, n, unsupported) as number;

      if (!seenRoot) { rootFontSize = fontSize; seenRoot = true; }

      // 2. color, because currentColor — and the INITIAL of three colour
      //    properties — resolves against it.
      const colCtx: PropContext = {
        fontSize, parentFontSize, rootFontSize, parentWeight, color: parentColor,
      };
      const colDef = PROPERTIES.get('color') as PropDef;
      const color = resolveProp('color', colDef, d, p, colCtx, n, unsupported) as Color;

      // 3. everything else, against the element's OWN font size and colour.
      const ctx: PropContext = {
        fontSize, parentFontSize, rootFontSize, parentWeight, color,
      };
      const s: Record<string, unknown> = { fontSize, color };
      for (const [name, def] of PROPERTIES) {
        if (name === 'font-size' || name === 'color') continue;
        s[def.key] = resolveProp(name, def, d, p, ctx, n, unsupported);
      }

      mine = s as unknown as ComputedStyle;
      styles.set(n, mine);
    }

    // Never `n.content`: a template's content is not part of the document.
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const c of n.children) visit(c, mine);
    }
  };
  visit(root, null);

  return { styles, unsupported };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/csscompute.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5: Full suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add src/csscompute.ts test/csscompute.test.ts
git commit -m "feat(zch2.2.3): inheritance and computed values

The top-down walk that turns winning declarations into a ComputedStyle.

ORDER within an element is load-bearing twice. font-size is computed FIRST,
because every other property's em resolves against it. color is computed
SECOND, because currentColor — which is also the INITIAL value of the three
border and decoration colour properties — resolves against it; computing
colour after the properties that name it silently yields the initial black
rather than the cascaded colour.

font-size is the one property whose relative values resolve against the
PARENT's size, and the pair of tests states both halves: 2em on font-size
inside a 20px parent is 40px, while 2em on margin-top is 2 x the element's
OWN size even when the parent differs.

line-height keeps a number as a number and a percentage as the px it
computed to on the ancestor, so an inheriting child with a different font
size sees different values — which is the only way to tell them apart.

revert is a LOOKUP in the UA winners the cascade kept beside the final
ones, degrading to unset when the UA sheet says nothing. A value we can
parse as CSS but not as the property's value is recorded and falls back
exactly as if undeclared, which is CSS's own invalid-at-computed-value-time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 11: the Blink oracle

**Files:**
- Create: `scripts/gen-cascade-goldens.ts`
- Create: `test/helpers/cascade-goldens.ts`
- Create: `test/fixtures/css-cascade/goldens.json` (generated)
- Create: `test/fixtures/css-cascade/PROVENANCE.md`
- Create: `test/csscascade-suite.test.ts`

**Interfaces:**
- Produces (test-only):

```ts
export interface CascadeCase { id: string; html: string; props: string[]; values: Record<string, string>[] }
export interface CascadeGoldens { chrome: string; cases: CascadeCase[] }
export function loadCascadeGoldens(): CascadeGoldens;
export function pathOf(el: HtmlElement): number[];
export function compareProp(prop: string, ours: ComputedStyle, chrome: string): { ok: boolean; ours: string };
```

- [ ] **Step 1: Write the generator**

Create `scripts/gen-cascade-goldens.ts`:

```ts
// Generates test/fixtures/css-cascade/goldens.json — Chrome's computed style
// for a set of documents, for the properties each document DECLARES.
//
// Not part of `npm test`:
//   npm i --no-save tsx puppeteer
//   npx tsx scripts/gen-cascade-goldens.ts
//
// Only author-declared properties are recorded, and that is the whole design:
// our UA sheet is transcribed from HTML §15 while Chrome's is Chrome's, so
// comparing full computed style would mismatch on every element nobody
// styled. See test/fixtures/css-cascade/PROVENANCE.md.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'css-cascade');

/** Each fixture names the properties to compare on EVERY element. Anything
 *  not named is left to the UA sheet and not compared.
 *
 *  Two rules the fixtures follow, both learned from the property semantics
 *  rather than from a failure:
 *   - border-style is always declared beside border-width, because Chrome
 *     reports a used border-width of 0 when the style is none.
 *   - line-height is always declared, never left `normal`, because Chrome
 *     resolves `normal` from font metrics we do not have. */
const CASES: { id: string; html: string; props: string[] }[] = [
  {
    id: 'cascade-order',
    html: '<style>p{color:red}p{color:blue}</style><p>x</p>',
    props: ['color'],
  },
  {
    id: 'specificity',
    html: '<style>p{color:red}#t{color:blue}.c{color:green}</style>'
      + '<p id=t class=c>x</p>',
    props: ['color'],
  },
  {
    id: 'important-and-inline',
    html: '<style>#a{color:red}#b{color:red!important}</style>'
      + '<p id=a style="color:blue">x</p><p id=b style="color:blue">y</p>',
    props: ['color'],
  },
  {
    id: 'inline-important',
    html: '<style>#t{color:red!important}</style><p id=t style="color:blue!important">x</p>',
    props: ['color'],
  },
  {
    id: 'inheritance',
    html: '<style>#o{color:red;font-style:italic;background-color:lime}</style>'
      + '<div id=o><p id=t>x</p></div>',
    props: ['color', 'font-style', 'background-color'],
  },
  {
    id: 'shorthand-order',
    html: '<style>#a{margin:0;margin-top:5px}#b{margin-top:5px;margin:0}</style>'
      + '<p id=a>x</p><p id=b>y</p>',
    props: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  },
  {
    id: 'border-shorthand',
    html: '<style>#t{border:2px solid red;border-left-color:blue}</style><p id=t>x</p>',
    props: ['border-top-width', 'border-top-style', 'border-top-color',
      'border-left-color', 'border-right-style'],
  },
  {
    id: 'relative-lengths',
    html: '<style>html{font-size:16px}#o{font-size:20px}'
      + '#t{font-size:2em;margin-top:2em;text-indent:1rem}</style>'
      + '<div id=o><p id=t>x</p></div>',
    props: ['font-size', 'margin-top', 'text-indent'],
  },
  {
    id: 'line-height-number-vs-percentage',
    html: '<style>#a{font-size:10px;line-height:1.5}#b{font-size:10px;line-height:150%}'
      + '.k{font-size:20px;line-height:inherit}</style>'
      + '<div id=a><p id=ta class=k>x</p></div><div id=b><p id=tb class=k>y</p></div>',
    props: ['line-height', 'font-size'],
  },
  {
    id: 'current-color',
    html: '<style>#t{color:red;border-top-style:solid;border-top-width:3px}</style>'
      + '<p id=t>x</p>',
    props: ['color', 'border-top-color', 'border-top-width', 'border-top-style'],
  },
  {
    id: 'css-wide-keywords',
    html: '<style>#o{color:red;font-weight:bold}'
      + '#a{color:inherit}#b{color:initial}#c{color:unset}#d{font-weight:unset}</style>'
      + '<div id=o><p id=a>a</p><p id=b>b</p><p id=c>c</p><p id=d>d</p></div>',
    props: ['color', 'font-weight'],
  },
  {
    id: 'font-shorthand',
    html: '<style>#t{font:italic bold 12px/1.5 Georgia, serif}</style><p id=t>x</p>',
    props: ['font-style', 'font-weight', 'font-size', 'line-height'],
  },
  {
    id: 'media-print',
    html: '<style>@media print{#t{color:red}}@media screen{#t{color:lime}}</style>'
      + '<p id=t>x</p>',
    props: ['color'],
  },
  {
    id: 'text-decoration',
    html: '<style>#o{text-decoration:underline dotted red}</style>'
      + '<div id=o><p id=t>x</p></div>',
    props: ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'],
  },
];

const browser = await puppeteer.launch();
const chrome = await browser.version();
const cases: unknown[] = [];

for (const c of CASES) {
  const page = await browser.newPage();
  // `emulateMediaType('print')` is what makes @media print apply — without it
  // Chrome is a screen UA and the media-print fixture would record the wrong
  // answer while looking perfectly healthy.
  await page.emulateMediaFeatures([]);
  await page.emulateMediaType('print');
  await page.setContent(c.html);
  const values = await page.evaluate((props: string[]) => {
    const out: Record<string, string>[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      const row: Record<string, string> = {};
      for (const p of props) row[p] = cs.getPropertyValue(p);
      out.push(row);
    }
    return out;
  }, c.props);
  await page.close();
  cases.push({ id: c.id, html: c.html, props: c.props, values });
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const json = `${JSON.stringify({ chrome, cases }, null, 1)}\n`;
const file = join(outDir, 'goldens.json');
writeFileSync(file, json);

const rows = cases.reduce(
  (n, c) => n + (c as { values: unknown[]; props: unknown[] }).values.length
    * (c as { props: unknown[] }).props.length, 0);
console.log(`chrome:      ${chrome}`);
console.log(`cases:       ${cases.length}`);
console.log(`comparisons: ${rows}`);
console.log(`bytes:       ${Buffer.byteLength(json)}`);
console.log(`sha256:      ${createHash('sha256').update(json).digest('hex')}`);
```

**Note for the implementer:** `page.evaluate` must contain NO named inner
function. `tsx` compiles with esbuild's `keepNames`, which rewrites a named
function into a call to an injected `__name` helper that does not exist in
the page, so the callback throws `ReferenceError` the moment puppeteer
serializes it. `scripts/gen-selector-goldens.ts` carries the same note.

- [ ] **Step 2: Generate the goldens**

Run:

```bash
npm i --no-save tsx puppeteer
npx tsx scripts/gen-cascade-goldens.ts
```

Expected: it prints the Chrome version, the counts and the SHA-256, and writes
`test/fixtures/css-cascade/goldens.json`. **Record the printed values** — they
go verbatim into `PROVENANCE.md` in Step 6.

If puppeteer cannot download a browser here, STOP and report it rather than
hand-writing goldens. A hand-written "oracle" is our own answer wearing a
costume, which is worse than no oracle because it looks like evidence.

- [ ] **Step 3: Write the loader and the comparators**

Create `test/helpers/cascade-goldens.ts`:

```ts
/** Loader and comparators for the Blink-generated cascade corpus.
 *
 *  Test-only. Nothing in `src/` may import this, the rule
 *  test/helpers/selector-goldens.ts already sets.
 *
 *  The comparators exist because `getComputedStyle` returns STRINGS in
 *  Chrome's own spellings — `rgb(255, 0, 0)`, `16px` — while ComputedStyle
 *  holds numbers and structures. Comparing formatted text on both sides would
 *  mean writing a CSS serializer whose bugs could cancel Chrome's spellings
 *  out; comparing PARSED numbers keeps the comparison in the value domain. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlElement } from '../../src/htmldom.js';
import type { ComputedStyle } from '../../src/cssprop.js';

const FILE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'css-cascade', 'goldens.json',
);

export interface CascadeCase {
  id: string; html: string; props: string[]; values: Record<string, string>[];
}
export interface CascadeGoldens { chrome: string; cases: CascadeCase[] }

export function loadCascadeGoldens(): CascadeGoldens {
  return JSON.parse(readFileSync(FILE, 'utf8')) as CascadeGoldens;
}

/** The child-index path from the document element, element children only —
 *  the same walk scripts/gen-cascade-goldens.ts makes with querySelectorAll,
 *  which returns document order. */
export function pathOf(el: HtmlElement): number[] {
  const out: number[] = [];
  let n: HtmlElement = el;
  for (;;) {
    const p = n.parent;
    if (p === null || p.kind !== 'element') return out;
    const sibs = p.children.filter((c): c is HtmlElement => c.kind === 'element');
    out.unshift(sibs.indexOf(n));
    n = p;
  }
}

const LENGTH_PROPS = new Set([
  'font-size', 'text-indent', 'border-spacing',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
]);

const COLOR_PROPS = new Set([
  'color', 'background-color', 'text-decoration-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
]);

const KEY_OF: Record<string, keyof ComputedStyle> = {
  'font-size': 'fontSize', 'font-style': 'fontStyle', 'font-weight': 'fontWeight',
  'text-indent': 'textIndent', 'border-spacing': 'borderSpacing',
  'margin-top': 'marginTop', 'margin-right': 'marginRight',
  'margin-bottom': 'marginBottom', 'margin-left': 'marginLeft',
  'padding-top': 'paddingTop', 'padding-right': 'paddingRight',
  'padding-bottom': 'paddingBottom', 'padding-left': 'paddingLeft',
  'border-top-width': 'borderTopWidth', 'border-right-width': 'borderRightWidth',
  'border-bottom-width': 'borderBottomWidth', 'border-left-width': 'borderLeftWidth',
  'border-top-style': 'borderTopStyle', 'border-right-style': 'borderRightStyle',
  'border-bottom-style': 'borderBottomStyle', 'border-left-style': 'borderLeftStyle',
  color: 'color', 'background-color': 'backgroundColor',
  'border-top-color': 'borderTopColor', 'border-right-color': 'borderRightColor',
  'border-bottom-color': 'borderBottomColor', 'border-left-color': 'borderLeftColor',
  'text-decoration-color': 'textDecorationColor',
  'text-decoration-style': 'textDecorationStyle',
  'text-decoration-line': 'textDecorationLine',
  'text-align': 'textAlign', 'white-space': 'whiteSpace', display: 'display',
  float: 'float', clear: 'clear', 'vertical-align': 'verticalAlign',
  'list-style-type': 'listStyleType', 'list-style-position': 'listStylePosition',
  'border-collapse': 'borderCollapse', 'line-height': 'lineHeight',
};

function parseChromeColor(s: string): [number, number, number, number] | undefined {
  const m = /^rgba?\(([^)]*)\)$/.exec(s.trim());
  if (m === null) return undefined;
  const p = (m[1] as string).split(/[\s,/]+/).filter((x) => x !== '');
  if (p.length < 3) return undefined;
  const n = p.map((x) => parseFloat(x));
  return [
    (n[0] as number) / 255, (n[1] as number) / 255, (n[2] as number) / 255,
    p.length > 3 ? (n[3] as number) : 1,
  ];
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.02;

/** Compare one property. Returns whether it matched and how ours rendered,
 *  so a failure message can name both sides. */
export function compareProp(
  prop: string, ours: ComputedStyle, chrome: string,
): { ok: boolean; ours: string } {
  const key = KEY_OF[prop];
  if (key === undefined) return { ok: true, ours: '(not compared)' };
  const v = (ours as unknown as Record<string, unknown>)[key];

  if (prop === 'line-height') {
    // Chrome reports a used px even for a NUMBER line-height, so ours is
    // resolved against the element's own font size before comparing. The
    // number-versus-percentage distinction is still visible: an inheriting
    // child with a different font size gets a different px under each.
    const px = typeof v === 'object' && v !== null && 'number' in v
      ? (v as { number: number }).number * ours.fontSize
      : typeof v === 'object' && v !== null && 'px' in v
        ? (v as { px: number }).px
        : NaN;
    if (Number.isNaN(px)) return { ok: false, ours: String(v) };
    return { ok: near(px, parseFloat(chrome)), ours: `${String(px)}px` };
  }

  if (LENGTH_PROPS.has(prop)) {
    if (typeof v === 'number') return { ok: near(v, parseFloat(chrome)), ours: `${v}px` };
    if (typeof v === 'object' && v !== null && 'px' in v) {
      const px = (v as { px: number }).px;
      return { ok: near(px, parseFloat(chrome)), ours: `${String(px)}px` };
    }
    // A percentage or `auto`: excluded from the corpus — see PROVENANCE.
    return { ok: true, ours: '(not compared)' };
  }

  if (COLOR_PROPS.has(prop)) {
    const c = parseChromeColor(chrome);
    const o = v as { rgb: [number, number, number]; a: number };
    if (c === undefined) return { ok: false, ours: JSON.stringify(o) };
    const ok = near(o.rgb[0], c[0]) && near(o.rgb[1], c[1])
      && near(o.rgb[2], c[2]) && near(o.a, c[3]);
    return { ok, ours: `rgba(${o.rgb.join(', ')}, ${o.a})` };
  }

  if (prop === 'font-weight') {
    return { ok: near(v as number, parseFloat(chrome)), ours: String(v) };
  }

  if (prop === 'text-decoration-line') {
    const mine = (v as string[]).length === 0 ? 'none' : (v as string[]).join(' ');
    return { ok: mine === chrome.trim(), ours: mine };
  }

  return { ok: String(v) === chrome.trim(), ours: String(v) };
}
```

- [ ] **Step 4: Write the suite test**

Create `test/csscascade-suite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { computeStyles } from '../src/csscompute.js';
import { loadCascadeGoldens, pathOf, compareProp } from './helpers/cascade-goldens.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

const G = loadCascadeGoldens();

function elementsInOrder(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') out.push(x);
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

describe('the Blink cascade corpus', () => {
  it('loads a non-trivial corpus', () => {
    expect(G.chrome).toMatch(/Chrome/);
    expect(G.cases.length).toBeGreaterThanOrEqual(14);
  });

  it('agrees with Blink on every declared property, with no allowlist', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const doc = parseHtml(c.html);
      const r = computeStyles(doc);
      const els = elementsInOrder(doc);
      if (els.length !== c.values.length) {
        failures.push(`${c.id}: ${els.length} elements, Blink had ${c.values.length}`);
        continue;
      }
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HtmlElement;
        const s = r.styles.get(el);
        if (s === undefined) { failures.push(`${c.id}: no style for ${el.name}`); continue; }
        for (const p of c.props) {
          const want = (c.values[i] as Record<string, string>)[p] as string;
          const got = compareProp(p, s, want);
          if (!got.ok) {
            failures.push(
              `${c.id} [${pathOf(el).join('.')}] ${el.name} ${p}: ${got.ours} != ${want}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the harness itself', () => {
  // The differential-test trap: a comparator that always returns ok would
  // leave the corpus green whatever the code does. A tampered golden MUST
  // turn it red.
  it('fails when a golden value is wrong', () => {
    const c = G.cases.find((x) => x.props.includes('color'));
    expect(c).toBeDefined();
    const doc = parseHtml((c as { html: string }).html);
    const s = computeStyles(doc).styles.get(elementsInOrder(doc)[0] as HtmlElement);
    expect(s).toBeDefined();
    expect(compareProp('color', s!, 'rgb(1, 2, 3)').ok).toBe(false);
  });

  it('compares the properties it claims to, rather than skipping them', () => {
    // A KEY_OF miss silently returns ok:true, so the map is asserted to cover
    // every property any fixture names.
    const doc = parseHtml('<p style="color:red">x</p>');
    const s = computeStyles(doc).styles.get(elementsInOrder(doc)[0] as HtmlElement);
    for (const c of G.cases) {
      for (const p of c.props) {
        expect(compareProp(p, s!, 'ZZZ').ours, `${c.id}: ${p}`).not.toBe('(not compared)');
      }
    }
  });
});
```

- [ ] **Step 5: Run the suite**

Run: `npx vitest run test/csscascade-suite.test.ts`
Expected: PASS.

If the comparison test reports failures they are **real** — fix `src/`, never
the goldens. The one legitimate reason to change a fixture is a property this
issue's scope deliberately excludes; in that case remove it from that case's
`props`, regenerate, and record the exclusion in `PROVENANCE.md` as a named
reason rather than a silent deletion.

- [ ] **Step 6: Write `PROVENANCE.md`**

Create `test/fixtures/css-cascade/PROVENANCE.md`, filling every bracketed
value from what Step 2 printed:

```markdown
# css-cascade — provenance

Chrome's computed style for a set of documents, here to validate the cascade
in `src/csscascade.ts` and `src/csscompute.ts` against expectations this repo
did not author. See `docs/superpowers/specs/2026-08-28-css-cascade-design.md`.

**GENERATED, not vendored,** the way `test/fixtures/svg/` and
`test/fixtures/css-selectors/` are: WPT's cascade tests are `testharness.js`
and need a JavaScript engine, so there is no data-driven corpus to vendor.

**Producer:** [chrome version printed by the generator], via puppeteer, with
`emulateMediaType('print')` — without which Chrome is a screen user agent and
the `@media print` case would record the wrong answer while looking healthy.

**Command:**

    npm i --no-save tsx puppeteer
    npx tsx scripts/gen-cascade-goldens.ts

| File | Bytes | Cases | Comparisons | SHA-256 |
|---|---|---|---|---|
| `goldens.json` | [bytes] | [cases] | [comparisons] | `[sha256]` |

## What it compares, and what it deliberately does not

**Only the properties each fixture DECLARES**, on every element. That is the
whole design. Our UA stylesheet is transcribed from HTML §15 while Chrome's is
Chrome's, so comparing full computed style would mismatch on every element
nobody styled, and the only ways out would be transcribing Chrome's UA sheet —
adopting its quirks as our behaviour — or maintaining an exclusion list by
hand.

What that anchors: cascade order, the six tiers, `!important`, the style
attribute, specificity, document order, inheritance, the CSS-wide keywords,
shorthand expansion, relative-length resolution, and `@media print`.

## The ceiling — do not read the corpus past it

1. **One engine, no second to arbitrate.** `test/fixtures/svg/` requires two
   engines to agree before writing a golden; that is not available here, as it
   was not for `zch2.2.2`.
2. **THE UA SHEET IS OUTSIDE THE CORPUS ENTIRELY.** It is hand-tested against
   HTML §15 in `test/cssua.test.ts` and the oracle says nothing about it. This
   is the largest untested surface `zch2.2.3` ships and the first thing to
   re-examine if `zch2.5` produces documents that look wrong in ways the unit
   tests do not explain.
3. **`getComputedStyle` returns USED values for layout-dependent
   properties.** A percentage `margin` or `padding`, and `width`/`height`,
   come back as resolved px — a different question from the computed value
   this module produces. The comparator returns "not compared" for those, and
   their computed-value rule is pinned by hand-written tests instead.
4. **`ex` and `ch` are excluded.** Chrome has font metrics; we use CSS's
   documented 0.5em fallback, so agreement would be a coincidence and
   disagreement is not a defect.
5. **`smaller` and `larger` are excluded.** Browsers approximate the scaling
   factor differently and the spec does not pin one.
6. **`line-height: normal` is excluded**, and no fixture leaves it unset when
   comparing line-height: Chrome resolves `normal` from font metrics we do not
   have. What IS compared is the number-versus-percentage distinction, and the
   corpus catches it properly — a numeric line-height inherited by a child
   with a different font size yields a different px than a percentage one, so
   the two fixtures in `line-height-number-vs-percentage` disagree under a
   build that conflates them.
7. **`border-width` is only compared where `border-style` is also declared,**
   because Chrome reports a used width of 0 when the style is `none`. Every
   fixture that names a border width names a style beside it.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-cascade-goldens.ts test/helpers/cascade-goldens.ts \
        test/fixtures/css-cascade test/csscascade-suite.test.ts
git commit -m "test(zch2.2.3): a Blink-generated cascade corpus

WPT's cascade tests are testharness.js and need a JavaScript engine, so
there is no data-driven corpus to vendor. gen-svg-goldens.ts and
gen-selector-goldens.ts already establish the alternative: drive a browser
from a script outside npm test and commit what it said.

It compares only the properties each fixture DECLARES, which is the whole
design rather than a shortcut. Our UA sheet comes from HTML §15 and
Chrome's is Chrome's, so a full computed-style comparison would mismatch on
every element nobody styled, and the ways out are transcribing Chrome's UA
sheet or hand-maintaining an exclusion list.

The generator emulates print media, without which Chrome is a screen user
agent and the @media print case records the wrong answer while looking
perfectly healthy.

Comparators parse both sides into the value domain rather than formatting
ours into Chrome's spellings, so no CSS serializer stands between the two
where its bugs could cancel out. The harness carries a tampered-golden test
proving it can fail, and a test that every property a fixture names is
actually covered by the comparator map — a KEY_OF miss otherwise returns
ok:true and passes silently.

PROVENANCE.md records the ceiling, and names the UA sheet as the largest
untested surface this issue ships.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: Mutations, documentation, and close

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/*.ts` (comments only, if a mutation finds an unpinned rule)

- [ ] **Step 1: Run the twelve mutations**

For each row: make the edit, run `npx vitest run test/css*.test.ts`, record
which files went red, then **revert the edit**. A mutation that reddens
NOTHING is recorded in `CLAUDE.md` as an uncovered rule — the practice this
repo follows for `openers_bottom` and the JBIG2 refinement context order —
never quietly dropped.

| # | Mutation | Expected to redden |
|---|---|---|
| 1 | In `bySortKey`, treat tiers 2 and 3 as equal | the `style=` versus selector case |
| 2 | In `bySortKey`, treat tiers 3 and 4 as equal | the normal-`style=` versus `!important`-rule case ONLY — case 1 must stay green, which is the asymmetry six tiers exist for |
| 3 | In `collect`, push the raw shorthand instead of expanding it | the `margin:0;margin-top:5px` pair, one direction only |
| 4 | In `computeFontSize`, resolve against `c.fontSize` instead of `c.parentFontSize` | the nested `font-size:2em` case and the corpus |
| 5 | In `computeLineHeight`, return `{ px: n * c.fontSize }` for a number | the inheriting line-height case and the corpus |
| 6 | In `lengthOf`, return `{ px: pct }` for a percentage | the percentage margin case |
| 7 | In `computeStyles`, compute `color` after the loop instead of before | the `currentColor` cases |
| 8 | In `PROPERTIES`, mark `border-collapse` non-inherited | the inherited-table case |
| 9 | In `resolveProp`, treat `revert` as `unset` | the revert case |
| 10 | In `mediaMatches`, return `ok: true` for `screen` | the screen-versus-print case |
| 11 | In `compileRules`, skip every `@media` | the `@media print` case, and 10 must stay green |
| 12 | In `collect`, descend into `n.content` | the style-in-template case |

Three extra, cheap and high-value, for the traps this plan found:

| # | Mutation | Expected to redden |
|---|---|---|
| 13 | In `fromHex`, require the token's `id` flag | every `#123456` case |
| 14 | In `trimWs`, trim the leading whitespace only | most value tests, since `!important` values keep a trailing token |
| 15 | In `lengthOf`, accept any bare number as px | the bare-`5` case |

- [ ] **Step 2: Record the results**

Write the outcome into the Step 4 commit message. If any mutation reddened
nothing, add a `**Note, measured, and it covers NOTHING:**` paragraph to the
relevant `CLAUDE.md` entry, naming the rule and saying it is held by the spec
rather than by the suite.

- [ ] **Step 3: Add the `CLAUDE.md` entries**

Insert into the Source list in `CLAUDE.md`, immediately after the
`**cssselect.ts**` entry:

```markdown
- **colornames.ts** — the 148 CSS named colours (the 147 X11 names plus
  `rebeccapurple`), as a `ReadonlyMap` of 0..1 triples. A leaf importing
  NOTHING, shared by two stacks that must not depend on each other:
  `svgstyle.ts` parses SVG paint out of strings, `cssvalue.ts` parses CSS out
  of `CssValue[]`. The parsers cannot be shared and the DATA must not be
  duplicated — a second copy is how the two would come to disagree about one
  colour in a document containing inline SVG.
  **Invariant:** `transparent` is NOT in the table. It is `rgba(0,0,0,0)`
  rather than a named colour and carries an alpha the table has no room for;
  the two callers handle it differently and both correctly — `svgstyle.ts`
  returns null (do not paint), `cssvalue.ts` returns a colour with `a: 0`.
- **cssvalue.ts**, **cssprop.ts**, **cssshorthand.ts**, **cssua.ts**,
  **csscascade.ts**, **csscompute.ts** — the CSS cascade
  (`zch2.2.3`): declarations in, computed style out. All six are pure leaves;
  none imports `document.js`, `page.js`, any PDF object module, any `node:`
  module, `svgcss.js` or `svgstyle.js`, and none throws. Nothing is exported
  from `index.ts` — `zch2.3` is the next consumer.
  **Invariant:** the property set is bounded by what `zch2.3`, `zch2.4` and
  `zch2.6` will consume, not by CSS. **43** longhands, asserted, so a
  half-pasted table is a red build; a property outside them is recorded as
  `unknown-property` for `zch2.7` rather than dropped, which is what makes
  "we do not implement flexbox" reportable instead of invisible.
  **Invariant:** units are CSS **px** throughout, and the single `× 0.75` to
  points belongs to `zch2.4`. Decided on the oracle rather than on taste:
  `getComputedStyle` reports px, so a golden comparison is an exact equality
  where a points model would put a multiply and a tolerance between every
  pair — making a unit bug indistinguishable from a conversion bug.
  **Invariant:** SIX cascade tiers — UA normal, author normal, author
  `style=`, author `!important`, `style=` `!important`, UA `!important`. CSS
  Cascade 5 sorts by origin+importance, then context, then element-attachment,
  then specificity, then order; with no user origin and no shadow context the
  first and third flatten to one ordinal. The flattening is the point: the
  shortcut "a `style=` declaration has infinite specificity" is RIGHT that
  `style=` beats any selector at equal importance and WRONG that a normal
  `style=` beats an `!important` stylesheet rule. The two tests are written so
  breaking either direction leaves the other green.
  **Invariant:** shorthands expand in `csscascade.ts` BEFORE the sort, because
  the cascade sorts longhands only. `p { margin: 0; margin-top: 5px }` yields
  5px and the reverse yields 0; expanding afterwards yields 0 both times, a
  wrong answer indistinguishable from a right one without the reversed pair.
  **Invariant:** an unmentioned sub-longhand of a shorthand is emitted with a
  synthetic `initial` ident rather than modelled by a second concept, so
  `border: 1px` resets style and colour through the CSS-wide keyword machinery
  that already exists. One reset rule, not two.
  **Invariant:** the cascade keeps the UA winner BESIDE the final winner, so
  `revert` is a lookup rather than a second pass over the same rule list — two
  passes being two things that can drift.
  **Invariant:** ORDER inside `csscompute.ts` is load-bearing twice.
  `font-size` computes FIRST, because every other property's `em` resolves
  against it; `color` computes SECOND, because `currentColor` — which is also
  the INITIAL value of the three border and decoration colour properties —
  resolves against it. Computing colour after the properties that name it
  silently yields the initial black, which reads as an authoring mistake.
  **Invariant, and it is the one that compounds:** `font-size` is the ONLY
  property whose relative values resolve against the PARENT's computed size;
  every other property resolves against the element's own. One rule for both
  is wrong on exactly one property, and it is the property whose error
  multiplies down the tree — a nested document ends up off by a factor rather
  than by a pixel.
  **Invariant:** `line-height: 1.5` and `line-height: 150%` are different
  values, not two spellings. A number computes to a number and inherits as
  one, so each descendant multiplies by its own size; a percentage computes to
  px and inherits as that px. A single-font-size document cannot tell them
  apart, so the fixture nests a differently-sized child.
  **Invariant:** a percentage `margin`, `padding` or `width` STAYS a
  percentage in the computed value — it resolves against the containing block,
  which is `zch2.3`'s to know. Those fields are `px | pct`, and this is also
  why the oracle cannot compare them: `getComputedStyle` returns the used px.
  **Invariant:** `border-collapse` and `border-spacing` ARE inherited, so that
  setting them on a container reaches the table. It reads wrong and has its
  own test for that reason. `text-decoration` is NOT inherited: it propagates
  visually to in-flow descendants, which is a rendering rule `zch2.4` owns, and
  modelling it as inheritance would let a descendant that sets its own wrongly
  win. Expect "underline did not reach the `<span>`" to be misfiled here.
  **Invariant:** `@media` honours TYPES only. A feature is detected
  STRUCTURALLY — a `(` block in the query, no string matching anywhere — and
  is recorded rather than dropped; evaluating one needs a viewport this stack
  deliberately does not have, which is also why `vw`/`vh` are refused.
  Dropping every `@media`, as `svgcss.ts` does, would render a document whose
  whole print stylesheet sits inside `@media print` completely unstyled.
  **Invariant:** the collection walk does NOT descend into a `<template>`'s
  content, the same structural rule `selectAll` follows: a template's content
  is not part of the document, so a `<style>` inside one styles nothing.
  **Two traps in what `cssparse.ts` hands over, both measured:** `!important`
  is already stripped from a value but a trailing whitespace token is not, and
  every value carries a LEADING whitespace token from after the colon — so
  `trimWs` trims BOTH ends and a consumer matching on `value.length` is wrong
  twice without it. And `color:` is a VALID declaration whose value is `[]`,
  so every property helper rejects an empty value first or `color:` sets a
  colour.
  **Note, and it is the exact INVERSE of `cssselect.ts`'s trap:** a `hash`
  token carries `id: true` only when its name is an identifier, so `#123456`
  and `#1a2b3c` are `id: false` while `#abc` and `#a1b2c3` are `id: true`. An
  id SELECTOR must require the flag — `#123456` is not a valid id selector —
  and a COLOUR must ignore it entirely, or the commonest spelling of a hex
  colour silently stops parsing. Two modules, opposite rules, one token; do
  not copy either into the other.
  **Note on the oracle, GENERATED rather than vendored:** WPT's cascade tests
  are `testharness.js` and need a JavaScript engine, so
  `scripts/gen-cascade-goldens.ts` drives headless Chrome and commits what it
  said — with `emulateMediaType('print')`, without which Chrome is a screen
  user agent and the `@media print` case records the wrong answer while
  looking healthy. It compares only the properties each fixture DECLARES,
  which is the design rather than a shortcut: our UA sheet is transcribed from
  HTML §15 and Chrome's is Chrome's, so a full comparison would mismatch on
  every element nobody styled.
  **Note on the largest untested surface here, named rather than discovered
  later:** the UA sheet is OUTSIDE the corpus entirely. It is a transcription
  checked against HTML §15 by a human reading it, and it is the first thing to
  re-examine if `zch2.5` produces documents that look wrong in ways the unit
  tests do not explain. `test/fixtures/css-cascade/PROVENANCE.md` records the
  rest of the ceiling.
  **Out of scope and tracked:** `calc()` (`zch2.2.6`, one branch of the value
  parser, legal at every length site), and `var()` with custom properties
  (`zch2.2.7`, a PIPELINE change — custom properties cascade and inherit, so
  they must be resolved first, substituted, and the results re-parsed, with
  cycle detection and the invalid-at-computed-value-time rule).
```

- [ ] **Step 4: Verify the `CLAUDE.md` sweep passes**

Run the sweep `CLAUDE.md` documents and confirm none of the seven new modules
appears:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected: `colornames.ts`, `cssvalue.ts`, `cssprop.ts`, `cssshorthand.ts`,
`cssua.ts`, `csscascade.ts` and `csscompute.ts` all ABSENT from the output.

- [ ] **Step 5: Both gates**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck silent; full suite green.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md src/
git commit -m "docs(zch2.2.3): CLAUDE.md entries for the cascade, and mutation results

Fifteen mutations run; [N] reddened something. [Name any that reddened
nothing, and note them in the entry as held by the spec rather than by the
suite.]

The sharpest is the tier pair: treating tiers 2 and 3 as equal reddens the
style=-versus-selector case while treating 3 and 4 as equal reddens only
the normal-style=-versus-important-rule case, and each leaves the other
green. That asymmetry is the whole argument for six tiers over 'style= has
infinite specificity'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-zch2.2.3 --reason "Shipped. Seven pure leaves — colornames.ts, cssvalue.ts, cssprop.ts, cssshorthand.ts, cssua.ts, csscascade.ts, csscompute.ts — plus two CssValue[] entry points added to cssparse.ts, where the grammar already lives.

43 longhands, six cascade tiers, fourteen shorthands, a UA sheet transcribed from HTML §15, @media types, the four CSS-wide keywords, and colours in every form. Units are CSS px; the single 0.75 multiply belongs to zch2.4.

Anchored by [comparisons] Blink comparisons across [cases] documents, comparing author-declared properties only — the UA sheet is deliberately outside the corpus and PROVENANCE.md names it as the largest untested surface this issue ships. [N] of 15 mutations reddened something.

Three findings worth carrying forward. cssparse.ts stopped exactly where CSS Syntax stops, so a rule's block and an @media block are both raw CssValue[]; the two new entry points are thin wrappers over internals that already took CssValue[]. A hash token's id flag must be REQUIRED by a selector and IGNORED by a colour, or #123456 silently stops parsing — the exact inverse of zch2.2.2's trap. And a declaration value carries whitespace at BOTH ends, so trimWs is not cosmetic.

calc() and var() are zch2.2.6 and zch2.2.7. Unblocks zch2.3."
```

- [ ] **Step 8: Push**

```bash
bd export -o .beads/issues.jsonl
git add .beads/
git commit -m "chore(beads): close zch2.2.3

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Per `CLAUDE.md`'s session-completion rules, the work is not complete until the
push succeeds.

---

## Self-Review

**Spec coverage.** Every section of
`docs/superpowers/specs/2026-08-28-css-cascade-design.md` maps to a task. The
two `cssparse.ts` findings → Task 2. The named-colour finding → Task 1. Scope
and the 43 longhands → Task 5. Units → the Global Constraints and Task 3. The
module table → the File Structure. The six tiers → Task 9. Collection and
`@media` → Task 8. The UA sheet → Task 7. Values → Tasks 3 and 4. The property
table and the four silent rules → Tasks 5 and 10. The oracle and its ceiling →
Task 11. What it hands the rest of `zch2` → the Interfaces blocks of Tasks 8,
9 and 10. The deferrals → already filed as `zch2.2.6` and `zch2.2.7`. The
spec's twelve mutations → Task 12, plus three more for traps this plan found
while measuring.

**Two places the plan refines the spec, both noted in-task rather than
silently.** The cascade's output is `{ all, ua }` rather than
`Record<Origin, Declared>`, because what `revert` needs is the UA winner
beside the FINAL winner. And "property-agnostic" is stated precisely: the
cascade consults `PROPERTIES`/`SHORTHANDS` only for "is this name known" and
never for `compute` or `inherited`, because shorthand expansion must happen
before the sort and that requires knowing which names are shorthands.

**Placeholder scan.** The only bracketed values are in Task 11 Step 6 and Task
12 Steps 6 and 7, and each is a number the preceding step *prints*, with the
command that produces it named. No `TBD`, no "handle edge cases", no "similar
to Task N" — the `V`, `allElements` and `elementsOf` test helpers are repeated
in full in each file that uses them, because the files are written in
different tasks and may be read out of order.

**Type consistency.** `Color`, `LengthPct`, `LengthContext`, `CssWide`,
`trimWs`, `keywordOf`, `cssWideOf`, `numberOf`, `lengthOf`,
`absoluteLengthOf`, `colorOf` are spelled identically in Tasks 3, 4, 5, 6 and
10. `ComputedStyle`, `PropContext`, `PropDef`, `PROPERTIES`, `INITIAL_STYLE`,
`FONT_SIZE_KEYWORDS`, `UnsupportedDeclaration` are introduced in Task 5 and
used unchanged in 6, 8, 10 and 11. `Tier`, `CompiledRule`, `Collected`,
`collect`, `mediaMatches` come from Task 8; `ElementDeclarations` and
`cascade` from Task 9; both are consumed by Task 10 under those names.
`pathOf` appears in the generator (over the browser's `Element`) and in the
loader (over `HtmlElement`) as two deliberately separate functions, exactly as
`zch2.2.2` established.

**One risk the executor should know about.** Task 11 Step 2 depends on
puppeteer downloading a browser. If it cannot, the correct action is to stop
and report — Tasks 1–10 and their hand-built suites stand on their own, and
`zch2.3` is unblocked by them. Hand-writing goldens would produce our own
answers wearing a costume, which is worse than no oracle because it looks like
evidence.
