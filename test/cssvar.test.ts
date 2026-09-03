import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import {
  isCustomProperty, hasVar, varNames, substituteValue, VAR_BUDGET,
  customPropEnv, resolveDeclValue,
} from '../src/cssvar.js';
import type { VarEnv } from '../src/cssvar.js';

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
    // top-level-only scan misses it, sending the declaration on to a grammar
    // that cannot read a raw var().
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

/** Substitute, and render the result back to a comparable string. */
const sub = (src: string, env: Record<string, string>) => {
  const m = new Map<string, ReturnType<typeof V>>();
  for (const [k, s] of Object.entries(env)) m.set(k, V(s));
  const r = substituteValue(V(src), m);
  return 'fail' in r ? r.fail : text(r.value);
};

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

  it('splices an environment value VERBATIM rather than recursing into it', () => {
    // The environment holds already-substituted values by contract — that is
    // customPropEnv's job — so a raw var() reaching this map is spliced as
    // the tokens it is. Stated directly because the natural assumption is
    // that substitution recurses through the environment, and the
    // billion-laughs guard therefore belongs to customPropEnv, not here.
    expect(sub('var(--a)', { '--a': 'var(--b)' })).toBe('var(--b)');
  });

  it('refuses an expansion past the budget rather than growing forever', () => {
    // One splice big enough to blow the budget on its own. The realistic
    // shape — a chain of variables each doubling the last — is built by
    // customPropEnv and is guarded there.
    const big = new Array(VAR_BUDGET + 10).fill('a').join(' ');
    expect(sub('var(--a)', { '--a': big })).toBe('var-cycle');
  });
});

describe('customPropEnv', () => {
  const own = (o: Record<string, string>) => {
    const m = new Map<string, ReturnType<typeof V>>();
    for (const [k, s] of Object.entries(o)) m.set(k, V(s));
    return m;
  };
  const parentEnv = (o: Record<string, string>) => own(o) as VarEnv;
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

  it('refuses a BILLION-LAUGHS chain, which has no cycle at all', () => {
    // Each level splices the resolved level below it, so the expansion is
    // exponential: 10^5 tokens by --e. Only the budget can see this; the
    // cycle check cannot, because there is no cycle.
    const o: Record<string, string> = { '--a': 'a a a a a a a a a a' };
    for (const [to, from] of [['--b', '--a'], ['--c', '--b'], ['--d', '--c'], ['--e', '--d']]) {
      o[to as string] = new Array(10).fill(`var(${from as string})`).join(' ');
    }
    expect(customPropEnv(own(o), new Map()).invalid.get('--e')).toBe('var-cycle');
  });
});

describe('resolveDeclValue', () => {
  const env = (o: Record<string, string>) => {
    const m = new Map<string, ReturnType<typeof V>>();
    for (const [k, s] of Object.entries(o)) m.set(k, V(s));
    return m as VarEnv;
  };
  const got = (r: ReturnType<typeof resolveDeclValue>) =>
    'fail' in r ? r.fail : text(r.value);

  it('passes a var-free longhand through UNCHANGED', () => {
    // The same array, not a copy: that is what keeps a document with no
    // custom properties byte-identical through this module.
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
