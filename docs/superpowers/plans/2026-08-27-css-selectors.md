# CSS Selectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse CSS selectors out of a qualified rule's prelude, match them against the `HtmlElement` tree, and compute their specificity — the second of `zch2.2`'s three pieces, and the last one `zch2.2.3` (the cascade) is waiting on.

**Architecture:** One new pure leaf, `src/cssselect.ts`, sitting beside `src/svgcss.ts` rather than replacing it. Input is `CssValue[]` from `src/cssparse.ts` — already tokenized, never re-lexed. Matching runs right-to-left over the parent pointers `src/htmldom.ts` carries for this purpose, so there is no `ancestors` array and no whole-tree pre-pass here. Anchored by a corpus **generated** from headless Chrome, following `scripts/gen-svg-goldens.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies. `puppeteer` and `tsx` are installed `--no-save` for the generator script only and are never recorded in `package.json`.

**Spec:** `docs/superpowers/specs/2026-08-27-css-selectors-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. `src/cssselect.ts` imports nothing outside `src/`.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension: `import { parseComponentValueList } from './cssparse.js';`
- **`src/cssselect.ts` is a PURE LEAF.** It may import `./htmldom.js` (types), `./cssparse.js` and `./csstoken.js` (types and `parseComponentValueList`). It must NOT import `document.js`, `page.js`, any PDF object module, any `node:` module, or `svgcss.js`.
- **It NEVER throws.** Every failure is a value: an unsupported or malformed selector makes `parseSelectorList` return `null`, and the caller drops the rule. This is `csstoken.ts`'s and `htmltoken.ts`'s rule.
- **Nothing is exported from `src/index.ts`.** `zch2.2.3` is the only consumer. There is therefore **no `CHANGELOG.md` entry** — the audience is someone deciding whether to upgrade, and no public API moves. `zch2.2.1` set this precedent: its commits touched `CLAUDE.md` and not `CHANGELOG.md`.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- **Task tracking is `bd`,** never TodoWrite or a markdown TODO list. The issue is `zch2.2.2`, already claimed.
- **Commit style:** conventional prefix with the issue id, e.g. `feat(zch2.2.2): ...`. End every commit message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/cssselect.ts` | **Create.** The whole engine: model, parser, matcher, specificity. One file because the four are one grammar — splitting the matcher from the model would put a seam where no second consumer exists. Ends the plan at roughly 550 lines, comparable to `src/svgcss.ts` (323) and well under `src/htmltree.ts`. |
| `test/cssselect-parse.test.ts` | **Create.** Parsing: the shapes that come out, and the inputs that must return `null`. |
| `test/cssselect-match.test.ts` | **Create.** Matching and `selectAll`: combinators, the case rules, quirks, the template boundary. |
| `test/cssselect-specificity.test.ts` | **Create.** The weights table and `compareSpecificity`. |
| `test/cssselect-structural.test.ts` | **Create.** The structural pseudo-classes and the An+B microsyntax. |
| `test/cssselect-logical.test.ts` | **Create.** `:not()`/`:is()`/`:where()`, the dynamic pseudo-classes, `:link`, pseudo-elements. |
| `scripts/gen-selector-goldens.ts` | **Create.** The Blink oracle generator. Not run by `npm test`. |
| `test/helpers/selector-goldens.ts` | **Create.** Test-only loader + the child-index path function. Nothing in `src/` may import it. |
| `test/fixtures/css-selectors/*.json` | **Create.** Generated goldens, committed. |
| `test/fixtures/css-selectors/PROVENANCE.md` | **Create.** Chrome version, command, SHA-256s, ceiling. |
| `test/cssselect-suite.test.ts` | **Create.** Runs the goldens whole; carries the deliberate-mismatch test. |
| `CLAUDE.md` | **Modify.** A `**cssselect.ts**` entry in the Source list, per the rule that a new module earns one when it lands. |

---

## Reference: what the tokenizer actually hands us

**Every row below was measured by running `parseComponentValueList` in this repo, not read off the spec.** Do not re-derive them; several are counter-intuitive and two are traps.

### Selector constructs

| Source | Component values |
|---|---|
| `a` | `{kind:'ident', value:'a'}` |
| `*` | `{kind:'delim', value:'*'}` |
| `#c` | `{kind:'hash', value:'c', id:true}` |
| `.b` | `{kind:'delim', value:'.'}`, `{kind:'ident', value:'b'}` |
| `a b` | ident, `{kind:'whitespace'}`, ident |
| `a > b` | ident, whitespace, `{kind:'delim', value:'>'}`, whitespace, ident |
| `a ~ b + c` | ident, ws, delim `~`, ws, ident, ws, delim `+`, ws, ident |
| `[t=b]` | `{kind:'block', open:'[', contents:[ident 't', **delim `=`**, ident 'b']}` |
| `[href^="x" i]` | block `[` → `[ident 'href', {kind:'match', value:'^='}, {kind:'string', value:'x'}, whitespace, ident 'i']` |
| `p::before` | ident, `{kind:'colon'}`, `{kind:'colon'}`, ident `'before'` |
| `:is(.a, #b)` | colon, `{kind:'function', name:'is', args:[delim '.', ident 'a', {kind:'comma'}, whitespace, hash 'b']}` |

**TRAP 1 — `=` is a `delim`, not a `match` token.** Only the five compound operators `~= |= ^= $= *=` are `match` tokens. A parser that looks for `kind === 'match'` to find an attribute operator handles `[a^=b]` and silently rejects `[a=b]`, which is the commonest attribute selector there is.

**TRAP 2 — a `hash` token carries `id: true` only when the name is an identifier.** `#1a` is `id: false`. An id selector requires `id === true`; treating any hash as an id accepts `#1a`, which is not a valid id selector.

### The An+B microsyntax

`:nth-child()` and friends. The whole family, measured:

| Source | Component values inside `args` | A | B |
|---|---|---|---|
| `odd` | ident `odd` | 2 | 1 |
| `even` | ident `even` | 2 | 0 |
| `3` | number `3` | 0 | 3 |
| `+3` | number `+3` | 0 | 3 |
| `n` | ident `n` | 1 | 0 |
| `-n` | ident `-n` | −1 | 0 |
| `2n` | dimension value 2 unit `n` | 2 | 0 |
| `2n+1` | dimension(2, `n`), number `+1` | 2 | 1 |
| `n+1` | ident `n`, number `+1` | 1 | 1 |
| `-n+3` | ident `-n`, number `+3` | −1 | 3 |
| `2n - 1` | dimension(2,`n`), ws, delim `-`, ws, number `1` | 2 | −1 |
| `n -1` | ident `n`, ws, number `-1` | 1 | −1 |
| **`2n-1`** | **dimension value 2 unit `n-1`** (one token) | 2 | −1 |
| **`-2n-1`** | **dimension value −2 unit `n-1`** (one token) | −2 | −1 |
| **`n-1`** | **ident `n-1`** (one token) | 1 | −1 |
| **`-n-1`** | **ident `-n-1`** (one token) | −1 | −1 |
| `n- 1` | ident `n-`, ws, number `1` | 1 | −1 |
| `+n+1` | delim `+`, ident `n`, number `+1` | 1 | 1 |
| `- 1n` | delim `-`, ws, dimension(1,`n`) | *invalid* | — |

**TRAP 3, and it is the one that will burn an implementer:** the four **bold** rows are a SINGLE token, because `n-1` is a valid CSS name. `2n-1` is not `dimension` + `number`; it is a dimension whose *unit* is `n-1`. A parser written from the obvious reading gets `2n+1` right and `2n-1` wrong — and `2n-1` is `odd` shifted by one, so a striped table looks striped either way and only the first row is wrong. CSS Syntax names these productions `<ndashdigit-dimension>` and `<ndashdigit-ident>`; implement them explicitly.

**Idents and units are case-insensitive:** `ODD` and `2N+1` are valid.

**TRAP 4 — an ident that would be `-n-1` can also be a lone `-n-` plus digits.** Handle the unit/ident suffix by matching `/^-?n-\d+$/` on the lowercased text, not by splitting on the hyphen (`n-1-2` must be rejected, not read as `n-1`).

---

## Task 1: The model and the parser (non-pseudo half)

Type, universal, id, class, attribute selectors, the four combinators, and selector lists. Pseudo-classes arrive in Tasks 4 and 5; until then a `:` makes the selector unsupported, which is honest — the caller drops the rule, exactly as it will for `:has()` forever.

**Files:**
- Create: `src/cssselect.ts`
- Test: `test/cssselect-parse.test.ts`

**Interfaces:**
- Consumes: `parseComponentValueList(css: string): CssValue[]` and the types `CssValue`, `CssToken` from `src/cssparse.ts` / `src/csstoken.ts`.
- Produces, and every later task depends on these exact names:

```ts
export type Combinator = 'descendant' | 'child' | 'next-sibling' | 'subsequent-sibling';
export type AttrOp = 'exists' | '=' | '~=' | '|=' | '^=' | '$=' | '*=';
export interface AttrSel { name: string; op: AttrOp; value?: string; ci?: boolean }
export interface Compound {
  type?: string; id?: string; classes: string[];
  attrs: AttrSel[]; pseudos: Pseudo[]; pseudoElement?: string;
}
export interface ComplexSelector { parts: Compound[]; combinators: Combinator[] }
export type SelectorList = ComplexSelector[];
export function parseSelectorList(prelude: CssValue[]): SelectorList | null;
export function parseSelectorText(src: string): SelectorList | null;
```

`Pseudo` is declared in this task as an empty-for-now union member so later tasks widen it rather than introduce it:

```ts
export type Pseudo = { kind: 'never' };
```

- [ ] **Step 1: Write the failing test**

Create `test/cssselect-parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSelectorText } from '../src/cssselect.js';

describe('selector parsing', () => {
  it('parses a type selector', () => {
    expect(parseSelectorText('div')).toEqual([
      { parts: [{ type: 'div', classes: [], attrs: [], pseudos: [] }], combinators: [] },
    ]);
  });

  it('lowercases a type name once, at parse time', () => {
    // Matching is ASCII case-insensitive for HTML, so folding here means the
    // matcher compares two already-folded strings rather than folding per
    // element per rule.
    expect(parseSelectorText('DIV')?.[0]?.parts[0]?.type).toBe('div');
  });

  it('parses the universal selector as no constraint at all', () => {
    expect(parseSelectorText('*')?.[0]?.parts[0]).toEqual(
      { classes: [], attrs: [], pseudos: [] });
  });

  it('parses id and classes, and keeps their case', () => {
    const c = parseSelectorText('#Main.a.B')?.[0]?.parts[0];
    expect(c?.id).toBe('Main');
    expect(c?.classes).toEqual(['a', 'B']);
  });

  it('rejects a hash that is not an identifier', () => {
    // csstoken gives `#1a` id:false. Accepting it would admit a selector CSS
    // does not have.
    expect(parseSelectorText('#1a')).toBeNull();
  });

  it('parses all four combinators, leftmost first', () => {
    const s = parseSelectorText('a b > c + d ~ e')?.[0];
    expect(s?.parts.map((p) => p.type)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s?.combinators).toEqual(
      ['descendant', 'child', 'next-sibling', 'subsequent-sibling']);
  });

  it('parses a selector list into independent complex selectors', () => {
    expect(parseSelectorText('a, b')?.length).toBe(2);
  });

  it('parses an attribute presence test', () => {
    expect(parseSelectorText('[hidden]')?.[0]?.parts[0]?.attrs)
      .toEqual([{ name: 'hidden', op: 'exists' }]);
  });

  it('parses [a=b], whose operator is a delim rather than a match token', () => {
    // The trap: only ~= |= ^= $= *= are `match` tokens. A parser keyed on
    // `kind === "match"` rejects the commonest attribute selector there is.
    expect(parseSelectorText('[t=b]')?.[0]?.parts[0]?.attrs)
      .toEqual([{ name: 't', op: '=', value: 'b' }]);
  });

  it('parses the five compound operators', () => {
    for (const op of ['~=', '|=', '^=', '$=', '*='] as const) {
      expect(parseSelectorText(`[t${op}"x"]`)?.[0]?.parts[0]?.attrs)
        .toEqual([{ name: 't', op, value: 'x' }]);
    }
  });

  it('reads the i flag, and defaults to case-sensitive', () => {
    expect(parseSelectorText('[t=b i]')?.[0]?.parts[0]?.attrs[0]?.ci).toBe(true);
    expect(parseSelectorText('[t=b s]')?.[0]?.parts[0]?.attrs[0]?.ci).toBe(false);
    expect(parseSelectorText('[t=b]')?.[0]?.parts[0]?.attrs[0]?.ci).toBeUndefined();
  });

  it('lowercases an attribute name and keeps its value case', () => {
    expect(parseSelectorText('[HREF=Foo]')?.[0]?.parts[0]?.attrs)
      .toEqual([{ name: 'href', op: '=', value: 'Foo' }]);
  });

  it('returns null for an empty or whitespace-only selector', () => {
    expect(parseSelectorText('')).toBeNull();
    expect(parseSelectorText('   ')).toBeNull();
  });

  it('returns null for a dangling or doubled combinator', () => {
    for (const s of ['a >', '> a', 'a > > b', 'a,', ',a']) {
      expect(parseSelectorText(s)).toBeNull();
    }
  });

  it('returns null for a namespace-qualified selector', () => {
    // We implement no @namespace, so the prefix has nothing to resolve to.
    expect(parseSelectorText('svg|rect')).toBeNull();
  });

  it('invalidates the WHOLE list when one selector is unsupported', () => {
    // CSS's own rule. A half-applied rule is worse than none, because the
    // half that applied is indistinguishable from a correct render.
    expect(parseSelectorText('a, svg|rect')).toBeNull();
  });

  it('never throws, whatever it is given', () => {
    for (const s of ['[', '[]', '[=]', '#', '.', '..a', 'a[', '((']) {
      expect(() => parseSelectorText(s)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssselect-parse.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssselect.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssselect.ts`:

```ts
/** CSS selectors: parsing, matching and specificity (Selectors Level 4).
 *
 *  Invariant: a PURE LEAF. It imports htmldom.js for types and
 *  cssparse.js/csstoken.js for values. No Document, no PDF object, no `node:`
 *  import, and no svgcss.js. Collecting <style> text is a tree walk and stays
 *  zch2.2.3's, as zch2.2.1 already decided for the syntax modules.
 *
 *  Invariant: NEVER throws. An unsupported or malformed selector is a `null`
 *  return and the caller drops the rule — which is CSS's own behaviour for an
 *  invalid selector, not a degradation we invented. This is csstoken.ts's and
 *  htmltoken.ts's rule and the opposite of parseXml.
 *
 *  Invariant, and the reason this sits BESIDE svgcss.ts rather than replacing
 *  it: that module takes a raw STRING and finds selectors with regexes,
 *  because it predates any CSS tokenizer here; it walks XmlNode, which has no
 *  parent pointers, so its matcher threads an explicit ancestors array; and
 *  SVG is case-sensitive XML where HTML is not. Six SVG modules and a
 *  browser-rendered golden set depend on it. Two grammars sharing a name and
 *  no code — the idiom tablegrid.ts/tablespan.ts and mdscan.ts/htmltoken.ts
 *  already set. */

