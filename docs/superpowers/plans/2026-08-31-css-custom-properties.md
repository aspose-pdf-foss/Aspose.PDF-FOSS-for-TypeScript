# CSS custom properties and `var()` — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `--custom: properties` cascade and inherit, and make `var()`
resolve everywhere a value can appear, so `AddHtml` renders documents written
the way CSS is actually authored today.

**Architecture:** A new pure leaf `src/cssvar.ts` owns the whole substitution
engine — token-level rewriting, dependency-graph cycle detection, an expansion
budget, and shorthand re-expansion. `src/csscascade.ts` gains two branches so
custom properties survive the cascade and a shorthand carrying a `var()`
becomes one *pending* entry per longhand it governs. `src/csscompute.ts`
threads a custom-property environment through the top-down walk it already
makes and resolves each declaration just before the property parses it.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, no runtime
dependencies. Headless Chrome via puppeteer for the golden corpus only, which
is not part of `npm test`.

**Spec:** `docs/superpowers/specs/2026-08-31-css-custom-properties-design.md`
— read it first. Its 25-row measurement table is the source of every rule
below, and task steps cite rows by number (`#12`, `#21`).

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only. Do not add an npm
  runtime dep.
- **ESM + NodeNext.** Every import specifier carries a `.js` extension:
  `import { hasVar } from './cssvar.js'`.
- **`src/cssvar.ts` is a PURE LEAF.** It may import `./cssparse.js` and
  `./csstoken.js` for types and `./cssshorthand.js` for `expandShorthand` and
  `GOVERNS`. It may NOT import `htmldom.js`, `csscascade.js`, `csscompute.js`,
  `document.js`, any PDF object module, or any `node:` module.
- **Nothing in this issue throws.** Every failure is a returned value.
- **Nothing is exported from `src/index.ts`.** The feature is user-visible
  only through `AddHtml`, which already exists.
- **The expansion budget is 65,536 tokens per declaration.** Exceeding it is
  reported as `'var-cycle'`.
- **Custom properties are NOT added to `ComputedStyle`.** The 43-longhand
  count stays 43 and stays asserted by `test/cssprop.test.ts`.
- **Custom property names are case-sensitive** — the only names in CSS that
  are. Never `.toLowerCase()` one.
- **Run `npm run typecheck` and `npm test` before the final commit.** Both
  must be green.
- **Mutation-check every rule** (Task 9). A mutation that reddens nothing is
  recorded as uncovered in `CLAUDE.md`, not quietly kept.

---

### Task 1: `cssvar.ts` — value shapes, `hasVar`, `varNames`

**Files:**
- Create: `src/cssvar.ts`
- Test: `test/cssvar.test.ts`

**Interfaces:**
- Consumes: `CssValue` from `./cssparse.js`, `CssToken` from `./csstoken.js`.
- Produces:
  ```ts
  export interface PendingValue { pending: { shorthand: string; value: CssValue[] } }
  export type DeclValue = CssValue[] | PendingValue;
  export type VarEnv = ReadonlyMap<string, CssValue[]>;
  export type VarFail = 'undefined-var' | 'var-cycle' | 'unparsable-value';
  export function isPending(d: DeclValue): d is PendingValue;
  export function isCustomProperty(name: string): boolean;
  export function hasVar(v: CssValue[]): boolean;
  export function varNames(v: CssValue[], out: Set<string>): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/cssvar.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import { isCustomProperty, hasVar, varNames } from '../src/cssvar.js';

const V = (s: string) => parseComponentValueList(s);

describe('isCustomProperty', () => {
  it('accepts a name with at least one character after the two dashes', () => {
    expect(isCustomProperty('--x')).toBe(true);
    expect(isCustomProperty('--Foo-Bar')).toBe(true);
  });

  it('refuses two dashes alone, which Chrome also refuses (#13)', () => {
    expect(isCustomProperty('--')).toBe(false);
  });

  it('refuses an ordinary property name', () => {
    expect(isCustomProperty('color')).toBe(false);
    expect(isCustomProperty('-webkit-thing')).toBe(false);
  });
});

describe('hasVar', () => {
  it('finds a top-level var()', () => {
    expect(hasVar(V('var(--x)'))).toBe(true);
    expect(hasVar(V('1px solid var(--c)'))).toBe(true);
  });

  it('finds a var() NESTED inside another function', () => {
    // calc(var(--w) * 2) is the commonest nesting there is (#11). A
    // top-level-only scan sends the declaration on with a raw var() in it,
    // which then reaches a grammar that cannot read it.
    expect(hasVar(V('calc(var(--w) * 2)'))).toBe(true);
  });

  it('finds a var() nested inside a parenthesised block', () => {
    expect(hasVar(V('calc((var(--w)))'))).toBe(true);
  });

  it('is false for a value with no var at all', () => {
    expect(hasVar(V('1px solid red'))).toBe(false);
    expect(hasVar(V('calc(1px + 2px)'))).toBe(false);
  });

  it('is case-insensitive in the function name', () => {
    expect(hasVar(V('VAR(--x)'))).toBe(true);
  });
});

describe('varNames', () => {
  it('collects every referenced name, nesting included', () => {
    const out = new Set<string>();
    varNames(V('calc(var(--a) + var(--b))'), out);
    expect([...out].sort()).toEqual(['--a', '--b']);
  });

  it('collects names inside a FALLBACK', () => {
    // Load-bearing for cycle detection: a fallback reference is an edge in
    // the dependency graph, which is why `--a: var(--b, blue)` with
    // `--b: var(--a)` is a cycle rather than blue (#19).
    const out = new Set<string>();
    varNames(V('var(--a, var(--b, blue))'), out);
    expect([...out].sort()).toEqual(['--a', '--b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cssvar.test.ts`
Expected: FAIL — `Failed to load url ../src/cssvar.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cssvar.ts`:

