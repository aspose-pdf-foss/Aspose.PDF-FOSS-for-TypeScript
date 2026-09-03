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
import { expandShorthand, GOVERNS } from './cssshorthand.js';

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