import { parseComponentValueList } from './cssparse.js';
import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';

export type Combinator = 'descendant' | 'child' | 'next-sibling' | 'subsequent-sibling';

export type AttrOp = 'exists' | '=' | '~=' | '|=' | '^=' | '$=' | '*=';

export interface AttrSel {
  name: string;
  op: AttrOp;
  value?: string;
  /** The `i` flag. Absent means case-sensitive, `false` is an explicit `s`. */
  ci?: boolean;
}

/** Widened by later work: the structural, logical and never-matching kinds. */
export type Pseudo = { kind: 'never' };

/** One compound selector: everything that must match the SAME element.
 *
 *  `id` and `classes` are kept out of `attrs` even though both are attributes
 *  underneath. Matching is then a direct compare rather than a scan, and
 *  specificity reads off the shape instead of re-deriving which attribute
 *  selectors were really classes. */
export interface Compound {
  type?: string;
  id?: string;
  classes: string[];
  attrs: AttrSel[];
  pseudos: Pseudo[];
  pseudoElement?: string;
}

export interface ComplexSelector {
  /** Leftmost first. Matching runs right-to-left over this. */
  parts: Compound[];
  /** combinators[i] joins parts[i] to parts[i + 1]. */
  combinators: Combinator[];
}

export type SelectorList = ComplexSelector[];

// ---- small helpers over the component-value stream -------------------------

function isWs(v: CssValue | undefined): boolean {
  return v !== undefined && (v as CssToken).kind === 'whitespace';
}

function isDelim(v: CssValue | undefined, ch: string): boolean {
  const t = v as CssToken | undefined;
  return t !== undefined && t.kind === 'delim' && t.value === ch;
}

/** An ident or a string, which is what an attribute value may be. */
function textValue(v: CssValue | undefined): string | undefined {
  const t = v as CssToken | undefined;
  if (t === undefined) return undefined;
  if (t.kind === 'ident' || t.kind === 'string') return t.value;
  return undefined;
}

const ATTR_OPS = new Set(['~=', '|=', '^=', '$=', '*=']);

// ---- attribute selectors ---------------------------------------------------

/** Parse the contents of a `[...]` block.
 *
 *  Note `=` arrives as a DELIM while the five compound operators arrive as
 *  `match` tokens — csstoken.ts emits those as single tokens at the spec era
 *  it is pinned to, which is what spares this module rejoining two delims.
 *  A parser keyed on `kind === 'match'` alone silently rejects `[a=b]`. */
function parseAttr(contents: CssValue[]): AttrSel | null {
  const v = contents.filter((x) => !isWs(x));
  const nameTok = v[0] as CssToken | undefined;
  if (nameTok === undefined || nameTok.kind !== 'ident') return null;
  // An attribute NAME is ASCII case-insensitive on an HTML element; folding
  // here means the matcher compares two folded strings.
  const name = nameTok.value.toLowerCase();
  if (v.length === 1) return { name, op: 'exists' };

  const opTok = v[1] as CssToken;
  let op: AttrOp;
  if (opTok.kind === 'delim' && opTok.value === '=') op = '=';
  else if (opTok.kind === 'match' && ATTR_OPS.has(opTok.value)) op = opTok.value as AttrOp;
  else return null;

  const value = textValue(v[2]);
  if (value === undefined) return null;
  if (v.length === 3) return { name, op, value };
  if (v.length !== 4) return null;

  const flag = textValue(v[3])?.toLowerCase();
  if (flag === 'i') return { name, op, value, ci: true };
  if (flag === 's') return { name, op, value, ci: false };
  return null;
}

// ---- compound selectors ----------------------------------------------------

function emptyCompound(): Compound {
  return { classes: [], attrs: [], pseudos: [] };
}

/** Consume one compound selector starting at `i`. Returns the compound and
 *  the index after it, or null when the syntax is one we do not implement.
 *
 *  `used` reports whether anything at all was consumed, which is how a caller
 *  tells `*` (a real compound constraining nothing) from an empty run. */
function parseCompound(
  v: CssValue[], start: number,
): { compound: Compound; next: number } | null {
  const c = emptyCompound();
  let i = start;
  let used = false;

  for (; i < v.length; i++) {
    const t = v[i] as CssToken;
    if (t.kind === 'ident') {
      if (used) return null;                 // a type must lead its compound
      // A namespace prefix (`svg|rect`) has nothing to resolve against: we
      // implement no @namespace. Reject rather than silently drop the prefix.
      if (isDelim(v[i + 1], '|')) return null;
      c.type = t.value.toLowerCase();
      used = true;
      continue;
    }
    if (t.kind === 'hash') {
      // `#1a` is a hash whose name is not an identifier. It is not an id
      // selector, and accepting it admits a selector CSS does not have.
      if (t.id !== true) return null;
      if (c.id !== undefined) return null;   // two ids can never both match
      c.id = t.value;
      used = true;
      continue;
    }
    if (t.kind === 'delim' && t.value === '.') {
      const name = v[i + 1] as CssToken | undefined;
      if (name === undefined || name.kind !== 'ident') return null;
      c.classes.push(name.value);
      i++;
      used = true;
      continue;
    }
    if (t.kind === 'delim' && t.value === '*') {
      if (used) return null;
      if (isDelim(v[i + 1], '|')) return null;
      used = true;                           // constrains nothing, but IS a compound
      continue;
    }
    if ((t as { kind: string }).kind === 'block'
      && (t as unknown as { open: string }).open === '[') {
      const a = parseAttr((t as unknown as { contents: CssValue[] }).contents);
      if (a === null) return null;
      c.attrs.push(a);
      used = true;
      continue;
    }
    break;                                    // whitespace, a combinator, or a comma
  }

  if (!used) return null;
  return { compound: c, next: i };
}

// ---- complex selectors -----------------------------------------------------

/** Parse one complex selector from a comma-delimited run. */
function parseComplex(v: CssValue[]): ComplexSelector | null {
  const parts: Compound[] = [];
  const combinators: Combinator[] = [];
  let i = 0;
  let pending: Combinator | null = null;

  for (;;) {
    while (isWs(v[i])) i++;
    if (i >= v.length) break;

    const t = v[i] as CssToken;
    if (t.kind === 'delim' && (t.value === '>' || t.value === '+' || t.value === '~')) {
      if (parts.length === 0 || pending !== null) return null;   // leading or doubled
      pending = t.value === '>' ? 'child'
        : t.value === '+' ? 'next-sibling' : 'subsequent-sibling';
      i++;
      continue;
    }

    const got = parseCompound(v, i);
    if (got === null) return null;
    if (parts.length > 0) {
      // Whitespace before this compound with no explicit combinator IS the
      // descendant combinator.
      combinators.push(pending ?? 'descendant');
    }
    pending = null;
    parts.push(got.compound);
    i = got.next;
  }

  if (parts.length === 0) return null;
  if (pending !== null) return null;          // trailing combinator
  return { parts, combinators };
}

/** Split a prelude on top-level commas. The parser never sees a comma inside
 *  a block or a function, because cssparse.ts has already nested those. */
function splitList(prelude: CssValue[]): CssValue[][] {
  const out: CssValue[][] = [];
  let run: CssValue[] = [];
  for (const v of prelude) {
    if ((v as CssToken).kind === 'comma') { out.push(run); run = []; continue; }
    run.push(v);
  }
  out.push(run);
  return out;
}

/** Parse a qualified rule's prelude into a selector list, or null when any
 *  part of it is unsupported.
 *
 *  ONE invalid selector invalidates the WHOLE list — CSS's own rule, and the
 *  reason it matters is that the surviving half of a partly-applied rule is
 *  indistinguishable from a correct render. */
export function parseSelectorList(prelude: CssValue[]): SelectorList | null {
  const out: SelectorList = [];
  for (const run of splitList(prelude)) {
    const sel = parseComplex(run);
    if (sel === null) return null;
    out.push(sel);
  }
  return out.length === 0 ? null : out;
}

/** Convenience for tests and the oracle harness: tokenize, then parse. */
export function parseSelectorText(src: string): SelectorList | null {
  return parseSelectorList(parseComponentValueList(src));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssselect-parse.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/cssselect.ts test/cssselect-parse.test.ts
git commit -m "feat(zch2.2.2): the selector model and parser

Parses a qualified rule's prelude — type, universal, id, class, attribute
selectors, the four combinators and selector lists — out of CssValue[]
rather than out of a string, so nothing here re-lexes a character.

Two token shapes are counter-intuitive and both are pinned by a test: '='
is a delim while the five compound operators are match tokens, so a parser
keyed on 'match' alone rejects the commonest attribute selector there is;
and a hash carries id:true only for an identifier, so '#1a' is not an id
selector.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Matching and `selectAll`

**Files:**
- Modify: `src/cssselect.ts` (append)
- Test: `test/cssselect-match.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces:

```ts
export function matches(sel: ComplexSelector, el: HtmlElement): boolean;
export function selectAll(root: HtmlNode, list: SelectorList): HtmlElement[];
```

- [ ] **Step 1: Write the failing test**

Create `test/cssselect-match.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseSelectorText, matches, selectAll } from '../src/cssselect.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

/** Every element in document order, template content included, so a test can
 *  reach an element selectAll is supposed to skip. */
function allElements(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') {
      out.push(x);
      if (x.content !== undefined) walk(x.content);
    }
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

/** Match a selector across a document and report the matched tag names. */
function hit(src: string, sel: string): string[] {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.name);
}