```ts
/** CSS custom properties and `var()` substitution (CSS Variables 1).
 *
 *  Invariant: a PURE LEAF. It imports cssparse.js and csstoken.js for TYPES
 *  and cssshorthand.js for re-expansion, and nothing else — no Document, no
 *  PDF object, no `node:` import, no htmldom.js, and NOT csscascade.js, which
 *  imports this. Dependencies run one way and close no cycle.
 *
 *  Invariant: NEVER throws. Every failure is a returned `VarFail`. */

import type { CssValue } from './cssparse.js';
import type { CssToken } from './csstoken.js';

/** A shorthand whose value contains a `var()`, held per longhand until the
 *  element's environment is known. CSS calls this a pending-substitution
 *  value; it exists so shorthands can still expand BEFORE the cascade sorts,
 *  which is csscascade.ts's own recorded invariant. */
export interface PendingValue { pending: { shorthand: string; value: CssValue[] } }

export type DeclValue = CssValue[] | PendingValue;

/** An element's resolved custom properties. The values contain no `var()`:
 *  CSS Variables 1 §2.1 makes the computed value of a custom property its
 *  specified value with variables already substituted, which is what lets a
 *  descendant inherit it without re-resolving anything. */
export type VarEnv = ReadonlyMap<string, CssValue[]>;

export type VarFail = 'undefined-var' | 'var-cycle' | 'unparsable-value';

export function isPending(d: DeclValue): d is PendingValue {
  return !Array.isArray(d);
}

/** A custom property name needs at least one character after the two dashes.
 *  Measured: Chrome treats `--` alone as not a custom property (#13). */
export function isCustomProperty(name: string): boolean {
  return name.length > 2 && name.startsWith('--');
}

/** Is this component value a `var()` call, with its arguments? */
function asVar(x: CssValue): { args: CssValue[] } | undefined {
  if (x.kind !== 'function' || !('args' in x)) return undefined;
  return x.name.toLowerCase() === 'var' ? { args: x.args } : undefined;
}

/** Does this value contain a `var()` anywhere?
 *
 *  RECURSES into functions and blocks. `calc(var(--w) * 2)` is the commonest
 *  nesting there is (#11), and a top-level scan misses it — sending the
 *  declaration to a grammar that cannot read a raw `var()`. */
export function hasVar(v: CssValue[]): boolean {
  for (const x of v) {
    if (asVar(x) !== undefined) return true;
    if (x.kind === 'function' && 'args' in x && hasVar(x.args)) return true;
    if (x.kind === 'block' && hasVar(x.contents)) return true;
  }
  return false;
}

/** Every custom property name this value references, fallbacks INCLUDED.
 *
 *  The fallbacks are what make this a dependency-graph edge set rather than a
 *  list of things to look up: `--a: var(--b, blue)` with `--b: var(--a)` is a
 *  cycle and computes to nothing, not to blue (#19). */
export function varNames(v: CssValue[], out: Set<string>): void {
  for (const x of v) {
    const call = asVar(x);
    if (call !== undefined) {
      const parts = varParts(call.args);
      if (parts !== undefined) {
        out.add(parts.name);
        if (parts.fallback !== undefined) varNames(parts.fallback, out);
      }
      continue;
    }
    if (x.kind === 'function' && 'args' in x) varNames(x.args, out);
    else if (x.kind === 'block') varNames(x.contents, out);
  }
}

/** A `var()`'s name and its optional fallback.
 *
 *  The fallback is everything after the FIRST top-level comma, commas
 *  included — `var(--nope, Georgia, serif)` has a two-family fallback, not a
 *  malformed three-argument call (#9). `fallback` is ABSENT when there is no
 *  comma and EMPTY when there is a comma and nothing after it; the two differ,
 *  since an absent fallback makes an undefined property fail outright. */
function varParts(args: CssValue[]): { name: string; fallback?: CssValue[] } | undefined {
  let i = 0;
  while (i < args.length && (args[i] as CssToken).kind === 'whitespace') i++;
  const head = args[i] as CssToken | undefined;
  if (head === undefined || head.kind !== 'ident' || !isCustomProperty(head.value)) {
    return undefined;
  }
  const name = head.value;
  i++;
  while (i < args.length && (args[i] as CssToken).kind === 'whitespace') i++;
  if (i >= args.length) return { name };
  if ((args[i] as CssToken).kind !== 'comma') return undefined;
  return { name, fallback: args.slice(i + 1) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cssvar.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cssvar.ts test/cssvar.test.ts
git commit -m "feat(zch2.2.7): cssvar.ts value shapes, hasVar and varNames"
```

---

### Task 2: `cssvar.ts` — `substituteValue`

**Files:**
- Modify: `src/cssvar.ts`
- Test: `test/cssvar.test.ts`

**Interfaces:**
- Consumes: Task 1's `VarEnv`, `VarFail`, `varParts`, `asVar`.
- Produces:
  ```ts
  export const VAR_BUDGET = 65536;
  export function substituteValue(
    v: CssValue[], env: VarEnv,
  ): { value: CssValue[] } | { fail: VarFail };
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/cssvar.test.ts` (and add `substituteValue` to the import from
`../src/cssvar.js`):

```ts
/** Substitute, and render the result back to a comparable string. */
const sub = (src: string, env: Record<string, string>) => {
  const m = new Map<string, ReturnType<typeof V>>();
  for (const [k, s] of Object.entries(env)) m.set(k, V(s));
  const r = substituteValue(V(src), m);
  return 'fail' in r ? r.fail : text(r.value);
};

/** Component values back to rough source text, for assertions. */
function text(v: ReturnType<typeof V>): string {
  return v.map((x) => {
    const t = x as { kind: string; value?: unknown; unit?: string; name?: string;
                     args?: ReturnType<typeof V>; contents?: ReturnType<typeof V>;
                     open?: string };
    if (t.kind === 'whitespace') return ' ';
    if (t.kind === 'dimension') return `${String(t.value)}${String(t.unit)}`;
    if (t.kind === 'percentage') return `${String(t.value)}%`;
    if (t.kind === 'hash') return `#${String(t.value)}`;
    if (t.kind === 'comma') return ',';
    if (t.kind === 'function') return `${String(t.name)}(${text(t.args ?? [])})`;
    if (t.kind === 'block') return `${String(t.open)}${text(t.contents ?? [])})`;
    return String(t.value ?? '');
  }).join('').trim();
}

describe('substituteValue', () => {
  it('replaces a var() with the environment value', () => {
    expect(sub('var(--c)', { '--c': 'red' })).toBe('red');
  });

  it('substitutes into the middle of a value', () => {
    expect(sub('1px solid var(--c)', { '--c': 'red' })).toBe('1px solid red');
  });

  it('substitutes INSIDE a function, so calc() sees a resolved value (#11)', () => {
    expect(sub('calc(var(--w) * 2)', { '--w': '10px' })).toBe('calc(10px * 2)');
  });

  it('lets a variable supply an OPERATOR token (#12)', () => {
    // Chrome computes `calc(10px var(--op))` with `--op: + 5px` to 15px, so a
    // variable is a fragment of a value rather than a value. This is why
    // substitution is token-level and runs before any grammar sees it.
    expect(sub('calc(10px var(--op))', { '--op': '+ 5px' })).toBe('calc(10px + 5px)');
  });

  it('uses the fallback for an undefined property (#2)', () => {
    expect(sub('var(--nope, red)', {})).toBe('red');
  });

  it('does NOT use the fallback when the property is merely EMPTY (#4)', () => {
    // An empty custom property is valid and substitutes nothing. The
    // declaration usually then fails on its own, which is a different route
    // to the same place and must not be confused with the fallback firing.
    expect(sub('var(--e, red)', { '--e': '' })).toBe('');
  });

  it('takes the fallback as everything after the FIRST comma (#9)', () => {
    expect(sub('var(--nope, Georgia, serif)', {})).toBe('Georgia, serif');
  });

  it('resolves a var() nested in a fallback (#10)', () => {
    expect(sub('var(--a, var(--b, blue))', { '--b': 'green' })).toBe('green');
  });

  it('falls through two levels of fallback', () => {
    expect(sub('var(--a, var(--b, blue))', {})).toBe('blue');
  });

  it('fails when an undefined property has NO fallback', () => {
    expect(sub('var(--nope)', {})).toBe('undefined-var');
  });

  it('fails on a var() whose argument is not a custom property name', () => {
    expect(sub('var(nope, red)', {})).toBe('undefined-var');
  });

  it('refuses an expansion past the budget rather than growing forever', () => {
    // The billion-laughs shape has NO cycle, so the cycle check cannot see
    // it; only the budget can. Chrome expanded 100,000 tokens and survived,
    // so this is a deliberate divergence recorded in the spec.
    const env: Record<string, string> = { '--a': 'a a a a a a a a a a' };
    for (const [to, from] of [['--b', '--a'], ['--c', '--b'], ['--d', '--c'], ['--e', '--d']]) {
      env[to as string] = new Array(10).fill(`var(${from as string})`).join(' ');
    }
    expect(sub('var(--e)', env)).toBe('var-cycle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cssvar.test.ts`
Expected: FAIL — `substituteValue is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/cssvar.ts`:

```ts
/** The most tokens one declaration's substitution may produce.
 *
 *  A DELIBERATE DIVERGENCE, measured: Chrome expanded a 100,000-token
 *  billion-laughs and survived (#16), so input between the two figures
 *  renders there and is refused here. No real document is near either. The
 *  alternative is an unbounded expansion in a library whose consumers hand it
 *  files they did not write — the failure lexer.ts's own recorded invariant
 *  exists to prevent. A cycle check cannot see this shape: it has no cycle. */
export const VAR_BUDGET = 65536;

interface Budget { n: number }

function walk(
  v: CssValue[], env: VarEnv, out: CssValue[], b: Budget,
): VarFail | undefined {
  for (const x of v) {
    if (++b.n > VAR_BUDGET) return 'var-cycle';

    const call = asVar(x);
    if (call !== undefined) {
      const parts = varParts(call.args);
      if (parts === undefined) return 'undefined-var';
      const got = env.get(parts.name);
      if (got !== undefined) {
        // The environment holds ALREADY-substituted values, so this splices
        // rather than recursing — which is what customPropEnv guarantees.
        for (const t of got) {
          if (++b.n > VAR_BUDGET) return 'var-cycle';
          out.push(t);
        }
        continue;
      }
      // Undefined or guaranteed-invalid: the fallback, if there is one.
      if (parts.fallback === undefined) return 'undefined-var';
      const f = walk(parts.fallback, env, out, b);
      if (f !== undefined) return f;
      continue;
    }

    if (x.kind === 'function' && 'args' in x) {
      const args: CssValue[] = [];
      const f = walk(x.args, env, args, b);
      if (f !== undefined) return f;
      out.push({ kind: 'function', name: x.name, args });
      continue;
    }
    if (x.kind === 'block') {
      const contents: CssValue[] = [];
      const f = walk(x.contents, env, contents, b);
      if (f !== undefined) return f;
      out.push({ kind: 'block', open: x.open, contents });
      continue;
    }
    out.push(x);
  }
  return undefined;
}

/** Rewrite a value with every `var()` replaced.
 *
 *  Token-level, and that is forced rather than tidy: a variable may carry a
 *  bare `+` (#12), so this cannot be "parse the property, then fill a hole".
 *  The result is handed to the property's own grammar afterwards, which is
 *  what makes csscalc.ts and every other consumer work unchanged. */
export function substituteValue(
  v: CssValue[], env: VarEnv,
): { value: CssValue[] } | { fail: VarFail } {
  const out: CssValue[] = [];
  const fail = walk(v, env, out, { n: 0 });
  return fail === undefined ? { value: out } : { fail };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cssvar.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cssvar.ts test/cssvar.test.ts
git commit -m "feat(zch2.2.7): token-level var() substitution with an expansion budget"
```

---

### Task 3: `cssvar.ts` — `customPropEnv`, inheritance and cycles

**Files:**
- Modify: `src/cssvar.ts`
- Test: `test/cssvar.test.ts`

**Interfaces:**
- Consumes: Task 2's `substituteValue`, Task 1's `varNames`.
- Produces:
  ```ts
  export function customPropEnv(
    own: ReadonlyMap<string, CssValue[]>, parent: VarEnv,
  ): { env: VarEnv; invalid: ReadonlyMap<string, VarFail> };
  ```

This is the task the spec's #19–#23 exist for. Read those rows before
starting: the obvious implementation is wrong in three separate ways.

- [ ] **Step 1: Write the failing test**

Append to `test/cssvar.test.ts` (add `customPropEnv` to the import):

```ts
describe('customPropEnv', () => {
  const own = (o: Record<string, string>) => {
    const m = new Map<string, ReturnType<typeof V>>();
    for (const [k, s] of Object.entries(o)) m.set(k, V(s));
    return m;
  };
  const parentEnv = (o: Record<string, string>) => {
    const m = new Map<string, ReturnType<typeof V>>();
    for (const [k, s] of Object.entries(o)) m.set(k, V(s));
    return m as VarEnv;
  };
  const val = (e: VarEnv, k: string) => {
    const v = e.get(k);
    return v === undefined ? undefined : text(v);
  };

  it('REUSES the parent environment by identity when nothing is declared', () => {
    // Not an optimisation for its own sake: it is what keeps a document with
    // no custom properties from allocating a map per element, so the existing
    // byte-identity fences cannot move.
    const p = parentEnv({ '--a': 'red' });
    expect(customPropEnv(new Map(), p).env).toBe(p);
  });

  it('inherits the parent value for a name this element does not declare (#6)', () => {
    const { env } = customPropEnv(own({ '--b': 'blue' }), parentEnv({ '--a': 'red' }));
    expect(val(env, '--a')).toBe('red');
    expect(val(env, '--b')).toBe('blue');
  });

  it('lets the element SHADOW the parent for a sibling reference (#22)', () => {
    const { env } = customPropEnv(
      own({ '--a': 'rgb(4,5,6)', '--b': 'var(--a)' }), parentEnv({ '--a': 'rgb(1,2,3)' }));
    expect(val(env, '--b')).toBe('rgb(4,5,6)');
  });

  it('does not care about DECLARATION ORDER (#23)', () => {
    const { env } = customPropEnv(own({ '--b': 'var(--a)', '--a': 'green' }), new Map());
    expect(val(env, '--b')).toBe('green');
  });

  it('makes a SELF-REFERENCE a cycle rather than reading the inherited value (#21)', () => {
    // THE trap. Seeding the resolution map from the parent and letting a
    // declaration read through it makes `--a: var(--a)` quietly resolve to
    // the parent's --a. Chrome says it is a self-cycle and guaranteed-invalid.
    const { env, invalid } = customPropEnv(
      own({ '--a': 'var(--a)' }), parentEnv({ '--a': 'rgb(1,2,3)' }));
    expect(invalid.get('--a')).toBe('var-cycle');
    expect(env.get('--a')).toBeUndefined();
  });

  it('makes a two-name cycle invalid (#5)', () => {
    const { env, invalid } = customPropEnv(
      own({ '--a': 'var(--b)', '--b': 'var(--a)' }), new Map());
    expect(invalid.get('--a')).toBe('var-cycle');
    expect(invalid.get('--b')).toBe('var-cycle');
    expect(env.get('--a')).toBeUndefined();
  });

  it('does NOT let a fallback rescue a name INSIDE the cycle (#19)', () => {
    // A fallback reference is an edge in the dependency graph, so this is a
    // cycle and computes to nothing. Chrome agrees; the reading where blue
    // wins renders a perfectly plausible page.
    const { invalid } = customPropEnv(
      own({ '--a': 'var(--b, blue)', '--b': 'var(--a)' }), new Map());
    expect(invalid.get('--a')).toBe('var-cycle');
  });

  it('treats a self-reference WITH a fallback as a cycle too (#20)', () => {
    const { invalid } = customPropEnv(own({ '--a': 'var(--a, blue)' }), new Map());
    expect(invalid.get('--a')).toBe('var-cycle');
  });

  it('lets a name OUTSIDE the cycle use its fallback against a cyclic one', () => {
    // The marking must be strictly the cycle MEMBERS. A name that merely
    // depends on one is not in it, so its fallback fires normally.
    const { env, invalid } = customPropEnv(
      own({ '--a': 'var(--b)', '--b': 'var(--a)', '--c': 'var(--a, blue)' }), new Map());
    expect(invalid.get('--c')).toBeUndefined();
    expect(val(env, '--c')).toBe('blue');
  });

  it('records an undefined reference without poisoning anything else (#24)', () => {
    const { env, invalid } = customPropEnv(
      own({ '--junk': 'var(--nope)', '--ok': 'green' }), new Map());
    expect(invalid.get('--junk')).toBe('undefined-var');
    expect(val(env, '--ok')).toBe('green');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cssvar.test.ts`
Expected: FAIL — `customPropEnv is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/cssvar.ts`:

```ts
const NO_INVALID: ReadonlyMap<string, VarFail> = new Map();

/** An element's resolved custom properties, and the ones that failed.
 *
 *  Cycles are found on a DEPENDENCY GRAPH rather than with a resolution
 *  stack, and #19-#21 are why the obvious implementation is wrong three ways.
 *  Nodes are the names declared on THIS element; edges are every `var()` name
 *  reachable in a value, fallbacks included. A name that can reach itself is
 *  in a cycle and is guaranteed-invalid whatever its fallback says.
 *
 *  A name that merely DEPENDS on a cycle member is not itself in one — its
 *  fallback fires normally — so the marking is strictly the members.
 *
 *  Reachability is asked per name, which is O(n^2) in the number of custom
 *  properties on one element. That is a handful; Tarjan's algorithm is the
 *  general answer and is not worth its own correctness risk at this size. */
export function customPropEnv(
  own: ReadonlyMap<string, CssValue[]>, parent: VarEnv,
): { env: VarEnv; invalid: ReadonlyMap<string, VarFail> } {
  // Identity reuse, so a document with no custom properties allocates nothing
  // per element and the byte-identity fences cannot move.
  if (own.size === 0) return { env: parent, invalid: NO_INVALID };

  const deps = new Map<string, string[]>();
  for (const [name, raw] of own) {
    const names = new Set<string>();
    varNames(raw, names);
    deps.set(name, [...names].filter((n) => own.has(n)));
  }

  const reaches = (from: string, target: string, seen: Set<string>): boolean => {
    for (const d of deps.get(from) as string[]) {
      if (d === target) return true;
      if (!seen.has(d)) {
        seen.add(d);
        if (reaches(d, target, seen)) return true;
      }
    }
    return false;
  };

  const invalid = new Map<string, VarFail>();
  for (const name of own.keys()) {
    if (reaches(name, name, new Set())) invalid.set(name, 'var-cycle');
  }

  // A name declared here NEVER sees its own inherited value (#21), so the
  // parent's entry for it is removed before resolution and put back only as
  // this element's own resolved value.
  const env = new Map<string, CssValue[]>(parent);
  for (const name of own.keys()) env.delete(name);

  const resolve = (name: string): void => {
    if (env.has(name) || invalid.has(name)) return;
    // Dependencies first, which is what makes declaration order irrelevant
    // (#23). Cycle members are already marked, so this terminates.
    for (const d of deps.get(name) as string[]) resolve(d);
    const r = substituteValue(own.get(name) as CssValue[], env);
    if ('fail' in r) invalid.set(name, r.fail);
    else env.set(name, r.value);
  };
  for (const name of own.keys()) resolve(name);

  return { env, invalid };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cssvar.test.ts`
Expected: PASS, 32 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cssvar.ts test/cssvar.test.ts
git commit -m "feat(zch2.2.7): custom property environment, inheritance and cycle detection"
```

---

### Task 4: `GOVERNS` export and `resolveDeclValue`

**Files:**
- Modify: `src/cssshorthand.ts:270-271` (export `GOVERNS`, update its comment)
- Modify: `src/cssvar.ts`
- Test: `test/cssvar.test.ts`

**Interfaces:**
- Consumes: `expandShorthand` and now `GOVERNS` from `./cssshorthand.js`.
- Produces:
  ```ts
  export function resolveDeclValue(
    d: DeclValue, longhand: string, env: VarEnv,
  ): { value: CssValue[] } | { fail: VarFail };
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/cssvar.test.ts` (add `resolveDeclValue` to the import):

```ts
describe('resolveDeclValue', () => {
  const env = (o: Record<string, string>) => {
    const m = new Map<string, ReturnType<typeof V>>();
    for (const [k, s] of Object.entries(o)) m.set(k, V(s));
    return m as VarEnv;
  };
  const got = (r: ReturnType<typeof resolveDeclValue>) =>
    'fail' in r ? r.fail : text(r.value);

  it('passes a var-free longhand through UNCHANGED', () => {
    const v = V('red');
    const r = resolveDeclValue(v, 'color', new Map());
    expect('fail' in r ? undefined : r.value).toBe(v);
  });

  it('substitutes a longhand that carries a var()', () => {
    expect(got(resolveDeclValue(V('var(--c)'), 'color', env({ '--c': 'red' }))))
      .toBe('red');
  });

  it('re-expands a PENDING shorthand and takes the requested longhand (#7)', () => {
    const p = { pending: { shorthand: 'border', value: V('2px solid var(--c)') } };
    const e = env({ '--c': 'red' });
    expect(got(resolveDeclValue(p, 'border-top-width', e))).toBe('2px');
    expect(got(resolveDeclValue(p, 'border-top-style', e))).toBe('solid');
    expect(got(resolveDeclValue(p, 'border-top-color', e))).toBe('red');
  });

  it('sets the OTHER longhands when the var is the first component (#8)', () => {
    const p = { pending: { shorthand: 'border', value: V('var(--w) dashed blue') } };
    const e = env({ '--w': '3px' });
    expect(got(resolveDeclValue(p, 'border-top-width', e))).toBe('3px');
    expect(got(resolveDeclValue(p, 'border-top-style', e))).toBe('dashed');
  });

  it('lets ONE variable carry a whole shorthand value (#25)', () => {
    const p = { pending: { shorthand: 'border', value: V('var(--all)') } };
    expect(got(resolveDeclValue(p, 'border-top-width', env({ '--all': '5px solid red' }))))
      .toBe('5px');
  });

  it('fails a pending whose var does not resolve', () => {
    const p = { pending: { shorthand: 'border', value: V('2px solid var(--nope)') } };
    expect(got(resolveDeclValue(p, 'border-top-color', new Map()))).toBe('undefined-var');
  });

  it('reports an UNPARSABLE re-expansion separately from a var failure', () => {
    // The var resolved fine; what it produced is not a border. That is an
    // ordinary bad value, and reporting it as a var problem would send a
    // caller looking in the wrong place.
    const p = { pending: { shorthand: 'border', value: V('var(--junk)') } };
    expect(got(resolveDeclValue(p, 'border-top-width', env({ '--junk': '"nonsense"' }))))
      .toBe('unparsable-value');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cssvar.test.ts`
Expected: FAIL — `resolveDeclValue is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/cssshorthand.ts`, change the `GOVERNS` declaration line and its
comment (the map's contents stay exactly as they are):

```ts
/** The longhands each shorthand governs.
 *
 *  Two consumers: the CSS-wide-keyword pass-through below, and cssvar.ts,
 *  which emits one pending-substitution entry per governed longhand when a
 *  shorthand's value contains a `var()`. */
export const GOVERNS: Record<string, string[]> = {
```

In `src/cssvar.ts`, add the import at the top, beside the existing type
imports:

```ts
import { expandShorthand, GOVERNS } from './cssshorthand.js';
```

and append:

```ts
/** The longhands a shorthand governs, for the pending-substitution split. */
export function longhandsOf(shorthand: string): string[] {
  return GOVERNS[shorthand] ?? [];
}

/** One cascaded declaration to the value its property should parse.
 *
 *  A var-free longhand is returned IDENTICALLY — the same array, not a copy —
 *  which is what keeps a document with no custom properties byte-identical
 *  through this module. */
export function resolveDeclValue(
  d: DeclValue, longhand: string, env: VarEnv,
): { value: CssValue[] } | { fail: VarFail } {
  if (!isPending(d)) {
    if (!hasVar(d)) return { value: d };
    return substituteValue(d, env);
  }

  const r = substituteValue(d.pending.value, env);
  if ('fail' in r) return r;

  // Re-expand the whole shorthand and take this longhand's share. Failure
  // here costs THIS longhand and no other, which is what makes #8's "the
  // other longhands still apply" fall out rather than needing a rule.
  const ex = expandShorthand(d.pending.shorthand, r.value);
  if (ex === undefined) return { fail: 'unparsable-value' };
  const hit = ex.find(([k]) => k === longhand);
  return hit === undefined ? { fail: 'unparsable-value' } : { value: hit[1] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cssvar.test.ts && npm run typecheck`
Expected: PASS, 39 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/cssvar.ts src/cssshorthand.ts test/cssvar.test.ts
git commit -m "feat(zch2.2.7): pending-substitution shorthands, GOVERNS exported"
```

---

### Task 5: `csscascade.ts` — custom properties and pending shorthands

**Files:**
- Modify: `src/csscascade.ts` — imports, `CompiledRule`, `InlineDeclarations`,
  `ElementDeclarations`, `Candidate`, `toLonghands` (around line 120-145)
- Test: `test/csscascade.test.ts`

**Interfaces:**
- Consumes: `DeclValue`, `hasVar`, `isCustomProperty`, `longhandsOf` from
  `./cssvar.js`.
- Produces: `CompiledRule.decls: [string, DeclValue][]`;
  `ElementDeclarations.all` and `.ua` become `Map<string, DeclValue>`.

- [ ] **Step 1: Write the failing test**

Append to `test/csscascade.test.ts`:

```ts
describe('custom properties in the cascade', () => {
  const declsFor = (src: string, id: string) => {
    const doc = parseHtml(src);
    const c = collect(doc);
    const el = allElements(doc).find((e) => e.attrs.get('id') === id) as HtmlElement;
    return cascade(doc, c).get(el)?.all as Map<string, unknown>;
  };

  it('keeps a custom property as a declaration rather than reporting it unknown', () => {
    const src = '<style>#t{--brand:red}</style><p id=t>x</p>';
    expect(declsFor(src, 't').has('--brand')).toBe(true);
    expect(collect(parseHtml(src)).unsupported
      .some((u) => u.property === '--brand')).toBe(false);
  });

  it('PRESERVES CASE, the one name in CSS that is case-sensitive (#3)', () => {
    // toLonghands opens by lowercasing the name. Custom properties must skip
    // that: --Foo and --foo are different properties.
    const d = declsFor('<style>#t{--Foo:red}</style><p id=t>x</p>', 't');
    expect(d.has('--Foo')).toBe(true);
    expect(d.has('--foo')).toBe(false);
  });

  it('treats two dashes alone as an ordinary unknown property (#13)', () => {
    expect(collect(parseHtml('<style>#t{--:red}</style><p id=t>x</p>')).unsupported
      .some((u) => u.property === '--')).toBe(true);
  });

  it('cascades a custom property through the tiers, !important included (#17)', () => {
    const d = declsFor(
      '<style>#t{--c:red}#t{--c:blue!important}p{--c:green}</style><p id=t>x</p>', 't');
    const v = d.get('--c') as { kind: string; value?: string }[];
    expect(v.map((t) => t.value).join('').trim()).toBe('blue');
  });

  it('splits a shorthand carrying a var() into one PENDING per longhand', () => {
    const d = declsFor('<style>#t{border:1px solid var(--c)}</style><p id=t>x</p>', 't');
    const p = d.get('border-top-color') as { pending?: { shorthand: string } };
    expect(p.pending?.shorthand).toBe('border');
    // All twelve border longhands, not just the one the var appears in.
    expect(d.has('border-left-width')).toBe(true);
  });

  it('does NOT report a var-bearing shorthand as unparsable', () => {
    // Without the pending branch, expandShorthand fails on the raw var() and
    // the declaration is dropped with a misleading reason.
    expect(collect(parseHtml('<style>#t{border:1px solid var(--c)}</style><p id=t>x</p>'))
      .unsupported.some((u) => u.property === 'border')).toBe(false);
  });

  it('leaves a var-FREE shorthand expanding exactly as before', () => {
    const d = declsFor('<style>#t{border:1px solid red}</style><p id=t>x</p>', 't');
    expect((d.get('border-top-color') as { pending?: unknown }).pending).toBeUndefined();
  });

  it('keeps a var-bearing LONGHAND as its raw value, with no pending', () => {
    const d = declsFor('<style>#t{color:var(--c)}</style><p id=t>x</p>', 't');
    expect((d.get('color') as { pending?: unknown }).pending).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/csscascade.test.ts`
Expected: FAIL — the case-sensitivity, pending and unsupported cases fail;
`--brand` is currently reported `unknown-property`.

- [ ] **Step 3: Write minimal implementation**

In `src/csscascade.ts`, add to the imports:

```ts
import { hasVar, isCustomProperty, longhandsOf } from './cssvar.js';
import type { DeclValue } from './cssvar.js';
```

Change `CompiledRule.decls`, `InlineDeclarations.normal`/`.important`, and
`Candidate.decls` from `[string, CssValue[]][]` to `[string, DeclValue][]`,
and both maps in `ElementDeclarations` from `Map<string, CssValue[]>` to
`Map<string, DeclValue>`. Change the four `const normal: [string, CssValue[]][]`
/ `important` locals in `compileRules` and `collect` to `[string, DeclValue][]`.

Replace the body of `toLonghands` (keep its doc comment, extend it):

```ts
function toLonghands(
  d: CssDeclaration, el: HtmlElement | null, unsupported: UnsupportedDeclaration[],
): [string, DeclValue][] {
  // BEFORE the fold, and this is the whole reason the raw name is read first:
  // a custom property is the one name in CSS that is case-sensitive, so
  // --Foo and --foo are different properties (#3).
  if (isCustomProperty(d.name)) return [[d.name, d.value]];

  const name = d.name.toLowerCase();       // cssparse.ts does NOT fold the name

  if (SHORTHANDS.has(name)) {
    // Checked BEFORE expandShorthand, which cannot read a raw var() and would
    // report the declaration unparsable. One pending per governed longhand,
    // re-expanded once the element's environment is known — so shorthands
    // still expand before the sort, which is this module's own invariant.
    if (hasVar(d.value)) {
      return longhandsOf(name).map(
        (k) => [k, { pending: { shorthand: name, value: d.value } }],
      );
    }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/csscascade.test.ts && npm run typecheck`
Expected: `test/csscascade.test.ts` PASS. Typecheck reports errors ONLY in
`src/csscompute.ts` (it reads `decls.all.get(name)` as `CssValue[]`), which
Task 6 fixes. Do not fix them here.

- [ ] **Step 5: Commit**

```bash
git add src/csscascade.ts test/csscascade.test.ts
git commit -m "feat(zch2.2.7): cascade custom properties and pending shorthands"
```

---

### Task 6: `csscompute.ts` — thread the environment, resolve each declaration

**Files:**
- Modify: `src/cssprop.ts:114` (the `reason` union)
- Modify: `src/csscompute.ts` — `resolveProp` and `computeStyles`
- Test: `test/csscompute.test.ts`

**Interfaces:**
- Consumes: `customPropEnv`, `resolveDeclValue`, `isCustomProperty` and types
  `VarEnv`, `DeclValue` from `./cssvar.js`.
- Produces: `UnsupportedDeclaration.reason` gains `'undefined-var'` and
  `'var-cycle'`. No signature change reaches outside this module.

- [ ] **Step 1: Write the failing test**

Append to `test/csscompute.test.ts`:

```ts
/** The computed style AND the unsupported report for a source. */
function run(src: string, id: string) {
  const doc = parseHtml(src);
  const r = computeStyles(doc);
  const el = elementsOf(doc).find((e) => e.attrs.get('id') === id) as HtmlElement;
  return { style: r.styles.get(el) as ComputedStyle, unsupported: r.unsupported };
}

const RED = { rgb: [1, 0, 0], a: 1 };
const GREEN = { rgb: [0, 128 / 255, 0], a: 1 };

describe('var() at computed-value time', () => {
  it('resolves a var() against a custom property on the same element', () => {
    expect(style('<p id=t style="--c:red;color:var(--c)">x</p>', 't').color)
      .toEqual(RED);
  });

  it('inherits a custom property from an ancestor (#6)', () => {
    expect(style('<div style="--c:red"><p id=t style="color:var(--c)">x</p></div>', 't')
      .color).toEqual(RED);
  });

  it('resolves a var() in font-size, which computes FIRST', () => {
    // The environment has to be built before font-size or this silently
    // falls back to the inherited size.
    expect(style('<p id=t style="--fs:24px;font-size:var(--fs)">x</p>', 't').fontSize)
      .toBe(24);
  });

  it('resolves a var() inside calc() (#11)', () => {
    expect(style('<div id=t style="--w:10px;margin-top:calc(var(--w) * 2)">x</div>', 't')
      .marginTop).toEqual({ px: 20, pct: 0 });
  });

  it('uses the fallback for an undefined property (#2)', () => {
    expect(style('<p id=t style="color:var(--nope, red)">x</p>', 't').color).toEqual(RED);
  });

  it('does NOT use the fallback when the substituted value fails the property (#1)', () => {
    // THE trap. --x resolves fine, `color: 10px` then fails, and the property
    // falls back to INHERITED green rather than to the fallback red. Both
    // readings render a perfectly plausible page.
    const src = '<div style="color:green"><p id=t style="--x:10px;color:var(--x, red)">x</p></div>';
    expect(style(src, 't').color).toEqual(GREEN);
  });

  it('IACVT on an inherited property inherits (#14)', () => {
    const src = '<div style="color:red"><p id=t style="color:var(--nope)">x</p></div>';
    expect(style(src, 't').color).toEqual(RED);
  });

  it('IACVT on a non-inherited property takes the INITIAL, not the parent (#15)', () => {
    const src = '<div style="margin-top:40px"><div id=t style="margin-top:var(--nope)">x</div></div>';
    expect(style(src, 't').marginTop).toEqual({ px: 0, pct: 0 });
  });

  it('expands a shorthand carrying a var() (#7)', () => {
    const s = style('<p id=t style="--c:red;border:2px solid var(--c)">x</p>', 't');
    expect(s.borderTopWidth).toBe(2);
    expect(s.borderTopStyle).toBe('solid');
    expect(s.borderTopColor).toEqual(RED);
  });

  it('reports an undefined var, so a caller can act on it', () => {
    const { unsupported } = run('<p id=t style="color:var(--nope)">x</p>', 't');
    expect(unsupported.some(
      (u) => u.property === 'color' && u.reason === 'undefined-var')).toBe(true);
  });

  it('reports a cycle as a cycle rather than as an unparsable value', () => {
    const { unsupported } = run(
      '<p id=t style="--a:var(--b);--b:var(--a);color:var(--a)">x</p>', 't');
    expect(unsupported.some((u) => u.reason === 'var-cycle')).toBe(true);
  });

  it('does not let an invalid custom property poison the element (#24)', () => {
    expect(style('<p id=t style="--junk:var(--nope);color:red">x</p>', 't').color)
      .toEqual(RED);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/csscompute.test.ts`
Expected: FAIL on every case above — `var(--c)` currently reaches `colorOf`,
which cannot read it, so the property falls back.

- [ ] **Step 3: Write minimal implementation**

In `src/cssprop.ts`, widen the reason union:

```ts
  /** `undefined-var` names a var() referencing a custom property nothing
   *  defines. `var-cycle` is a reference cycle among custom properties, OR an
   *  expansion that exceeded cssvar.ts's budget — a caller's action is the
   *  same for both, and a third reason for input no real document produces
   *  would be noise. */
  reason: 'unknown-property' | 'unparsable-value' | 'unsupported-at-rule'
        | 'unsupported-media-feature' | 'undefined-var' | 'var-cycle';
```

In `src/csscompute.ts`, add imports:

```ts
import { customPropEnv, resolveDeclValue, isCustomProperty } from './cssvar.js';
import type { VarEnv } from './cssvar.js';
import type { CssValue } from './cssparse.js';
```

Give `resolveProp` an `env` parameter (after `ctx`) and resolve before
anything reads the value:

```ts
function resolveProp(
  name: string, def: PropDef, decls: ElementDeclarations | undefined,
  parent: ComputedStyle | null, ctx: PropContext, el: HtmlElement,
  unsupported: UnsupportedDeclaration[], env: VarEnv,
): unknown {
  const inheritedValue = (): unknown =>
    parent === null
      ? initialOf(def, ctx.color)
      : (parent as unknown as Record<string, unknown>)[def.key];

  const fallback = (): unknown =>
    def.inherited ? inheritedValue() : initialOf(def, ctx.color);

  const raw = decls?.all.get(name);
  if (raw === undefined) return fallback();

  // Substitution comes FIRST, before cssWideOf and before the property's own
  // grammar: a variable may carry a bare operator (#12), so a var()-bearing
  // value is a fragment until it is rewritten.
  const res = resolveDeclValue(raw, name, env);
  if ('fail' in res) {
    unsupported.push({ el, property: name, value: '', reason: res.fail });
    return fallback();
  }
  const declared = res.value;

  const wide = cssWideOf(declared);
  if (wide === 'inherit') return inheritedValue();
  if (wide === 'initial') return initialOf(def, ctx.color);
  if (wide === 'unset') return fallback();
  if (wide === 'revert') {
    const uaRaw = decls?.ua.get(name);
    if (uaRaw === undefined) return fallback();
    const uaRes = resolveDeclValue(uaRaw, name, env);
    if ('fail' in uaRes) return fallback();
    const ua = uaRes.value;
    if (cssWideOf(ua) !== undefined) return fallback();
    const got = def.compute(ua, ctx);
    return got === undefined ? fallback() : got;
  }

  const got = def.compute(declared, ctx);
  if (got !== undefined) return got;

  unsupported.push({ el, property: name, value: '', reason: 'unparsable-value' });
  return fallback();
}
```

In `computeStyles`, thread the environment through `visit`. Change the
signature to `(n: HtmlNode, parent: ComputedStyle | null, parentEnv: VarEnv)`,
seed the call with `visit(root, null, new Map())`, add `let env = parentEnv;`
beside `let mine = parent;`, pass `env` in the recursive call
(`visit(c, mine, env)`), and insert this block immediately after
`const d = decls.get(n);`:

```ts
      // The environment is built BEFORE font-size, because `font-size:
      // var(--fs)` must work and font-size computes first. An element that
      // declares none reuses the parent's map by identity, so a document with
      // no custom properties allocates nothing here.
      const own = new Map<string, CssValue[]>();
      if (d !== undefined) {
        for (const [k, v] of d.all) {
          if (isCustomProperty(k) && Array.isArray(v)) own.set(k, v);
        }
      }
      const cp = customPropEnv(own, parentEnv);
      env = cp.env;
      for (const [prop, reason] of cp.invalid) {
        unsupported.push({ el: n, property: prop, value: '', reason });
      }
```

Finally add `env` as the last argument to all three `resolveProp` calls
(`font-size`, `color`, and the loop over `PROPERTIES`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/csscompute.test.ts test/csscascade.test.ts test/cssvar.test.ts`
Expected: typecheck clean; all three files PASS.

- [ ] **Step 5: Run the WHOLE suite, because this is the task that can move it**

Run: `npm test`
Expected: 536 files, all green. If `test/html-identity.test.ts`,
`test/docx-flow-identity.test.ts` or `test/rich-runs-identity.test.ts` go red,
STOP: the identity-reuse path in `customPropEnv` is not being taken, and a
document with no custom properties is being changed. Do not update those
hashes — they are fences, not goldens.

- [ ] **Step 6: Commit**

```bash
git add src/cssprop.ts src/csscompute.ts test/csscompute.test.ts
git commit -m "feat(zch2.2.7): resolve var() at computed-value time"
```

---

### Task 7: End to end through `AddHtml`

**Files:**
- Modify: `test/htmlflow.test.ts`

**Interfaces:**
- Consumes: the public `htmlElements` entry point, already imported by that
  file. No production change in this task.

- [ ] **Step 1: Write the failing test**

Append to `test/htmlflow.test.ts`, before `describe('documentTitle'`:

```ts
describe('custom properties end to end (zch2.2.7)', () => {
  /** The x of the first glyph, with `margin-left: <m>` and `<extra>` styles. */
  const at = (decls: string, width = 400): number =>
    render(`<p style="${decls}">x</p>`, width).page.GetTextFragments()[0].quad[0];

  it('puts a var() exactly where the value it resolves to goes', () => {
    // An equivalence rather than a computed number, for the reason the
    // zch2.2.6 cases record: the absolute value folds in the rect origin, the
    // UA sheet's body margin and the px -> pt conversion.
    expect(at('--m:16px;margin-left:var(--m)')).toBeCloseTo(at('margin-left:16px'), 6);
  });

  it('inherits a custom property across elements', () => {
    // Asserted through font-size rather than colour: TextFragment carries NO
    // colour, and deliberately so — fragmentsFromGlyphs merges across a
    // colour change, so a fragment could only ever report one of them. That
    // is a recorded invariant in text.ts; do not "fix" it by adding a field.
    const varSize = render('<div style="--fs:24px"><p style="font-size:var(--fs)">x</p></div>')
      .page.GetTextFragments()[0].fontSize;
    const litSize = render('<div><p style="font-size:24px">x</p></div>')
      .page.GetTextFragments()[0].fontSize;
    expect(varSize).toBeCloseTo(litSize, 6);
    // …and it really took effect, rather than both falling back to the
    // inherited 16px, which would make the equality vacuous.
    expect(varSize).toBeGreaterThan(
      render('<div><p>x</p></div>').page.GetTextFragments()[0].fontSize);
  });

  it('reports an undefined var as unsupported rather than dropping it', () => {
    const { unsupported } = render('<p style="color:var(--nope)">x</p>');
    expect(unsupported.some(
      (u) => u.property === 'color' && u.reason === 'undefined-var')).toBe(true);
  });

  it('renders a shorthand carrying a var()', () => {
    const { skipped, unsupported } = render(
      '<div style="--c:red;border:2px solid var(--c)">x</div>');
    expect(unsupported.some((u) => u.property === 'border')).toBe(false);
    expect(skipped).not.toContain('border');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlflow.test.ts`
Expected: PASS, because Tasks 1-6 already made it work. **This is expected and
is not a TDD violation** — this task is a guard against regression at the
public boundary, not a driver of new behaviour. Confirm it is load-bearing by
mutation in Task 9 instead.

- [ ] **Step 3: Commit**

```bash
git add test/htmlflow.test.ts
git commit -m "test(zch2.2.7): custom properties end to end through AddHtml"
```

---

### Task 8: The Blink corpus

**Files:**
- Modify: `test/helpers/cascade-goldens.ts` — a comparator row for `--*`
- Modify: `scripts/gen-cascade-goldens.ts` — new cases
- Regenerate: `test/fixtures/css-cascade/goldens.json`
- Modify: `test/fixtures/css-cascade/PROVENANCE.md`

**Interfaces:**
- Consumes: `computeStyles`, and the `CascadeCase` shape already in the helper.
- Produces: nothing other modules read.

The helper currently has no `KEY_OF` row for a `--*` property, so
`compareProp` would return `ok: true` for one silently — the exact hole its
own `isComparedProp` test exists to catch. Because custom properties are NOT
in `ComputedStyle` (#18 notwithstanding, we do not store them), the comparison
has to be driven from a re-resolution rather than from a style field.

- [ ] **Step 1: Add the comparator**

In `test/helpers/cascade-goldens.ts`, export the environment alongside the
styles is NOT possible — `computeStyles` does not return one. So compare the
custom property's EFFECT instead, and assert the absence explicitly. Add to
`isComparedProp`, immediately before its `return`:

```ts
  // A custom property is deliberately NOT compared: this stack does not store
  // one on ComputedStyle, so there is no value to compare against Chrome's.
  // Named here rather than left to fall through KEY_OF, because a silent
  // ok:true is exactly what the isComparedProp test exists to catch — and a
  // future reader will otherwise assume the corpus covers what it does not.
  if (prop.startsWith('--')) return true;
```

and mirror it in `compareProp`, immediately after `const key = KEY_OF[prop];`:

```ts
  if (prop.startsWith('--')) return { ok: true, ours: '(custom property: not compared)' };
```

- [ ] **Step 2: Add the generator cases**

In `scripts/gen-cascade-goldens.ts`, insert before the `text-decoration` case:

```ts
  // Custom properties and var() (zch2.2.7). Every value here resolves to a
  // plain colour or length, so unlike zch2.2.6's percentage cases the whole
  // set is comparable.
  {
    id: 'var-basic-and-inheritance',
    html: '<style>#o{--c:rgb(1,2,3)}#a{color:var(--c)}'
      + '#b{--c:rgb(4,5,6);color:var(--c)}</style>'
      + '<div id=o><p id=a>a</p><p id=b>b</p></div>',
    props: ['color'],
  },
  {
    // The trap: #b's --x resolves, `color: 10px` then fails, and the element
    // INHERITS rather than taking the fallback red.
    id: 'var-fallback',
    html: '<style>#o{color:rgb(0,128,0)}'
      + '#a{color:var(--nope, rgb(1,2,3))}'
      + '#b{--x:10px;color:var(--x, rgb(9,9,9))}'
      + '#c{--a:var(--b);--b:var(--a);color:var(--a, rgb(4,5,6))}</style>'
      + '<div id=o><p id=a>a</p><p id=b>b</p><p id=c>c</p></div>',
    props: ['color'],
  },
  {
    id: 'var-case-sensitivity',
    html: '<style>#o{color:rgb(0,128,0)}#t{--Foo:rgb(1,2,3);color:var(--foo, rgb(4,5,6))}'
      + '</style><div id=o><p id=t>x</p></div>',
    props: ['color'],
  },
  {
    id: 'var-in-shorthand-and-calc',
    html: '<style>html{font-size:16px}'
      + '#a{--c:rgb(4,5,6);border:2px solid var(--c)}'
      + '#b{--w:3px;border:var(--w) dashed rgb(7,8,9)}'
      + '#c{--m:10px;margin-top:calc(var(--m) * 2);--all:1px;border-top-width:var(--all);'
      + 'border-top-style:solid}</style>'
      + '<div id=a>a</div><div id=b>b</div><div id=c>c</div>',
    props: ['border-top-width', 'border-top-style', 'border-top-color', 'margin-top'],
  },
```

- [ ] **Step 3: Regenerate and compare**

```bash
npm i --no-save tsx puppeteer
npx tsx scripts/gen-cascade-goldens.ts
npx vitest run test/csscascade-suite.test.ts
```

Expected: the generator prints a new case count, comparison count, byte count
and sha256. The suite must pass. **If a comparison fails it is REAL — fix
`src/`, never the goldens.** If Chrome genuinely disagrees with a rule this
plan asserts, STOP and report it rather than adjusting the fixture; that is
what happened to `calc(10px / 0)` in `zch2.2.6` and it changed the design.

- [ ] **Step 4: Update PROVENANCE.md**

Update the table row for `goldens.json` with the exact bytes, case count,
comparison count and sha256 the generator printed — verify them against the
file rather than trusting the console:

```bash
node -e "
const {createHash}=require('node:crypto');const {readFileSync,statSync}=require('node:fs');
const p='test/fixtures/css-cascade/goldens.json';
console.log('bytes  ', statSync(p).size);
console.log('sha256 ', createHash('sha256').update(readFileSync(p)).digest('hex'));
const j=JSON.parse(readFileSync(p,'utf8'));
console.log('cases  ', j.cases.length);
console.log('compare', j.cases.reduce((n,c)=>n+c.values.length*c.props.length,0));
"
```

Then add a paragraph after the `zch2.2.6` one describing what the four new
cases anchor, and add a numbered entry to the "ceiling" list:

> **Custom properties themselves are not compared.** Chrome exposes them
> through `getComputedStyle().getPropertyValue('--x')`, but this stack does
> not store one on `ComputedStyle` — the environment dies with the compute
> walk — so there is no value to compare. What the corpus anchors is their
> EFFECT, which is every case above. The comparator names `--*` explicitly
> rather than letting it fall through `KEY_OF`, so the exclusion is a
> decision rather than the silent `ok: true` that `isComparedProp` exists to
> catch.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/cascade-goldens.ts scripts/gen-cascade-goldens.ts \
        test/fixtures/css-cascade/goldens.json test/fixtures/css-cascade/PROVENANCE.md
git commit -m "test(zch2.2.7): Blink corpus cases for custom properties and var()"
```

---

### Task 9: Mutation sweep

**Files:**
- No production change unless a mutation survives.

Every rule in this issue must be proved load-bearing. A mutation that reddens
nothing is RECORDED as uncovered in `CLAUDE.md` (Task 10), never quietly kept.

- [ ] **Step 1: Write the mutation harness**

Create a throwaway script outside the repo (use the session scratchpad
directory, not `scripts/`, so it cannot be committed):

```js
// mutate.mjs — apply one mutation, run tests, report which redden, restore.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const [, , srcPath, testPath, specPath] = process.argv;
const MUTATIONS = JSON.parse(readFileSync(specPath, 'utf8'));
const original = readFileSync(srcPath, 'utf8');
for (const m of MUTATIONS) {
  if (!original.includes(m.find)) { console.log(`!! ${m.name}: FIND NOT PRESENT`); continue; }
  writeFileSync(srcPath, original.replace(m.find, m.replace));
  let out = '';
  try {
    out = execSync(`npx vitest run ${testPath} --reporter=json`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { out = e.stdout ?? ''; }
  const failed = JSON.parse(out.slice(out.indexOf('{'))).testResults
    .flatMap((f) => f.assertionResults).filter((a) => a.status === 'failed')
    .map((a) => a.title);
  console.log(`\n== ${m.name}`);
  console.log(failed.length === 0 ? '   NOTHING REDDENED' : failed.map((t) => `   red: ${t}`).join('\n'));
}
writeFileSync(srcPath, original);
console.log('\nrestored');
```

- [ ] **Step 2: Run these mutations against `src/cssvar.ts`**

Test target: `test/cssvar.test.ts test/csscascade.test.ts test/csscompute.test.ts test/htmlflow.test.ts test/csscascade-suite.test.ts`

| Mutation | Must redden |
|---|---|
| `hasVar` does not recurse into functions (drop the `x.kind === 'function'` line) | the calc nesting case |
| `varNames` skips fallbacks (drop the `if (parts.fallback …)` line) | the #19 fallback-inside-a-cycle case |
| `varParts` splits on EVERY comma (`args.slice(i + 1, next comma)`) | the #9 two-family fallback case |
| `varParts` returns `{ name, fallback: [] }` when there is no comma | "fails when an undefined property has NO fallback" |
| `substituteValue` uses the fallback for an EMPTY property (`got.length === 0` treated as undefined) | the #4 empty case |
| `customPropEnv` seeds `env` from the parent WITHOUT deleting own names | the #21 self-reference case |
| `customPropEnv` marks names that merely DEPEND on a cycle | "lets a name OUTSIDE the cycle use its fallback" |
| `customPropEnv` returns a fresh `new Map(parent)` instead of `parent` on the empty path | nothing — **this is a cost rule; record it as uncovered** |
| `VAR_BUDGET` raised to `Number.MAX_SAFE_INTEGER` | the budget case |
| `resolveDeclValue` reports a failed re-expansion as `'undefined-var'` | the "unparsable re-expansion" case |

- [ ] **Step 3: Run these mutations against `src/csscascade.ts`**

| Mutation | Must redden |
|---|---|
| `isCustomProperty(d.name)` replaced with `isCustomProperty(d.name.toLowerCase())` | the #3 case-sensitivity case |
| the `hasVar(d.value)` pending branch removed | the pending and "not unparsable" cases |
| `isCustomProperty` allows `--` (`length >= 2`) | the #13 case |

- [ ] **Step 4: Run these mutations against `src/csscompute.ts`**

| Mutation | Must redden |
|---|---|
| the environment built AFTER font-size (move the block below the font-size call) | "resolves a var() in font-size" |
| `resolveDeclValue` called AFTER `cssWideOf` | should redden nothing today — **record as uncovered**, and note that `--x: inherit` is unmeasured |
| the `cp.invalid` reporting loop removed | the cycle-reporting case |
| a `fail` returns `undefined` instead of `fallback()` | many |

- [ ] **Step 5: Record the results**

Write down every mutation that reddened nothing. These go into `CLAUDE.md` in
Task 10 as explicitly uncovered rules — the practice that found two real gaps
and one redundant-defence pair in `zch2.2.6`.

- [ ] **Step 6: Fix any genuine gap and commit**

If a mutation that SHOULD redden does not, the test is not load-bearing: add
the case that catches it, then re-run.

```bash
git add test/
git commit -m "test(zch2.2.7): close the gaps the mutation sweep found"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md` — a `cssvar.ts` entry and notes on the neighbours
- Modify: `CHANGELOG.md` — an `### Added` entry under `## [Unreleased]`
- Modify: `README.md` — the Limitations paragraph listing `var()` as absent

- [ ] **Step 1: Add the `cssvar.ts` entry to CLAUDE.md**

Insert it after the `csscalc.ts` entry in the Source list. It must carry, as
invariants: the pure-leaf rule and its one-way dependencies; that the
environment holds ALREADY-substituted values, which is what lets substitution
splice rather than recurse; the dependency-graph cycle model with #19-#21
spelled out as the three ways the obvious implementation is wrong; the
identity-reuse rule and what it protects; the case-sensitivity trap and its
exact location (`csscascade.ts`'s first line of `toLonghands`); the pending
shorthand and why it preserves "shorthands expand before the sort"; the
fallback-not-used-on-a-failed-grammar rule (#1); token-level substitution
forced by #12; and the budget divergence with Chrome's measured 100,000.

Then run the module sweep and confirm `cssvar.ts` is no longer listed:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected: `cssvar.ts` absent from the output. Five pre-existing modules
(`colorkey.ts`, `errors.ts`, `formremove.ts`, `htmlforms.ts`, `tabletag.ts`)
will still be listed — those are not this issue's to fix.

- [ ] **Step 2: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Added`, newest first. It must say what a user
gets (`--brand: #336699; color: var(--brand)` now works through `AddHtml`,
including in shorthands and inside `calc()`), why the model is what it is, and
name the divergence and the reporting. Cite `(zch2.2.7)` at the end.

- [ ] **Step 3: Update README Limitations**

In the "HTML rendering is a documented subset" paragraph, remove `var()` and
custom properties from the "Also absent" list and add them to the "What does
render" list, noting that an unresolvable `var()` is reported rather than
silently dropped.

- [ ] **Step 4: Verify everything**

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean, 536 files green, `dist/index.js` produced.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md README.md
git commit -m "docs(zch2.2.7): CHANGELOG, README and CLAUDE.md for custom properties"
```

- [ ] **Step 6: Close the issue and push**

```bash
bd close zch2.2.7 --reason "<what shipped, the model, the divergence, the corpus numbers>"
git add -A .beads && git commit -m "chore(beads): close zch2.2.7"
git checkout main && git merge --ff-only zch2.2.7-css-var && git push origin main
git status -sb   # MUST show main...origin/main with no ahead/behind
```

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: the cascade
changes to Task 5; the engine's five rules to Tasks 1-2; termination to Tasks
2-3; pending re-expansion to Task 4; the compute integration and reporting to
Task 6; testing to Tasks 1-7 and 9; the corpus to Task 8; documentation to
Task 10. The spec's "out of scope" list needs no task by definition.

**Two spec claims this plan deliberately narrows.** The spec says the corpus
can compare custom properties *by name* because #18 showed Chrome exposes
them. Task 8 does NOT do that, and says why: we do not store them on
`ComputedStyle`, so there is nothing on our side to compare. The corpus
anchors their effect instead, and the exclusion is named in the comparator so
it stays a decision. The spec's `customPropEnv` signature returned
`invalid: string[]`; this plan uses `ReadonlyMap<string, VarFail>`, because
the compute layer needs the reason to report it.

**Type consistency.** `VarFail` is the one failure type, produced by
`substituteValue`, `customPropEnv` and `resolveDeclValue` and consumed by
`UnsupportedDeclaration.reason`; it carries `'unparsable-value'` as well as
the two new reasons so that a failed shorthand re-expansion is reported
honestly. `DeclValue` is defined in Task 1 and used unchanged in Tasks 4, 5
and 6. `VarEnv` is `ReadonlyMap<string, CssValue[]>` throughout.

**One test corrected during self-review.** The end-to-end inheritance case
first asserted `TextFragment.color`, which does not exist: text.ts records an
invariant that a fragment deliberately carries no colour, because
`fragmentsFromGlyphs` merges across a colour change and could only report one
of them. It asserts font-size instead, with a third render proving the
equality is not vacuous.

**Known-unmeasured, flagged in Task 9 rather than guessed:** whether
`--x: inherit; color: var(--x)` treats the substituted keyword as a CSS-wide
keyword. This plan resolves before `cssWideOf`, which makes it behave as one.
Chrome was not probed for it.