describe('matching', () => {
  it('matches a type selector', () => {
    expect(hit('<p>a</p><div>b</div>', 'p')).toEqual(['p']);
  });

  it('matches the universal selector against every element', () => {
    expect(hit('<p>a</p>', '*')).toEqual(['html', 'head', 'body', 'p']);
  });

  it('matches id and class', () => {
    expect(hit('<p id=x class="a b">t</p>', '#x')).toEqual(['p']);
    expect(hit('<p id=x class="a b">t</p>', '.b')).toEqual(['p']);
    expect(hit('<p class="a">t</p>', '.a.b')).toEqual([]);
  });

  it('matches a TYPE NAME ASCII case-insensitively for HTML elements', () => {
    expect(hit('<p>a</p>', 'P')).toEqual(['p']);
  });

  it('matches a foreign type name CASE-SENSITIVELY', () => {
    // The other half of one rule, and a test asserting only the HTML half
    // stays green with the namespace check deleted.
    expect(hit('<svg><linearGradient/></svg>', 'linearGradient')).toEqual(['linearGradient']);
    expect(hit('<svg><linearGradient/></svg>', 'lineargradient')).toEqual([]);
  });

  it('matches an ATTRIBUTE NAME case-insensitively and its VALUE case-sensitively', () => {
    expect(hit('<a HREF="Foo">t</a>', '[href]')).toEqual(['a']);
    expect(hit('<a href="Foo">t</a>', '[href=Foo]')).toEqual(['a']);
    expect(hit('<a href="Foo">t</a>', '[href=foo]')).toEqual([]);
  });

  it('honours the i flag on an attribute value', () => {
    expect(hit('<a href="Foo">t</a>', '[href=foo i]')).toEqual(['a']);
  });

  it('applies the five compound attribute operators', () => {
    const doc = '<a href="http://x/y" class="one two" lang="en-GB">t</a>';
    expect(hit(doc, '[href^="http"]')).toEqual(['a']);
    expect(hit(doc, '[href$="/y"]')).toEqual(['a']);
    expect(hit(doc, '[href*="://"]')).toEqual(['a']);
    expect(hit(doc, '[class~="two"]')).toEqual(['a']);
    expect(hit(doc, '[lang|="en"]')).toEqual(['a']);
    // ~= is whitespace-separated-word, not substring: "tw" must not match.
    expect(hit(doc, '[class~="tw"]')).toEqual([]);
    // |= matches the exact value or the value followed by a hyphen.
    expect(hit(doc, '[lang|="en-G"]')).toEqual([]);
  });

  it('treats an empty attribute value as never matching for ^= $= *=', () => {
    // Selectors 4: these three never match when the value is the empty string.
    expect(hit('<a href="x">t</a>', '[href^=""]')).toEqual([]);
    expect(hit('<a href="x">t</a>', '[href$=""]')).toEqual([]);
    expect(hit('<a href="x">t</a>', '[href*=""]')).toEqual([]);
  });

  it('matches the descendant combinator, and BACKTRACKS', () => {
    // The nearest b-matching ancestor has no `a` above it; a further one does.
    // Without backtracking this reports nothing.
    const doc = '<div class=a><div class=b><div class=b><i>t</i></div></div></div>'
      + '<div class=b><em>t</em></div>';
    expect(hit(doc, '.a .b i')).toEqual(['i']);
  });

  it('matches the child combinator without descending further', () => {
    expect(hit('<div><section><p>t</p></section></div>', 'div > p')).toEqual([]);
    expect(hit('<div><p>t</p></div>', 'div > p')).toEqual(['p']);
  });

  it('matches the next-sibling combinator against the IMMEDIATE previous element', () => {
    expect(hit('<h1>a</h1><p>b</p>', 'h1 + p')).toEqual(['p']);
    expect(hit('<h1>a</h1><div>x</div><p>b</p>', 'h1 + p')).toEqual([]);
  });

  it('ignores text nodes when finding the previous sibling ELEMENT', () => {
    // "+ p" must still match with whitespace and text between the two.
    expect(hit('<h1>a</h1>   text   <p>b</p>', 'h1 + p')).toEqual(['p']);
  });

  it('matches the subsequent-sibling combinator, and BACKTRACKS', () => {
    const doc = '<h1>a</h1><div>x</div><p>b</p>';
    expect(hit(doc, 'h1 ~ p')).toEqual(['p']);
  });

  it('matches a selector list as the union of its selectors, in document order', () => {
    expect(hit('<p>a</p><div>b</div>', 'div, p')).toEqual(['p', 'div']);
  });

  it('reports each element at most once when two selectors both match it', () => {
    expect(hit('<p class=a>t</p>', 'p, .a')).toEqual(['p']);
  });

  it('matches id and class case-SENSITIVELY in no-quirks mode', () => {
    const doc = '<!doctype html><p id=Main class=Big>t</p>';
    expect(hit(doc, '#main')).toEqual([]);
    expect(hit(doc, '.big')).toEqual([]);
  });

  it('matches id and class case-INSENSITIVELY in quirks mode', () => {
    // No doctype puts the document in quirks mode (htmltree.ts:637), which is
    // computed today and read by exactly one line of parsing logic.
    const doc = '<p id=Main class=Big>t</p>';
    expect(parseHtml(doc).quirks).toBe(true);
    expect(hit(doc, '#main')).toEqual(['p']);
    expect(hit(doc, '.big')).toEqual(['p']);
  });
});

describe('the template content boundary', () => {
  const DOC = '<!doctype html><div id=host><template><b class=inside>t</b></template></div>';

  it('does not descend into a template\'s content', () => {
    expect(hit(DOC, '.inside')).toEqual([]);
    expect(hit(DOC, 'b')).toEqual([]);
  });

  it('cannot match OUT of a template\'s content either', () => {
    // htmltree.ts assigns el.content = createFragment(), and createFragment
    // leaves parent null — so the chain from inside runs element -> fragment
    // -> null and never reaches the document. The boundary is structural in
    // BOTH directions, which is a property of two files agreeing rather than
    // of one line, so it is asserted rather than assumed.
    const el = allElements(parseHtml(DOC)).find((e) => e.name === 'b');
    expect(el).toBeDefined();
    const sel = parseSelectorText('#host b');
    expect(sel).not.toBeNull();
    expect(matches(sel![0]!, el!)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssselect-match.test.ts`
Expected: FAIL — `matches` and `selectAll` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/cssselect.ts` (and extend the import at the top to
`import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';`):

```ts
// ---- tree access -----------------------------------------------------------

/** The document a node belongs to, or null. A template's content fragment has
 *  a null parent (htmltree.ts assigns createFragment(), which does not point
 *  back), so an element inside one has no owner document — which is exactly
 *  right: CSS must not reach into template content, and here that falls out
 *  of the shape rather than needing a rule. */
function ownerDocument(el: HtmlElement): HtmlDocument | null {
  let n: HtmlNode | null = el;
  while (n !== null && n.kind !== 'document') n = n.parent;
  return n === null ? null : n;
}

function parentElement(el: HtmlElement): HtmlElement | null {
  const p = el.parent;
  return p !== null && p.kind === 'element' ? p : null;
}

/** The element children of a node, in document order. */
function elementChildren(n: HtmlNode): HtmlElement[] {
  if (n.kind !== 'element' && n.kind !== 'document' && n.kind !== 'fragment') return [];
  return n.children.filter((c): c is HtmlElement => c.kind === 'element');
}

/** Every preceding sibling ELEMENT, nearest first. Text and comments are
 *  skipped: `h1 + p` must match across the whitespace between the two. */
function precedingSiblings(el: HtmlElement): HtmlElement[] {
  const p = el.parent;
  if (p === null) return [];
  const sibs = elementChildren(p);
  const at = sibs.indexOf(el);
  return at <= 0 ? [] : sibs.slice(0, at).reverse();
}

// ---- attribute reads -------------------------------------------------------

/** Attribute NAMES are ASCII case-insensitive on an HTML element and exact on
 *  a foreign one. The parser has already lowercased the selector's name, so
 *  an HTML lookup is a direct get; a foreign element needs a scan, since its
 *  stored key may carry case the lowercased selector name cannot address. */
function attrOf(el: HtmlElement, name: string): string | undefined {
  const direct = el.attrs.get(name);
  if (direct !== undefined) return direct;
  if (el.ns === 'html') return undefined;
  for (const [k, v] of el.attrs) if (k.toLowerCase() === name) return v;
  return undefined;
}

function eqCase(a: string, b: string, ci: boolean): boolean {
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function matchAttr(a: AttrSel, el: HtmlElement): boolean {
  const have = attrOf(el, a.name);
  if (have === undefined) return false;
  if (a.op === 'exists') return true;
  const want = a.value ?? '';
  const ci = a.ci === true;
  switch (a.op) {
    case '=': return eqCase(have, want, ci);
    // A whitespace-separated WORD, not a substring: [class~="tw"] must not
    // match class="one two".
    case '~=':
      if (want === '' || /\s/.test(want)) return false;
      return have.split(/\s+/).some((w) => eqCase(w, want, ci));
    // The exact value, or the value followed by a hyphen — the language-range
    // operator, so [lang|="en"] matches "en-GB" and [lang|="en-G"] does not.
    case '|=':
      return eqCase(have, want, ci)
        || (have.length > want.length
          && have[want.length] === '-'
          && eqCase(have.slice(0, want.length), want, ci));
    // Selectors 4: these three never match an empty value. Without the guard
    // [href^=""] matches every element that HAS an href, which reads as a
    // working selector.
    case '^=':
      return want !== '' && eqCase(have.slice(0, want.length), want, ci);
    case '$=':
      return want !== '' && have.length >= want.length
        && eqCase(have.slice(have.length - want.length), want, ci);
    case '*=':
      return want !== ''
        && (ci ? have.toLowerCase().includes(want.toLowerCase()) : have.includes(want));
    default: return false;
  }
}

// ---- compound matching -----------------------------------------------------

function classList(el: HtmlElement): string[] {
  const c = attrOf(el, 'class');
  return c === undefined ? [] : c.trim().split(/\s+/).filter((x) => x !== '');
}

/** Quirks mode makes `#id` and `.class` match ASCII case-insensitively — a
 *  legacy behaviour every browser implements. `HtmlDocument.quirks` is
 *  computed by htmltree.ts from §13.2.6.4.1 and, before this module, read by
 *  exactly one line of parsing logic. */
function quirksOf(el: HtmlElement): boolean {
  return ownerDocument(el)?.quirks === true;
}

function matchCompound(c: Compound, el: HtmlElement): boolean {
  // A type name is ASCII case-insensitive for an HTML element and exact for a
  // foreign one: `P` matches <p>, and `lineargradient` must NOT match SVG
  // <linearGradient>. The parser lowercased the selector's name, so the HTML
  // side compares two folded strings.
  if (c.type !== undefined) {
    if (el.ns === 'html') { if (c.type !== el.name.toLowerCase()) return false; }
    else if (c.type !== el.name) return false;
  }

  const ci = quirksOf(el);
  if (c.id !== undefined) {
    const have = attrOf(el, 'id');
    if (have === undefined || !eqCase(have, c.id, ci)) return false;
  }
  if (c.classes.length > 0) {
    const have = classList(el);
    for (const want of c.classes) {
      if (!have.some((h) => eqCase(h, want, ci))) return false;
    }
  }
  for (const a of c.attrs) if (!matchAttr(a, el)) return false;
  for (const p of c.pseudos) if (!matchPseudo(p, el)) return false;
  // A pseudo-element selects a pseudo-element, which is not in the tree. The
  // selector is RECORDED so zch2.3/zch2.4 can pick up generated content
  // without re-parsing, and it matches no real element here.
  if (c.pseudoElement !== undefined) return false;
  return true;
}

/** Widened by Tasks 4 and 5. `never` is a recognised pseudo-class with no
 *  static answer (:hover, :visited, :target). */
function matchPseudo(p: Pseudo, _el: HtmlElement): boolean {
  switch (p.kind) {
    case 'never': return false;
    default: return false;
  }
}

// ---- complex matching ------------------------------------------------------

/** Match parts[i] against `el`, then everything to its left.
 *
 *  Right-to-left, with NO ancestors array: htmldom.ts carries parent pointers
 *  and says in its own header that zch2.2's selector matching is why.
 *
 *  `descendant` and `subsequent-sibling` BACKTRACK — in `a b c`, the nearest
 *  b-matching ancestor may have no `a` above it while a further one does.
 *  `child` and `next-sibling` have exactly one candidate. */
function matchFrom(sel: ComplexSelector, i: number, el: HtmlElement): boolean {
  if (!matchCompound(sel.parts[i] as Compound, el)) return false;
  if (i === 0) return true;

  switch (sel.combinators[i - 1] as Combinator) {
    case 'child': {
      const p = parentElement(el);
      return p !== null && matchFrom(sel, i - 1, p);
    }
    case 'descendant': {
      for (let p = parentElement(el); p !== null; p = parentElement(p)) {
        if (matchFrom(sel, i - 1, p)) return true;
      }
      return false;
    }
    case 'next-sibling': {
      const prev = precedingSiblings(el)[0];
      return prev !== undefined && matchFrom(sel, i - 1, prev);
    }
    case 'subsequent-sibling': {
      for (const prev of precedingSiblings(el)) {
        if (matchFrom(sel, i - 1, prev)) return true;
      }
      return false;
    }
    default: return false;
  }
}

/** Does `sel` match `el`? */
export function matches(sel: ComplexSelector, el: HtmlElement): boolean {
  return matchFrom(sel, sel.parts.length - 1, el);
}

/** Every element under `root` matching any selector in `list`, in document
 *  order, each reported at most once.
 *
 *  Does NOT descend into a template's `content`: a template's content is not
 *  part of the document, so CSS must not match into it. */
export function selectAll(root: HtmlNode, list: SelectorList): HtmlElement[] {
  const out: HtmlElement[] = [];
  const visit = (n: HtmlNode): void => {
    if (n.kind === 'element' && list.some((s) => matches(s, n))) out.push(n);
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment') {
      for (const c of n.children) visit(c);
    }
  };
  visit(root);
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssselect-match.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck silent; suite green with the same total as before plus the new files.

- [ ] **Step 6: Commit**

```bash
git add src/cssselect.ts test/cssselect-match.test.ts
git commit -m "feat(zch2.2.2): selector matching and selectAll

Right-to-left over htmldom.ts's parent pointers, with no ancestors array —
which is what those pointers were landed for. Descendant and
subsequent-sibling backtrack; child and next-sibling have one candidate.

Four rules that are silent when wrong are each pinned in both directions:
a type name folds for HTML and not for SVG, an attribute name folds while
its value does not, quirks mode folds id and class, and ^= \$= *= never
match an empty value.

The template boundary needs no special case. htmltree.ts assigns
el.content = createFragment() and createFragment leaves parent null, so the
chain from inside runs element -> fragment -> null. That is two files
agreeing rather than one line, so it is asserted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Specificity

**Files:**
- Modify: `src/cssselect.ts` (append)
- Test: `test/cssselect-specificity.test.ts`

**Interfaces:**
- Produces:

```ts
export type Specificity = readonly [number, number, number];
export function specificityOf(sel: ComplexSelector): Specificity;
export function compareSpecificity(a: Specificity, b: Specificity): number;
```

- [ ] **Step 1: Write the failing test**

Create `test/cssselect-specificity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseSelectorText, specificityOf, compareSpecificity } from '../src/cssselect.js';
import type { Specificity } from '../src/cssselect.js';

const spec = (s: string): Specificity => {
  const list = parseSelectorText(s);
  if (list === null) throw new Error(`unparseable selector: ${s}`);
  return specificityOf(list[0]!);
};

describe('specificity', () => {
  it('counts an id in a, a class or attribute in b, a type in c', () => {
    expect(spec('#x')).toEqual([1, 0, 0]);
    expect(spec('.x')).toEqual([0, 1, 0]);
    expect(spec('[x]')).toEqual([0, 1, 0]);
    expect(spec('x')).toEqual([0, 0, 1]);
  });

  it('weighs an attribute selector exactly as a class', () => {
    // Not as a type. Getting this wrong reorders a cascade plausibly.
    expect(spec('[href]')).toEqual(spec('.href'));
  });

  it('gives the universal selector and combinators nothing', () => {
    expect(spec('*')).toEqual([0, 0, 0]);
    expect(spec('a > b')).toEqual([0, 0, 2]);
    expect(spec('a b c')).toEqual([0, 0, 3]);
  });

  it('sums across every compound in a complex selector', () => {
    expect(spec('#a .b c[d]')).toEqual([1, 2, 1]);
  });

  it('compares lexicographically, so b never outweighs a', () => {
    // 10 classes must still lose to one id. This is the whole argument for a
    // tuple: a packed integer needs a documented no-carry bound to say it.
    expect(compareSpecificity(spec('#x'), spec('.a.b.c.a.b.c.a.b.c.a'))).toBeGreaterThan(0);
  });

  it('reports 0 for equal specificity, leaving source order to the caller', () => {
    expect(compareSpecificity(spec('.a'), spec('.b'))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssselect-specificity.test.ts`
Expected: FAIL — `specificityOf` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/cssselect.ts`:

```ts
// ---- specificity -----------------------------------------------------------

/** Selectors 4 §17, as a TUPLE compared lexicographically rather than
 *  svgcss.ts's packed a * 10000 + b * 100 + c.
 *
 *  Packing needs a documented no-carry bound, which svgcss.ts duly carries. A
 *  tuple needs none, and `:is()`'s "take the maximum of the arguments" is then
 *  a plain lexicographic max rather than a claim about the packing preserving
 *  order. The cost is a comparator the cascade would have needed anyway to
 *  break ties on source order. */
export type Specificity = readonly [number, number, number];

export function compareSpecificity(a: Specificity, b: Specificity): number {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
}

function addSpec(a: Specificity, b: Specificity): Specificity {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Widened by Task 5, where :is()/:not() take their arguments' MAXIMUM and
 *  :where() contributes nothing whatever its arguments. */
function pseudoSpecificity(p: Pseudo): Specificity {
  switch (p.kind) {
    // A recognised pseudo-class that never matches still weighs as one:
    // it is a pseudo-class, and its weight is observable through a rule that
    // shares its list.
    case 'never': return [0, 1, 0];
    default: return [0, 1, 0];
  }
}

function compoundSpecificity(c: Compound): Specificity {
  let s: Specificity = [
    c.id === undefined ? 0 : 1,
    c.classes.length + c.attrs.length,
    c.type === undefined ? 0 : 1,
  ];
  for (const p of c.pseudos) s = addSpec(s, pseudoSpecificity(p));
  // A pseudo-element weighs as a type.
  if (c.pseudoElement !== undefined) s = addSpec(s, [0, 0, 1]);
  return s;
}

export function specificityOf(sel: ComplexSelector): Specificity {
  let s: Specificity = [0, 0, 0];
  for (const c of sel.parts) s = addSpec(s, compoundSpecificity(c));
  return s;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssselect-specificity.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cssselect.ts test/cssselect-specificity.test.ts
git commit -m "feat(zch2.2.2): specificity as a tuple

A readonly [a, b, c] compared lexicographically, deliberately diverging
from svgcss.ts's packed a*10000 + b*100 + c. Packing needs a documented
no-carry bound; a tuple needs none, and :is()'s max-of-arguments becomes a
lexicographic max rather than a claim about the packing preserving order.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Structural pseudo-classes and the An+B microsyntax

`:root`, `:empty`, `:first-child`, `:last-child`, `:only-child`, `:first-of-type`, `:last-of-type`, `:only-of-type`, and the four `nth` functions.

**Files:**
- Modify: `src/cssselect.ts`
- Test: `test/cssselect-structural.test.ts`

**Interfaces:**
- Produces: widens `Pseudo` with

```ts
| { kind: 'root' | 'empty' }
| { kind: 'nth'; axis: 'child' | 'of-type'; fromEnd: boolean; a: number; b: number }
```

`:first-child` is `nth(child, fromEnd:false, a:0, b:1)`, `:last-child` is the
same with `fromEnd:true`, and `:only-child` is a distinct kind because it is a
conjunction of two:

```ts
| { kind: 'only'; axis: 'child' | 'of-type' }
```

- [ ] **Step 1: Write the failing test**

Create `test/cssselect-structural.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseSelectorText, selectAll } from '../src/cssselect.js';

const hit = (src: string, sel: string): string[] => {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.name);
};

/** Six list items, so a nth-child expectation is legible as a set of indices. */
const LIST = '<!doctype html><ul>'
  + '<li id=n1>1</li><li id=n2>2</li><li id=n3>3</li>'
  + '<li id=n4>4</li><li id=n5>5</li><li id=n6>6</li></ul>';

const ids = (src: string, sel: string): string[] => {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.attrs.get('id') ?? '?');
};

describe('structural pseudo-classes', () => {
  it('matches :root against the document element only', () => {
    expect(hit('<!doctype html><p>t</p>', ':root')).toEqual(['html']);
  });

  it('matches :empty for an element with no children at all', () => {
    // A text node — even whitespace — makes an element non-empty.
    expect(ids('<!doctype html><p id=a></p><p id=b> </p><p id=c><i>x</i></p>', 'p:empty'))
      .toEqual(['a']);
  });

  it('matches :first-child, :last-child and :only-child', () => {
    expect(ids(LIST, 'li:first-child')).toEqual(['n1']);
    expect(ids(LIST, 'li:last-child')).toEqual(['n6']);
    expect(ids(LIST, 'li:only-child')).toEqual([]);
    expect(ids('<!doctype html><ul><li id=solo>x</li></ul>', 'li:only-child'))
      .toEqual(['solo']);
  });

  it('counts nth-child from ONE, not zero', () => {
    expect(ids(LIST, 'li:nth-child(1)')).toEqual(['n1']);
  });

  it('handles odd and even', () => {
    expect(ids(LIST, 'li:nth-child(odd)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(even)')).toEqual(['n2', 'n4', 'n6']);
    expect(ids(LIST, 'li:nth-child(ODD)')).toEqual(['n1', 'n3', 'n5']);
  });

  it('handles 2n+1 and its spaced form', () => {
    expect(ids(LIST, 'li:nth-child(2n+1)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(2n + 1)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(2N+1)')).toEqual(['n1', 'n3', 'n5']);
  });

  it('handles 2n-1, which is ONE dimension token whose unit is "n-1"', () => {
    // The trap. `n-1` is a valid CSS name, so `2n-1` is NOT dimension+number.
    // A parser written from the obvious reading gets 2n+1 right and this
    // wrong — and 2n-1 is `odd` shifted, so a striped table still looks
    // striped and only the first row is wrong.
    expect(ids(LIST, 'li:nth-child(2n-1)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(2n - 1)')).toEqual(['n1', 'n3', 'n5']);
  });

  it('handles the bare and negated n forms', () => {
    expect(ids(LIST, 'li:nth-child(n)')).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(ids(LIST, 'li:nth-child(-n+3)')).toEqual(['n1', 'n2', 'n3']);
    expect(ids(LIST, 'li:nth-child(n+3)')).toEqual(['n3', 'n4', 'n5', 'n6']);
    expect(ids(LIST, 'li:nth-child(n-1)')).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(ids(LIST, 'li:nth-child(-n-1)')).toEqual([]);
  });

  it('rejects a malformed An+B rather than guessing', () => {
    for (const s of [':nth-child()', ':nth-child(- 1n)', ':nth-child(n-1-2)',
      ':nth-child(2x+1)', ':nth-child(a)']) {
      expect(parseSelectorText(`li${s}`)).toBeNull();
    }
  });

  it('counts nth-last-child from the END', () => {
    expect(ids(LIST, 'li:nth-last-child(1)')).toEqual(['n6']);
    expect(ids(LIST, 'li:nth-last-child(2)')).toEqual(['n5']);
  });

  it('counts the -of-type family among SAME-TYPE siblings only', () => {
    const doc = '<!doctype html><div>'
      + '<p id=p1>a</p><span id=s1>b</span><p id=p2>c</p><span id=s2>d</span></div>';
    expect(ids(doc, 'p:first-of-type')).toEqual(['p1']);
    expect(ids(doc, 'span:first-of-type')).toEqual(['s1']);
    expect(ids(doc, 'p:nth-of-type(2)')).toEqual(['p2']);
    expect(ids(doc, 'span:last-of-type')).toEqual(['s2']);
    expect(ids(doc, 'p:only-of-type')).toEqual([]);
    // The distinction that matters: s1 is the SECOND child but the FIRST span.
    expect(ids(doc, 'span:first-child')).toEqual([]);
  });

  it('matches -of-type on TYPE AND NAMESPACE, not name alone', () => {
    // An SVG <a> and an HTML <a> are different types.
    const doc = '<!doctype html><div><svg><a id=sa/></svg><a id=ha>x</a></div>';
    expect(ids(doc, 'a:first-of-type').length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssselect-structural.test.ts`
Expected: FAIL — every pseudo-class selector parses to `null`, so the helper throws.

- [ ] **Step 3: Write the An+B parser and the structural pseudo-classes**

In `src/cssselect.ts`, widen `Pseudo`:

```ts
export type Pseudo =
  | { kind: 'never' }
  | { kind: 'root' | 'empty' }
  | { kind: 'only'; axis: 'child' | 'of-type' }
  | { kind: 'nth'; axis: 'child' | 'of-type'; fromEnd: boolean; a: number; b: number };
```

Add the An+B parser:

```ts
// ---- the An+B microsyntax --------------------------------------------------

/** CSS Syntax's An+B microsyntax, over the component values inside an
 *  `:nth-*()` function.
 *
 *  Four of its forms are a SINGLE token because `n-1` is a valid CSS name, so
 *  `2n-1` is a dimension whose UNIT is `n-1` rather than a dimension followed
 *  by a number, and `n-1` is one ident. A parser written from the obvious
 *  reading handles `2n+1` and silently mis-handles `2n-1` — which is `odd`
 *  shifted by one, so a striped table still looks striped and only the first
 *  row is wrong. The spec names these <ndashdigit-dimension> and
 *  <ndashdigit-ident>. */
const NDASHDIGIT = /^n-(\d+)$/;

function parseAnB(args: CssValue[]): { a: number; b: number } | null {
  const v = args.filter((x) => !isWs(x));
  if (v.length === 0) return null;

  const first = v[0] as CssToken;

  // `odd` / `even` / `n` / `-n` / `n-1` / `-n-1`
  if (first.kind === 'ident') {
    const id = first.value.toLowerCase();
    if (id === 'odd' && v.length === 1) return { a: 2, b: 1 };
    if (id === 'even' && v.length === 1) return { a: 2, b: 0 };

    const neg = id.startsWith('-');
    const body = neg ? id.slice(1) : id;
    const a = neg ? -1 : 1;

    if (body === 'n') return tail(v, 1, a);
    const m = NDASHDIGIT.exec(body);
    // <ndashdigit-ident>: the whole B is inside the ident, so nothing may
    // follow it. `n-1-2` must be rejected, not read as `n-1`.
    if (m !== null && v.length === 1) return { a, b: -Number(m[1]) };
    // `n-` followed by a signless integer: `n- 1`.
    if (body === 'n-') {
      const num = v[1] as CssToken | undefined;
      if (v.length === 2 && num !== undefined && num.kind === 'number' && num.int
        && !/^[+-]/.test(num.repr)) return { a, b: -num.value };
    }
    return null;
  }

  // `2n`, `2n+1`, `2n-1` (unit `n-1`)
  if (first.kind === 'dimension') {
    if (!first.int) return null;
    const unit = first.unit.toLowerCase();
    if (unit === 'n') return tail(v, 1, first.value);
    const m = NDASHDIGIT.exec(unit);
    if (m !== null && v.length === 1) return { a: first.value, b: -Number(m[1]) };
    return null;
  }

  // A bare integer: `3`, `+3`, `-3`.
  if (first.kind === 'number' && first.int && v.length === 1) {
    return { a: 0, b: first.value };
  }

  return null;
}

/** The B half following an `n` term: nothing, a signed number, or an explicit
 *  sign delim then a SIGNLESS number. `n +1` is invalid — a signed number
 *  after whitespace is fine (`n -1`), but `+ 1` must be a delim then a
 *  signless integer, which is why the two shapes are checked separately. */
function tail(v: CssValue[], at: number, a: number): { a: number; b: number } | null {
  if (v.length === at) return { a, b: 0 };

  const t = v[at] as CssToken;
  if (t.kind === 'number' && t.int && v.length === at + 1) {
    // Must carry its own sign: `n 1` is invalid, `n +1` and `n -1` are not.
    if (!/^[+-]/.test(t.repr)) return null;
    return { a, b: t.value };
  }
  if (t.kind === 'delim' && (t.value === '+' || t.value === '-') && v.length === at + 2) {
    const num = v[at + 1] as CssToken;
    if (num.kind !== 'number' || !num.int || /^[+-]/.test(num.repr)) return null;
    return { a, b: t.value === '+' ? num.value : -num.value };
  }
  return null;
}

/** Does `index` (1-based) satisfy An+B? Solve index = a*k + b for an integer
 *  k >= 0. With a === 0 the only match is index === b. */
function nthMatches(a: number, b: number, index: number): boolean {
  if (a === 0) return index === b;
  const k = (index - b) / a;
  return Number.isInteger(k) && k >= 0;
}
```

Add the structural matchers. Replace the `matchPseudo` stub with:

```ts
/** Same type AND namespace. An SVG <a> and an HTML <a> are different types,
 *  so a name-only comparison makes `:first-of-type` count across both. */
function sameType(a: HtmlElement, b: HtmlElement): boolean {
  return a.ns === b.ns && a.name === b.name;
}

function siblingSet(el: HtmlElement, axis: 'child' | 'of-type'): HtmlElement[] {
  const p = el.parent;
  if (p === null) return [el];
  const sibs = elementChildren(p);
  return axis === 'child' ? sibs : sibs.filter((s) => sameType(s, el));
}

function matchPseudo(p: Pseudo, el: HtmlElement): boolean {
  switch (p.kind) {
    // Recognised, and no static answer: :hover, :active, :focus, :target,
    // :visited. NOT the same as unsupported — see parseSelectorText.
    case 'never': return false;
    // The document element: an element whose parent is the document itself.
    case 'root': return el.parent !== null && el.parent.kind === 'document';
    // No children AT ALL. A text node, even whitespace, makes it non-empty.
    case 'empty': return el.children.length === 0;
    case 'only': return siblingSet(el, p.axis).length === 1;
    case 'nth': {
      const set = siblingSet(el, p.axis);
      const at = set.indexOf(el);
      if (at < 0) return false;
      // 1-based, and from the end when the selector says so.
      const index = p.fromEnd ? set.length - at : at + 1;
      return nthMatches(p.a, p.b, index);
    }
    default: return false;
  }
}
```

Now teach `parseCompound` about pseudo-classes. Insert this branch **before**
the final `break;`:

```ts
    if (t.kind === 'colon') {
      const parsed = parsePseudo(v, i);
      if (parsed === null) return null;
      if (parsed.pseudoElement !== undefined) {
        if (c.pseudoElement !== undefined) return null;   // only one may follow
        c.pseudoElement = parsed.pseudoElement;
      } else {
        c.pseudos.push(parsed.pseudo as Pseudo);
      }
      i = parsed.next - 1;                                // the loop's i++ re-adds one
      used = true;
      continue;
    }
```

And add the pseudo dispatcher:

```ts
// ---- pseudo-classes and pseudo-elements ------------------------------------

const PLAIN_NTH: Record<string, { axis: 'child' | 'of-type'; fromEnd: boolean }> = {
  'first-child': { axis: 'child', fromEnd: false },
  'last-child': { axis: 'child', fromEnd: true },
  'first-of-type': { axis: 'of-type', fromEnd: false },
  'last-of-type': { axis: 'of-type', fromEnd: true },
};

const ONLY: Record<string, 'child' | 'of-type'> = {
  'only-child': 'child',
  'only-of-type': 'of-type',
};

const NTH_FN: Record<string, { axis: 'child' | 'of-type'; fromEnd: boolean }> = {
  'nth-child': { axis: 'child', fromEnd: false },
  'nth-last-child': { axis: 'child', fromEnd: true },
  'nth-of-type': { axis: 'of-type', fromEnd: false },
  'nth-last-of-type': { axis: 'of-type', fromEnd: true },
};

interface ParsedPseudo {
  pseudo?: Pseudo;
  pseudoElement?: string;
  next: number;
}

/** `v[at]` is a colon. A SECOND colon means a pseudo-element. */
function parsePseudo(v: CssValue[], at: number): ParsedPseudo | null {
  let i = at + 1;
  let isElement = false;
  if ((v[i] as CssToken | undefined)?.kind === 'colon') { isElement = true; i++; }

  const t = v[i] as CssToken | undefined;
  if (t === undefined) return null;

  if (isElement) {
    // Parsed and RECORDED so zch2.3/zch2.4 can pick up generated content
    // without re-parsing, and so a ::before rule does not invalidate a list
    // it shares. It matches no real element — see matchCompound.
    if (t.kind !== 'ident') return null;
    return { pseudoElement: t.value.toLowerCase(), next: i + 1 };
  }

  if (t.kind === 'ident') {
    const name = t.value.toLowerCase();
    if (name === 'root' || name === 'empty') return { pseudo: { kind: name }, next: i + 1 };
    const only = ONLY[name];
    if (only !== undefined) return { pseudo: { kind: 'only', axis: only }, next: i + 1 };
    const plain = PLAIN_NTH[name];
    if (plain !== undefined) {
      return { pseudo: { kind: 'nth', ...plain, a: 0, b: 1 }, next: i + 1 };
    }
    return null;
  }

  if ((t as { kind: string }).kind === 'function') {
    const fn = t as unknown as { name: string; args: CssValue[] };
    const nth = NTH_FN[fn.name.toLowerCase()];
    if (nth !== undefined) {
      const ab = parseAnB(fn.args);
      if (ab === null) return null;
      return { pseudo: { kind: 'nth', ...nth, a: ab.a, b: ab.b }, next: i + 1 };
    }
    return null;
  }

  return null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssselect-structural.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Confirm nothing earlier moved**

Run: `npx vitest run test/cssselect-parse.test.ts test/cssselect-match.test.ts test/cssselect-specificity.test.ts`
Expected: PASS, all three.

- [ ] **Step 6: Commit**

```bash
git add src/cssselect.ts test/cssselect-structural.test.ts
git commit -m "feat(zch2.2.2): structural pseudo-classes and the An+B microsyntax

:root, :empty, the child/of-type families and the four nth functions.

Four An+B forms are a SINGLE token because n-1 is a valid CSS name: 2n-1
is a dimension whose unit is 'n-1', and n-1 is one ident. The obvious
reading gets 2n+1 right and 2n-1 wrong, and since 2n-1 is odd shifted by
one, a striped table still looks striped with only the first row wrong.
Both are pinned, along with the rejection of n-1-2.

-of-type compares type AND namespace, so an SVG <a> and an HTML <a> do not
count as each other.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Logical pseudo-classes, dynamic pseudo-classes and `:link`

**Files:**
- Modify: `src/cssselect.ts`
- Test: `test/cssselect-logical.test.ts`

**Interfaces:**
- Produces: widens `Pseudo` with

```ts
| { kind: 'not' | 'is' | 'where'; args: SelectorList }
| { kind: 'link' }
```

- [ ] **Step 1: Write the failing test**

Create `test/cssselect-logical.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseSelectorText, selectAll, specificityOf } from '../src/cssselect.js';
import type { Specificity } from '../src/cssselect.js';

const ids = (src: string, sel: string): string[] => {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.attrs.get('id') ?? '?');
};

const spec = (s: string): Specificity => {
  const list = parseSelectorText(s);
  if (list === null) throw new Error(`unparseable selector: ${s}`);
  return specificityOf(list[0]!);
};

const DOC = '<!doctype html><div>'
  + '<p id=a class=x>1</p><p id=b>2</p><span id=c class=x>3</span></div>';

describe('logical pseudo-classes', () => {
  it('matches :not() as the negation', () => {
    expect(ids(DOC, 'p:not(.x)')).toEqual(['b']);
  });

  it('matches :is() as the union', () => {
    expect(ids(DOC, ':is(#a, #c)')).toEqual(['a', 'c']);
  });

  it('matches :where() exactly as :is() does', () => {
    expect(ids(DOC, ':where(#a, #c)')).toEqual(['a', 'c']);
  });

  it('gives :where() ZERO specificity whatever its arguments', () => {
    expect(spec(':where(#a)')).toEqual([0, 0, 0]);
    expect(spec('p:where(#a#b#c)')).toEqual([0, 0, 1]);
  });

  it('gives :is() and :not() their arguments MAXIMUM, not their sum', () => {
    // The sum reading gives [2,0,0] here; the max gives [1,0,0].
    expect(spec(':is(#a, #b)')).toEqual([1, 0, 0]);
    expect(spec(':not(#a, #b)')).toEqual([1, 0, 0]);
    // Max across UNLIKE arguments is lexicographic: an id beats ten classes.
    expect(spec(':is(#a, .b.c.d)')).toEqual([1, 0, 0]);
  });

  it('supports a complex selector inside :not()', () => {
    expect(ids(DOC, 'p:not(div > .x)')).toEqual(['b']);
  });

  it('nests', () => {
    expect(ids(DOC, ':is(p:not(.x))')).toEqual(['b']);
  });
});

describe('dynamic pseudo-classes', () => {
  const LINKS = '<!doctype html><a id=withhref href=x>1</a><a id=bare>2</a>';

  it('matches :link for an <a> that HAS an href', () => {
    expect(ids(LINKS, ':link')).toEqual(['withhref']);
  });

  it('never matches :visited, :hover, :active, :focus or :target', () => {
    for (const s of [':visited', ':hover', ':active', ':focus', ':target']) {
      expect(ids(LINKS, `a${s}`)).toEqual([]);
    }
  });

  it('KEEPS the rest of a list when a dynamic pseudo-class shares it', () => {
    // The rule this whole distinction exists for. A dynamic pseudo-class is
    // KNOWN and never matches; treating it as unknown invalidates the whole
    // list, so `a, a:hover` would lose its `a` half and the document renders
    // unstyled rather than merely un-hovered.
    expect(ids(LINKS, 'a, a:hover')).toEqual(['withhref', 'bare']);
  });

  it('still returns null for a genuinely unsupported pseudo-class', () => {
    // :has() is out of scope by decision, and must invalidate its list.
    expect(parseSelectorText('a:has(> b)')).toBeNull();
    expect(parseSelectorText('a, a:has(> b)')).toBeNull();
    expect(parseSelectorText('a:nonsense')).toBeNull();
  });

  it('weighs a dynamic pseudo-class as a class', () => {
    expect(spec('a:hover')).toEqual([0, 1, 1]);
  });
});

describe('pseudo-elements', () => {
  it('parses and records a pseudo-element without matching any element', () => {
    const list = parseSelectorText('p::before');
    expect(list).not.toBeNull();
    expect(list?.[0]?.parts[0]?.pseudoElement).toBe('before');
    expect(ids('<!doctype html><p id=a>t</p>', 'p::before')).toEqual([]);
  });

  it('does NOT invalidate a list it shares', () => {
    expect(ids('<!doctype html><p id=a>t</p>', 'p, p::before')).toEqual(['a']);
  });

  it('weighs a pseudo-element as a type', () => {
    expect(spec('p::before')).toEqual([0, 0, 2]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssselect-logical.test.ts`
Expected: FAIL — `:not()` and friends parse to `null`.

- [ ] **Step 3: Write the implementation**

Widen `Pseudo` in `src/cssselect.ts`:

```ts
export type Pseudo =
  | { kind: 'never' }
  | { kind: 'link' }
  | { kind: 'root' | 'empty' }
  | { kind: 'only'; axis: 'child' | 'of-type' }
  | { kind: 'nth'; axis: 'child' | 'of-type'; fromEnd: boolean; a: number; b: number }
  | { kind: 'not' | 'is' | 'where'; args: SelectorList };
```

Add the dynamic set and the logical branch. In `parsePseudo`, before the
`return null` at the end of the `t.kind === 'ident'` branch:

```ts
    // RECOGNISED and never matching, which is NOT the same as unsupported.
    // An unsupported selector invalidates the whole list, so treating :hover
    // as unknown makes `a, a:hover { color: blue }` drop its `a` half too and
    // the document render unstyled rather than merely un-hovered.
    if (DYNAMIC.has(name)) return { pseudo: { kind: 'never' }, next: i + 1 };
    // :link is the exception in that group and DOES match: an <a> with an
    // href is a fact about the document rather than about a pointer.
    if (name === 'link') return { pseudo: { kind: 'link' }, next: i + 1 };
```

with, near the other tables:

```ts
/** No static answer in a printed document. :visited never matches, which is
 *  both correct here and what browsers do for privacy. */
const DYNAMIC = new Set([
  'hover', 'active', 'focus', 'focus-visible', 'focus-within', 'target', 'visited',
]);

/** An <a>, <area> or <link> carrying an href. */
const LINK_TYPES = new Set(['a', 'area', 'link']);
```

In `parsePseudo`'s function branch, before its `return null`:

```ts
    const logical = fn.name.toLowerCase();
    if (logical === 'not' || logical === 'is' || logical === 'where') {
      // NON-forgiving for all three here: an unparseable argument makes the
      // whole selector unsupported, so the caller drops the rule rather than
      // applying a narrower version of what the author wrote.
      const args = parseSelectorList(fn.args);
      if (args === null) return null;
      return { pseudo: { kind: logical, args }, next: i + 1 };
    }
```

Extend `matchPseudo`:

```ts
    case 'link':
      return el.ns === 'html' && LINK_TYPES.has(el.name.toLowerCase())
        && el.attrs.get('href') !== undefined;
    case 'not': return !p.args.some((s) => matches(s, el));
    case 'is':
    case 'where': return p.args.some((s) => matches(s, el));
```

Extend `pseudoSpecificity`:

```ts
function pseudoSpecificity(p: Pseudo): Specificity {
  switch (p.kind) {
    // :where() contributes NOTHING, whatever its arguments.
    case 'where': return [0, 0, 0];
    // :is() and :not() take their arguments' MAXIMUM, not their sum — and the
    // maximum is lexicographic, so one id beats ten classes.
    case 'is':
    case 'not': {
      let best: Specificity = [0, 0, 0];
      for (const s of p.args) {
        const c = specificityOf(s);
        if (compareSpecificity(c, best) > 0) best = c;
      }
      return best;
    }
    default: return [0, 1, 0];
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssselect-logical.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Full suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add src/cssselect.ts test/cssselect-logical.test.ts
git commit -m "feat(zch2.2.2): logical and dynamic pseudo-classes

:not(), :is() and :where(), with the two specificity rules that are easiest
to get plausibly wrong pinned directly: :where() contributes nothing
whatever its arguments, and :is()/:not() take their arguments' lexicographic
MAXIMUM rather than their sum.

A dynamic pseudo-class is KNOWN and never matches rather than being
unknown. The difference is load-bearing and silent: unknown invalidates the
whole selector list, so 'a, a:hover' would drop its 'a' half and the
document would render unstyled rather than merely un-hovered. :link is the
exception and does match, an href being a fact about the document.

A pseudo-element is recorded on the compound and matches no real element,
so zch2.3/zch2.4 can pick up generated content without re-parsing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The Blink oracle

**Files:**
- Create: `scripts/gen-selector-goldens.ts`
- Create: `test/helpers/selector-goldens.ts`
- Create: `test/fixtures/css-selectors/goldens.json` (generated)
- Create: `test/fixtures/css-selectors/PROVENANCE.md`
- Create: `test/cssselect-suite.test.ts`

**Interfaces:**
- Consumes: `parseSelectorText`, `selectAll` from `src/cssselect.ts`.
- Produces (test-only):

```ts
export interface SelectorCase { doc: string; selector: string; paths: number[][] }
export interface SpecCase { doc: string; winner: string; loser: string; property: string }
export interface SelectorGoldens { chrome: string; cases: SelectorCase[]; specificity: SpecCase[] }
export function loadSelectorGoldens(): SelectorGoldens;
export function pathOf(el: HtmlElement): number[];
```

- [ ] **Step 1: Write the corpus inputs and the generator**

Create `scripts/gen-selector-goldens.ts`:

```ts
// Generates test/fixtures/css-selectors/goldens.json — Blink's answers for a
// set of documents crossed with a set of selectors, plus a set of
// specificity contests resolved by getComputedStyle.
//
// The premise the zch2.2.2 issue was filed under — "no vendorable oracle" —
// is true and incomplete: WPT's selector tests need a renderer, but a browser
// can be DRIVEN to produce a data-driven corpus, which is what
// gen-svg-goldens.ts already does for SVG output. It is cheaper here, because
// a selector's answer is a list of elements rather than a bitmap.
//
// Not part of `npm test`. The two packages it needs are installed WITHOUT
// being recorded in package.json, so the library's dependency tree is
// unchanged (a later `npm install`/`npm ci` prunes them; re-run the first
// command):
//
//   npm i --no-save tsx puppeteer
//   npx tsx scripts/gen-selector-goldens.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'css-selectors');

/** Documents chosen for the SHAPES the matcher has to walk, not for realism:
 *  sibling runs long enough for An+B to be interesting, mixed types for the
 *  -of-type family, a foreign subtree for the case rules, nesting deep enough
 *  that descendant backtracking has somewhere to backtrack to. */
const DOCS: string[] = [
  '<!doctype html><ul><li id=n1>1</li><li id=n2>2</li><li id=n3>3</li>'
    + '<li id=n4>4</li><li id=n5>5</li><li id=n6>6</li><li id=n7>7</li></ul>',
  '<!doctype html><div class=a><div class=b><div class=b><i>deep</i></div></div></div>'
    + '<div class=b><em>shallow</em></div>',
  '<!doctype html><table><thead><tr><th>H</th></tr></thead>'
    + '<tbody><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody></table>',
  '<!doctype html><div><p id=p1 class="x y">a</p><span id=s1 class=x>b</span>'
    + '<p id=p2>c</p><span id=s2>d</span></div>',
  '<!doctype html><a href="http://x/y" hreflang=en-GB class="one two">L</a>'
    + '<a id=bare>N</a><a HREF="Foo">M</a>',
  '<!doctype html><svg><linearGradient id=g/><a id=sa/></svg><a id=ha href=z>h</a>',
  '<!doctype html><section><h1>t</h1><p>a</p><p>b</p><div><p>c</p></div></section>',
  '<!doctype html><p id=e1></p><p id=e2> </p><p id=e3><i>x</i></p>',
  // No doctype: quirks mode, where #id and .class fold case.
  '<p id=Main class=Big>quirks</p>',
];

const SELECTORS: string[] = [
  '*', 'p', 'P', 'li', '#n1', '.b', '.x.y', '[href]', '[href=Foo]', '[href=foo]',
  '[href=foo i]', '[href^="http"]', '[href$="/y"]', '[href*="://"]',
  '[class~="two"]', '[hreflang|="en"]', '[hreflang|="en-G"]', '[href^=""]',
  'div p', 'div > p', 'h1 + p', 'h1 ~ p', '.a .b i', 'section h1 + p',
  'li:first-child', 'li:last-child', 'li:only-child', 'li:nth-child(1)',
  'li:nth-child(odd)', 'li:nth-child(even)', 'li:nth-child(2n+1)',
  'li:nth-child(2n-1)', 'li:nth-child(-n+3)', 'li:nth-child(n+3)',
  'li:nth-child(n-1)', 'li:nth-child(-n-1)', 'li:nth-last-child(1)',
  'li:nth-last-child(2n)', 'p:first-of-type', 'span:first-of-type',
  'p:nth-of-type(2)', 'span:last-of-type', 'p:only-of-type', 'span:first-child',
  ':root', 'p:empty', 'tr:nth-child(even) td',
  'p:not(.x)', ':is(#p1, #s2)', ':where(#p1, #s2)', 'p:not(div > .x)',
  ':is(p:not(.x))', ':link', 'a:visited', 'a:hover', 'p::before',
  'linearGradient', 'lineargradient', '#main', '.big',
];

/** Contests: two selectors that both match `#t`, each setting `property`.
 *  Blink's getComputedStyle says which won, which is the only way to observe
 *  a specificity — there is no API that reports the number. */
const CONTESTS: { doc: string; a: string; b: string; property: string }[] = [
  { doc: '<!doctype html><p id=t class=c>t</p>', a: '#t', b: '.c.c.c.c.c.c.c.c.c.c', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: '[id=t]', b: '.c', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: 'p', b: '[class]', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: ':where(#t)', b: 'p', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: ':is(#t, .c)', b: '.c.c', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: ':not(#t)', b: '.c.c', property: 'color' },
  { doc: '<!doctype html><p id=t class=c>t</p>', a: 'p:hover', b: 'p.c', property: 'color' },
];

const COLORS = ['rgb(1, 0, 0)', 'rgb(0, 1, 0)'];

const browser = await puppeteer.launch();
const chrome = await browser.version();

const cases: unknown[] = [];
for (const doc of DOCS) {
  const page = await browser.newPage();
  await page.setContent(doc);
  for (const selector of SELECTORS) {
    const paths = await page.evaluate((sel: string) => {
      // The child-index path from the document element, counting ELEMENT
      // children only — the same walk the loader makes on our side. There is
      // no shared node identity across two engines, so a path is the only
      // way to compare an answer at all.
      const pathOf = (el: Element): number[] => {
        const out: number[] = [];
        let n: Element | null = el;
        while (n !== null && n.parentElement !== null) {
          out.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
          n = n.parentElement;
        }
        return out;
      };
      try {
        return Array.from(document.querySelectorAll(sel)).map(pathOf);
      } catch {
        return null;                        // Blink rejects the selector too
      }
    }, selector);
    if (paths === null) continue;           // not a case: both sides refuse it
    cases.push({ doc, selector, paths });
  }
  await page.close();
}

const specificity: unknown[] = [];
for (const c of CONTESTS) {
  const page = await browser.newPage();
  // Source order is A then B, so B wins any TIE. A test that only ever sees
  // "B won" cannot tell a specificity rule from source order, which is why
  // the assertions below name the expected winner explicitly.
  await page.setContent(
    `${c.doc}<style>${c.a}{${c.property}:${COLORS[0]}}`
    + `${c.b}{${c.property}:${COLORS[1]}}</style>`);
  const got = await page.evaluate((prop: string) => {
    const el = document.getElementById('t');
    return el === null ? null : getComputedStyle(el).getPropertyValue(prop);
  }, c.property);
  await page.close();
  if (got === null) continue;
  const winner = got === COLORS[0] ? c.a : got === COLORS[1] ? c.b : null;
  if (winner === null) continue;            // neither rule applied
  specificity.push({
    doc: c.doc, property: c.property,
    winner, loser: winner === c.a ? c.b : c.a,
  });
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const json = `${JSON.stringify({ chrome, cases, specificity }, null, 1)}\n`;
const file = join(outDir, 'goldens.json');
writeFileSync(file, json);

console.log(`chrome:      ${chrome}`);
console.log(`documents:   ${DOCS.length}`);
console.log(`selectors:   ${SELECTORS.length}`);
console.log(`match cases: ${cases.length}`);
console.log(`contests:    ${specificity.length}`);
console.log(`bytes:       ${Buffer.byteLength(json)}`);
console.log(`sha256:      ${createHash('sha256').update(json).digest('hex')}`);
```

- [ ] **Step 2: Generate the goldens**

Run:

```bash
npm i --no-save tsx puppeteer
npx tsx scripts/gen-selector-goldens.ts
```

Expected: it prints the Chrome version, the counts and the SHA-256, and writes
`test/fixtures/css-selectors/goldens.json`. **Record the printed values** —
they go verbatim into `PROVENANCE.md` in Step 6.

If puppeteer cannot download a browser in this environment, stop and report
that rather than hand-writing goldens: a hand-written "oracle" is our own
answer wearing a costume, which is worse than no oracle because it looks like
evidence.

- [ ] **Step 3: Write the loader**

Create `test/helpers/selector-goldens.ts`:

```ts
/** Loader for the Blink-generated selector corpus, plus the child-index path
 *  function that is its other half.
 *
 *  Test-only. Nothing in `src/` may import this, the rule
 *  `test/helpers/css-parsing.ts` and `test/helpers/wpt-tree.ts` already set.
 *
 *  The path is computed on BOTH sides — here and inside the browser in
 *  scripts/gen-selector-goldens.ts — which is the one place a bug can cancel
 *  out. test/cssselect-suite.test.ts carries a deliberate-mismatch test for
 *  exactly that reason. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlElement } from '../../src/htmldom.js';

const FILE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'css-selectors', 'goldens.json',
);

export interface SelectorCase { doc: string; selector: string; paths: number[][] }
export interface SpecCase { doc: string; property: string; winner: string; loser: string }
export interface SelectorGoldens {
  chrome: string;
  cases: SelectorCase[];
  specificity: SpecCase[];
}

export function loadSelectorGoldens(): SelectorGoldens {
  return JSON.parse(readFileSync(FILE, 'utf8')) as SelectorGoldens;
}

/** The child-index path from the document element, counting ELEMENT children
 *  only. Mirrors the walk the generator makes with `parentElement.children`,
 *  which is an element-only collection. */
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
```

- [ ] **Step 4: Write the suite test**

Create `test/cssselect-suite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import {
  parseSelectorText, selectAll, specificityOf, compareSpecificity,
} from '../src/cssselect.js';
import { loadSelectorGoldens, pathOf } from './helpers/selector-goldens.js';

const G = loadSelectorGoldens();

describe('the Blink selector corpus', () => {
  // Counts asserted so a regenerated corpus reddens the build rather than
  // quietly changing what zch2.2.2 tests.
  it('loads a non-trivial corpus', () => {
    expect(G.chrome).toMatch(/Chrome/);
    expect(G.cases.length).toBeGreaterThan(300);
    expect(G.specificity.length).toBeGreaterThan(5);
  });

  it('agrees with Blink on every match set, with no allowlist', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const list = parseSelectorText(c.selector);
      if (list === null) {
        // Blink parsed it, so refusing it is a real divergence rather than a
        // scope decision — every out-of-scope selector was dropped by the
        // generator only when BLINK refused it too.
        failures.push(`${c.selector}: we refuse, Blink parses`);
        continue;
      }
      const ours = selectAll(parseHtml(c.doc), list).map(pathOf);
      const a = JSON.stringify(ours);
      const b = JSON.stringify(c.paths);
      if (a !== b) failures.push(`${c.selector} on ${c.doc.slice(0, 40)}: ${a} != ${b}`);
    }
    expect(failures).toEqual([]);
  });

  it('agrees with Blink on every specificity contest', () => {
    for (const s of G.specificity) {
      const w = parseSelectorText(s.winner);
      const l = parseSelectorText(s.loser);
      expect(w, s.winner).not.toBeNull();
      expect(l, s.loser).not.toBeNull();
      // >= 0 rather than > 0: the generator puts the losing rule SECOND, so a
      // tie is legitimately resolved by source order and the second still
      // wins. Only a strictly lower specificity for the observed winner is a
      // real disagreement.
      expect(
        compareSpecificity(specificityOf(w![0]!), specificityOf(l![0]!)),
        `${s.winner} beat ${s.loser}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the harness itself', () => {
  // The differential-test trap: the child-index path is computed on both
  // sides, so a bug in the walk could cancel out and leave the suite green.
  // A golden edited to name the wrong element MUST turn it red. Without this,
  // "the paths agree" could mean "both walks are wrong the same way".
  it('fails when a golden names the wrong element', () => {
    const real = G.cases.find((c) => c.paths.length > 0);
    expect(real).toBeDefined();
    const list = parseSelectorText(real!.selector);
    expect(list).not.toBeNull();
    const ours = selectAll(parseHtml(real!.doc), list!).map(pathOf);
    const tampered = real!.paths.map((p) => [...p.slice(0, -1), (p.at(-1) ?? 0) + 7]);
    expect(JSON.stringify(ours)).not.toBe(JSON.stringify(tampered));
  });

  it('produces a path that round-trips to the element it names', () => {
    const doc = parseHtml('<!doctype html><div><p>a</p><span><i>b</i></span></div>');
    const list = parseSelectorText('i');
    const el = selectAll(doc, list!)[0];
    expect(el).toBeDefined();
    // html > body > div > span > i, counting element children only.
    expect(pathOf(el!)).toEqual([1, 0, 1, 0]);
  });
});
```

- [ ] **Step 5: Run the suite**

Run: `npx vitest run test/cssselect-suite.test.ts`
Expected: PASS.

If the match-set test reports failures, they are **real** — fix
`src/cssselect.ts`, never the goldens. The one legitimate reason to edit a
golden is a selector this issue's scope deliberately excludes that Blink
nonetheless accepted; in that case remove it from `SELECTORS` in the
generator, regenerate, and record the exclusion in `PROVENANCE.md` as a named
predicate rather than a silent deletion.

- [ ] **Step 6: Write PROVENANCE.md**

Create `test/fixtures/css-selectors/PROVENANCE.md`, filling every bracketed
value from what Step 2 printed:

```markdown
# css-selectors — provenance

Blink's answers for a set of documents crossed with a set of selectors, here
to validate `src/cssselect.ts` against expectations this repo did not author.
See `docs/superpowers/specs/2026-08-27-css-selectors-design.md`.

**GENERATED, not vendored.** There is no data-driven selector corpus to
vendor: WPT ships reftests and `testharness.js` tests for selectors, both of
which need a renderer or a JavaScript engine. So this corpus is produced the
way `test/fixtures/svg/` is — by driving a browser from a script outside
`npm test` and committing what it said.

**Producer:** [chrome version printed by the generator], via puppeteer.
**Command:**

    npm i --no-save tsx puppeteer
    npx tsx scripts/gen-selector-goldens.ts

| File | Bytes | Match cases | Contests | SHA-256 |
|---|---|---|---|---|
| `goldens.json` | [bytes] | [cases] | [contests] | `[sha256]` |

[documents] documents x [selectors] selectors. Every case is run, with no
allowlist. The counts are asserted in `test/cssselect-suite.test.ts`, so a
regenerated corpus reddens the build rather than quietly changing what
`zch2.2.2` tests.

## What this covers

The match sets cover the whole implemented grammar: type, universal, id,
class, all six attribute operators with the `i` flag, the four combinators,
the structural pseudo-classes including the An+B forms that tokenize as a
single dimension or ident, `:not()`/`:is()`/`:where()`, `:link`, and the
namespace-sensitive type-name case rules.

The specificity contests cover what no API reports directly: they set one
property twice on one element and read `getComputedStyle` to learn which rule
won. That is where `:where()` contributing nothing, `:is()`/`:not()` taking
their arguments' maximum, and an attribute selector weighing as a class are
actually checked rather than restated.

## What this does NOT cover, and it must not be read as covering it

1. **Blink is one implementation, not the spec.** Where Blink and Selectors 4
   disagree, this freezes Blink. `test/fixtures/svg/` makes the same trade and
   mitigates it by requiring TWO engines to agree before writing a golden.
   That is not available here: there is no second selector engine runnable in
   this environment without adding a dependency.
2. **The child-index path is computed on both sides** — in the browser by the
   generator, and in `test/helpers/selector-goldens.ts` by the loader. That is
   the differential-test trap `CLAUDE.md` records: a bug in the walk can
   cancel out. `test/cssselect-suite.test.ts` carries a deliberate-mismatch
   test proving the harness CAN fail, and a round-trip test pinning one path
   by hand.
3. **It says nothing about what we chose not to implement.** `:has()` is out
   of scope, so no case names it and the corpus cannot report the gap. The
   design document is the record.
4. **Dynamic pseudo-classes are under-covered by construction.** Blink's
   answer for `a:hover` on a page nobody is hovering over is "matches
   nothing", which is also what a build treating `:hover` as UNKNOWN produces
   for that selector alone. Only the shared-list case separates them, and that
   case lives in `test/cssselect-logical.test.ts` rather than here.

## Regenerating

Only when the grammar grows. Re-run the command above, update the table, and
expect the asserted counts in `test/cssselect-suite.test.ts` to need updating
with it — that is the point of asserting them.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-selector-goldens.ts test/helpers/selector-goldens.ts \
        test/fixtures/css-selectors test/cssselect-suite.test.ts
git commit -m "test(zch2.2.2): a Blink-generated selector corpus

The issue was filed on the premise that there is no oracle. WPT ships no
data-driven selector corpus, which is true, but gen-svg-goldens.ts already
establishes a third option: drive a browser from a script outside npm test
and commit what it said. It is cheaper here than for SVG, because a
selector's answer is a list of elements rather than a bitmap.

Two golden kinds. Match sets come from querySelectorAll, each hit named by
its child-index path — there being no shared node identity across engines.
Specificity contests set one property twice on one element and read
getComputedStyle, which is the only way to observe a number no API reports;
that is where :where() contributing nothing and :is() taking a maximum are
actually checked rather than restated.

The path is computed on both sides, which is the differential-test trap, so
the harness carries a deliberate-mismatch test proving it can fail.
PROVENANCE.md records the ceiling: one engine, no second to arbitrate, and
nothing said about what we chose not to implement.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Mutations, documentation and close

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/cssselect.ts` (comments only, if a mutation finds an unpinned rule)

- [ ] **Step 1: Run the ten mutations**

For each row below: make the edit, run the named command, record which cases
went red, then **revert the edit**. A mutation that reddens NOTHING is
recorded in `CLAUDE.md` as an uncovered rule — the practice this repo already
follows for `openers_bottom` and the JBIG2 refinement context order — never
quietly dropped.

Run `npx vitest run test/cssselect-*.test.ts` for each.

| # | Mutation | Expected to redden |
|---|---|---|
| 1 | In `matchCompound`, compare type names case-sensitively for HTML | the `P` case, and Blink cases |
| 2 | In `matchCompound`, fold type names for foreign elements too | the `lineargradient` case |
| 3 | In `matchCompound`, pass `false` for `ci` instead of `quirksOf(el)` | the two quirks cases |
| 4 | In `parsePseudo`, `return null` for `DYNAMIC` names instead of `{kind:'never'}` | the shared-list case ONLY — the `a:hover`-alone case must stay green, which is the asymmetry the rule is about |
| 5 | In `pseudoSpecificity`, give `where` its arguments' max | the `:where()` specificity cases |
| 6 | In `pseudoSpecificity`, `addSpec` the args instead of taking the max | the `:is(#a, #b)` case |
| 7 | In `matchFrom`, make `descendant` check only the immediate parent | the `.a .b i` backtracking case |
| 8 | In `matchFrom`, make `subsequent-sibling` check only the nearest sibling | the `h1 ~ p` case |
| 9 | In `selectAll`, also visit `n.content` when present | the template case |
| 10 | In `compoundSpecificity`, count `attrs` into `c` instead of `b` | the attribute-equals-class case, and Blink contest 2 |

Two extra mutations for the traps found while planning, which are cheap and
high-value:

| # | Mutation | Expected to redden |
|---|---|---|
| 11 | In `parseAttr`, accept only `kind === 'match'` operators | every `[a=b]` case |
| 12 | In `parseAnB`, delete the `NDASHDIGIT` branches | the `2n-1` and `n-1` cases |

- [ ] **Step 2: Record the results**

Write the outcome into the commit message in Step 4. If any mutation reddened
nothing, add a `**Note, measured, and it covers NOTHING:**` paragraph to the
`cssselect.ts` entry you are about to write, naming the rule and saying it is
held by the spec rather than by the suite.

- [ ] **Step 3: Add the CLAUDE.md entry**

Insert into the Source list in `CLAUDE.md`, immediately after the
`**csstoken.ts**, **cssparse.ts**` entry:

```markdown
- **cssselect.ts** — CSS selectors: parsing, matching and specificity
  (Selectors Level 4). Takes a qualified rule's prelude as `CssValue[]` and
  never re-reads a character; matches right-to-left over `htmldom.ts`'s parent
  pointers, which is what those pointers were landed for. Nothing here
  produces PDF and nothing is exported from `index.ts` — `zch2.2.3` is the
  only consumer.
  **Invariant:** a pure leaf, and it must NOT import `svgcss.ts`. That module
  is a selector engine too and the two share NO code, on purpose: it takes a
  raw STRING and finds selectors with regexes (it predates any CSS tokenizer
  here), it walks `XmlNode`, which has no parent pointers, so its matcher
  threads an explicit ancestors array, and SVG is case-sensitive XML where
  HTML is not. Six SVG modules and a browser-rendered golden set depend on it.
  Two grammars sharing a name — the `tablegrid.ts`/`tablespan.ts` and
  `mdscan.ts`/`htmltoken.ts` idiom.
  **Invariant:** it never throws. An unsupported selector is a `null` return
  and the caller drops the RULE — which is CSS's own behaviour, not a
  degradation we invented — and ONE invalid selector invalidates the WHOLE
  list, because the surviving half of a partly-applied rule is
  indistinguishable from a correct render.
  **Invariant:** a dynamic pseudo-class (`:hover`, `:visited`, `:target`, …)
  is KNOWN AND NEVER MATCHES, which is not the same as unsupported. Unknown
  invalidates the list, so `a, a:hover { color: blue }` would drop its `a`
  half and the document render unstyled rather than merely un-hovered.
  `:link` is the exception and DOES match: an `href` is a fact about the
  document rather than about a pointer. **Note, measured:** Blink's answer for
  `a:hover` alone is also "matches nothing", so the corpus cannot see this —
  only the shared-list case in `test/cssselect-logical.test.ts` can.
  **Invariant:** a pseudo-element is parsed and RECORDED on the compound, and
  matches no real element. That is what lets `zch2.3`/`zch2.4` pick up
  generated content without re-parsing, and it keeps a `::before` rule from
  invalidating a list it shares.
  **Invariant:** specificity is a TUPLE compared lexicographically, not
  `svgcss.ts`'s packed `a*10000 + b*100 + c`. Packing needs a documented
  no-carry bound; a tuple needs none, and `:is()`'s "maximum of its arguments"
  is then a plain lexicographic max rather than a claim about the packing
  preserving order. `:where()` contributes NOTHING whatever its arguments, and
  `:is()`/`:not()` take a MAXIMUM rather than a sum — both produce a
  perfectly plausible cascade when wrong.
  **Invariant:** matching folds a type name for an HTML element and not for a
  foreign one, folds an attribute NAME but not its VALUE, and folds `#id` and
  `.class` only in QUIRKS mode. `HtmlDocument.quirks` is computed by
  `htmltree.ts` from §13.2.6.4.1 and, before this module, was read by exactly
  one line of parsing logic.
  **Invariant:** `^=`, `$=` and `*=` never match an EMPTY value. Without the
  guard `[href^=""]` matches every element that has an `href`, which reads as
  a working selector rather than a fault.
  **Note, and it is the trap this module was hardest to get right:** four
  An+B forms are a SINGLE token, because `n-1` is a valid CSS name. `2n-1` is
  a dimension whose UNIT is `n-1`, not a dimension followed by a number, and
  `n-1` is one ident. A parser written from the obvious reading handles
  `2n+1` and mis-handles `2n-1` — which is `odd` shifted by one, so a striped
  table still looks striped and only the first row is wrong.
  **Note:** the template boundary needs NO special case. `htmltree.ts`
  assigns `el.content = createFragment()` and `createFragment` leaves
  `parent` null, so the chain from an element inside a template runs element →
  fragment → `null` and never reaches the document; `selectAll` declines to
  descend on the way down. Structural in both directions, which is a property
  of two files agreeing rather than of one line, so it is asserted directly.
  **Note on the oracle, and it is GENERATED rather than vendored:** there is
  no data-driven selector corpus to vendor — WPT ships reftests and
  `testharness.js`, both needing a renderer or a JavaScript engine. So
  `scripts/gen-selector-goldens.ts` drives headless Chrome and commits what it
  said, the way `test/fixtures/svg/` already works, and cheaply, because a
  selector's answer is a list of elements rather than a bitmap. Two golden
  kinds: match sets from `querySelectorAll`, and specificity CONTESTS resolved
  by `getComputedStyle`, which is the only way to observe a number no API
  reports. `test/fixtures/css-selectors/PROVENANCE.md` records the ceiling —
  one engine with no second to arbitrate, and a child-index path computed on
  both sides, which is why the harness carries a deliberate-mismatch test.
  **Out of scope and tracked:** `:has()` (non-local: every candidate needs a
  subtree search, so `zch2.2.3`'s pre-pass acquires a quadratic worst case),
  and `:lang()`/`:dir()`, which need `lang` inheritance and so cannot be
  answered here at all.
```

- [ ] **Step 4: Verify the CLAUDE.md sweep passes**

`CLAUDE.md` records a sweep that finds modules missing an entry. Run it and
confirm `cssselect.ts` is not in the output:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected: `cssselect.ts` absent from the output.

- [ ] **Step 5: Both gates**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck silent; full suite green.

- [ ] **Step 6: File the deferred issues**

```bash
bd create "CSS :has(): relational selectors and the pre-pass cost" \
  -t feature -p 3 --parent zch2.2 \
  -d "zch2.2.2 implemented every other selector in scope and left :has() out. It is the one pseudo-class that cannot be answered by walking up parent pointers: every candidate needs a search of its own subtree, so zch2.2.3's whole-tree pre-pass acquires a quadratic worst case. src/cssselect.ts's Pseudo union and parsePseudo are where it lands; the Blink generator in scripts/gen-selector-goldens.ts gains cases by adding selectors to its SELECTORS array and regenerating."

bd create "CSS :lang() and :dir()" \
  -t feature -p 3 --parent zch2.2 \
  -d "Both need the inherited lang, which is the cascade's rather than the selector engine's, so neither can be answered inside src/cssselect.ts as it stands. Revisit once zch2.2.3 computes inheritance: the matcher would need the computed lang passed in, or an ownerLang walk of its own."
```

- [ ] **Step 7: Commit and close**

```bash
git add CLAUDE.md src/cssselect.ts
git commit -m "docs(zch2.2.2): CLAUDE.md entry for cssselect.ts, and mutation results

Twelve mutations run, [N] reddened something. [Name any that reddened
nothing, and note them in the entry as held by the spec rather than by the
suite.]

The two sharpest: treating a dynamic pseudo-class as unknown reddens the
shared-list case ALONE and leaves 'a:hover' green, which is the asymmetry
the rule exists for; and deleting the ndashdigit branches reddens 2n-1 and
n-1 while leaving 2n+1 green.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Then close the issue with a substantive reason:

```bash
bd close zch2.2.2 --reason "Shipped. src/cssselect.ts: parsing, matching and specificity for type, universal, id, class, attribute (six operators, i/s flags), the four combinators, the structural pseudo-classes with the full An+B microsyntax, and :not()/:is()/:where(). [N] Blink match cases and [M] specificity contests green with no allowlist, full suite [T] green.

The issue's premise that there is no oracle did not hold: WPT ships no data-driven corpus, but gen-svg-goldens.ts already establishes generating one from a browser, which is cheaper here since the answer is a list rather than a bitmap. PROVENANCE.md records the ceiling — one engine, no second to arbitrate, and a path computed on both sides, which the deliberate-mismatch test fences.

It sits BESIDE svgcss.ts: different input (CssValue[] against a raw string), different node type (parent pointers against none), different case rules, and six SVG modules plus a golden set depend on the existing one.

Two traps worth carrying forward. '=' is a delim while only the five compound operators are match tokens, so a parser keyed on 'match' rejects the commonest attribute selector there is. And four An+B forms are a single token because n-1 is a valid CSS name — 2n-1 is a dimension whose unit is 'n-1' — which the obvious reading gets wrong in a way that leaves a striped table still looking striped.

:has() and :lang()/:dir() filed as their own issues. Unblocks zch2.2.3."
```

- [ ] **Step 8: Push**

```bash
git pull --rebase
git push
git status
```

Expected: `git status` shows the branch up to date with `origin`. Per
`CLAUDE.md`'s session-completion rules, the work is not complete until the
push succeeds.

---

## Self-Review

**Spec coverage.** Every section of
`docs/superpowers/specs/2026-08-27-css-selectors-design.md` maps to a task:
the module and its boundaries → Task 1; the model → Task 1; matching and the
five silent rules → Task 2 (four of them) and Task 5 (the dynamic-pseudo-class
one); the template boundary → Task 2; specificity → Tasks 3 and 5; the oracle
and its ceiling → Task 6; what it hands `zch2.2.3` → the interface blocks of
Tasks 1–3; the deferrals → Task 7 Step 6. The design's "Testing" section names
ten mutations; Task 7 runs those ten plus two more for the traps found while
planning.

**Placeholder scan.** The only bracketed values are in Task 6 Step 6 and Task
7 Steps 4 and 7, and each is a number the preceding step *prints* — the plan
says which command produces it. No `TBD`, no "handle edge cases", no "similar
to Task N": the two `hit`/`ids` test helpers are repeated in full in each test
file that uses them, because the files are written in different tasks and may
be read out of order.

**Type consistency.** `Pseudo` is introduced in Task 1 as
`{ kind: 'never' }` and widened in Tasks 4 and 5 — declared that way on
purpose so no task introduces a type a neighbour already used. `matchPseudo`
is a stub in Task 2 and replaced in Task 4; both signatures are
`(p: Pseudo, el: HtmlElement) => boolean`. `pseudoSpecificity` is introduced in
Task 3 and extended in Task 5, same signature. `Specificity`,
`specificityOf`, `compareSpecificity`, `matches`, `selectAll`,
`parseSelectorList` and `parseSelectorText` are spelled identically in every
task and in the `CLAUDE.md` entry. `pathOf` appears in the generator (over the
browser's `Element`) and in the loader (over `HtmlElement`); they are
deliberately two functions, and Task 6 says why.

**One risk the executor should know about.** Task 6 Step 2 depends on
puppeteer being able to download a browser. If it cannot, the correct action
is to stop and report — Tasks 1–5 and their hand-built suites stand on their
own, and `zch2.2.3` is unblocked by them. Hand-writing the goldens would
produce our own answers wearing a costume, which is worse than no oracle
because it looks like evidence.
