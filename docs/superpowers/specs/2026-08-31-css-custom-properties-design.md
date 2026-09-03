# CSS custom properties and `var()` — design

Issue: `zch2.2.7`, under `zch2.2`, under epic `zch2` (HTML to PDF conversion,
`gap-vs-java`).
Date: 2026-08-31.

`zch2.2.3` closed with the cascade — six tiers, inheritance, 43 longhands,
203 Blink comparisons. `zch2.2.6` closed with the math functions. This is the
last piece split out of `zch2.2.3`, and the only one that changes the
**pipeline** rather than adding a value form: custom properties cascade and
inherit like any other property, so they must be resolved first, substituted
into other declarations, and those declarations re-parsed.

Nothing here produces PDF and nothing is exported from `index.ts`. The
feature is user-visible only through `AddHtml`, which `zch2.5` already ships.

Every claim below about what CSS does is **measured against Chrome/152.0.7977.54**
through puppeteer, not read off the spec — the practice that corrected
`zch2.2.6` on `calc(10px / 0)` and corrected `zch2.2.2` on type-name folding.
The probe was throwaway; its twenty-five results are reproduced here because
seven of them are counter-intuitive and three changed the design.

## What the probe measured

| # | Input | Chrome | Rule |
|---|---|---|---|
| 1 | `--x:10px; color:var(--x, red)`, inherited green | `rgb(0,128,0)` | **The fallback is NOT used** when the substituted value merely fails the property |
| 2 | `color:var(--nope, red)` | `rgb(255,0,0)` | The fallback IS used when the property is undefined |
| 3 | `--Foo:red; color:var(--foo, blue)` | `rgb(0,0,255)` | Custom property names are **case-sensitive** |
| 4 | `--e: ; color:var(--e, red)`, inherited green | `rgb(0,128,0)` | An empty custom property is valid, substitutes nothing, and is not guaranteed-invalid |
| 5 | `--a:var(--b); --b:var(--a); color:var(--a, red)` | `rgb(255,0,0)` | A cycle IS guaranteed-invalid, so the fallback fires |
| 6 | `#o{--c:rgb(1,2,3)}` on a child | `rgb(1,2,3)` | Custom properties inherit |
| 7 | `border:2px solid var(--c)` | `2px solid rgb(4,5,6)` | A shorthand carrying a `var()` still sets every longhand |
| 8 | `border:var(--w) dashed blue` | `3px dashed rgb(0,0,255)` | …including when the `var()` is the first component |
| 9 | `font-family:var(--nope, Georgia, serif)` | `Georgia, serif` | The fallback is everything after the **first** comma |
| 10 | `color:var(--a, var(--b, blue))`, `--b:rgb(7,8,9)` | `rgb(7,8,9)` | `var()` nests inside a fallback |
| 11 | `--w:10px; margin-top:calc(var(--w) * 2)` | `20px` | `var()` resolves inside `calc()` |
| 12 | `--op:+ 5px; margin-top:calc(10px var(--op))` | `15px` | **A variable can supply an OPERATOR token into `calc()`** |
| 13 | `--:red; color:var(--, blue)`, inherited green | `rgb(0,128,0)` | `--` alone is not a valid custom property name |
| 14 | `color:var(--nope)` under `#o{color:rgb(10,11,12)}` | `rgb(10,11,12)` | IACVT on an inherited property **inherits** |
| 15 | `margin-top:var(--nope)` under `#o{margin-top:40px}` | `0px` | IACVT on a non-inherited property takes the **initial** |
| 16 | billion laughs, 10⁵ expansion | 100,000 tokens, survived | Chrome does not refuse it at that size |
| 17 | `--c:red; --c:blue!important` | `rgb(0,0,255)` | `!important` applies to custom properties |
| 18 | `getPropertyValue('--brand')` | `#336699` | **Custom properties are readable through `getComputedStyle`** |
| 19 | `--a:var(--b, blue); --b:var(--a); color:var(--a)` | inherited green | A fallback **inside** a cycle does not rescue it |
| 20 | `--a:var(--a, blue)` | inherited green | A self-reference is a cycle, fallback and all |
| 21 | `#o{--a:rgb(1,2,3)}`, then `#t{--a:var(--a); color:var(--a, red)}` | `rgb(255,0,0)` | **A declared name never sees its own INHERITED value** |
| 22 | `#o{--a:rgb(1,2,3)}`, `#t{--a:rgb(4,5,6); --b:var(--a)}` | `rgb(4,5,6)` | The element's own declaration shadows the parent's |
| 23 | `--b:var(--a); --a:rgb(7,8,9)` | `rgb(7,8,9)` | Declaration ORDER within an element does not matter |
| 24 | `--junk:var(--nope); color:rgb(1,1,1)` | `rgb(1,1,1)` | An invalid custom property poisons nothing else |
| 25 | `--all:var(--w) solid rgb(2,3,4); border:var(--all)` | `5px` | One variable can carry a whole shorthand value |

Three of these changed the design.

**#12 forces token-level substitution, and forces it to happen before any
grammar sees the value.** A variable may carry a bare `+` — it is not a value,
it is a fragment of one. So substitution cannot be "parse the property, then
fill in a hole"; it must rewrite the token stream and hand the result to the
property's own parser afterwards. That is what makes `csscalc.ts` and every
other consumer work with no change at all.

**#18 makes the oracle far stronger than `zch2.2.6`'s.** That issue could put
only percentage-free cases in the Blink corpus, because `getComputedStyle`
returns used pixels for anything a percentage touches. Here almost the whole
feature is comparable — the resolved value is a plain colour or length — and
the custom properties themselves can be compared *by name*, so the corpus can
check the environment as well as its effect.

## Where the work goes

Three modules, one new.

```
csscascade.ts ──> cssvar.ts <── csscompute.ts
                      │
                      └──> cssshorthand.ts
```

`cssvar.ts` imports `cssparse.js`/`csstoken.js` for types and
`cssshorthand.js` for re-expansion, and nothing else — no `htmldom`, no
`csscascade`, no `Document`, no `node:`. Dependencies run one way throughout;
there is no cycle to break.

An alternative was considered and rejected: a separate resolution pass
between `cascade` and `compute`, which reads more literally like the issue
text. It would duplicate the parent-threading walk `csscompute.ts` already
makes, and it needs `ElementDeclarations` from `csscascade.ts` while
`csscascade.ts` needs `hasVar` from it — a source-level cycle whose only
clean fix is duplicating a type shape.

### `csscascade.ts` — two branches and a widening

`toLonghands` gains a custom-property branch and a pending-shorthand branch.

**The custom-property branch must run before the name is lowercased.** That
function opens with `const name = d.name.toLowerCase()`, and by #3 a custom
property name is case-sensitive — the one name in CSS that is. The check and
the stored key both use the raw `d.name`. A name is a custom property when it
starts with `--` and is longer than two characters (#13).

**The pending-shorthand branch must run before `expandShorthand`,** which
would otherwise fail and record the declaration unparsable. A shorthand whose
value contains a `var()` anywhere emits one *pending* entry per longhand it
governs, each carrying the shorthand's name and its raw value. The cascade
then sorts those pendings as ordinary longhands, so the recorded invariant —
shorthands expand before the sort, because the cascade sorts longhands only —
survives untouched. This needs `cssshorthand.ts` to export its existing
`GOVERNS` map, or an accessor over it.

A *longhand* containing `var()` needs no branch: it passes through as its raw
value and is substituted at compute time.

```ts
// cssvar.ts
export interface PendingValue { pending: { shorthand: string; value: CssValue[] } }
export type DeclValue = CssValue[] | PendingValue;
```

`CompiledRule.decls` and both maps in `ElementDeclarations` carry `DeclValue`.
`ua` widens too and the `revert` branch guards it: the UA sheet contains no
`var()`, so a pending can never actually appear there, but typing it honestly
costs one check and avoids a claim the type cannot make.

### `cssvar.ts` — the engine

```ts
export type VarEnv = ReadonlyMap<string, CssValue[]>;

export function hasVar(v: CssValue[]): boolean;
export function customPropEnv(
  own: ReadonlyMap<string, CssValue[]>, parent: VarEnv,
): { env: VarEnv; invalid: string[] };
export function resolveDeclValue(
  d: DeclValue, longhand: string, env: VarEnv,
): { value: CssValue[] } | { fail: 'undefined-var' | 'var-cycle' };
```

Five rules, each silently wrong in a specific way if missed:

- **`hasVar` recurses** into `block.contents` and `function.args`.
  `calc(var(--w) * 2)` is the commonest nesting there is (#11), and a
  top-level-only scan sends the declaration on with a raw `var()` still in it.
- **The fallback starts at the first top-level comma**, and everything after
  it — commas included — is the fallback (#9). Splitting on every comma turns
  one two-family fallback into a malformed three-argument call.
- **The fallback fires only when the referenced property is
  guaranteed-invalid** — undefined (#2), cyclic (#5), or over budget — and
  **not** when the substituted result fails the property's grammar (#1). Both
  readings render a plausible page, which is why this is the rule most worth a
  named test.
- **An empty custom property is valid** (#4): it substitutes nothing and does
  not trigger the fallback. The declaration then usually becomes invalid on
  its own, which is a different route to the same fallback and must not be
  confused with it.
- **Substitution is recursive**, so a substituted value may itself contain
  `var()`. That is what makes cycle detection necessary rather than
  decorative.

**Cycles are found on a DEPENDENCY GRAPH, not with a resolution stack**, and
#19-#21 are why the obvious implementation is wrong in three separate ways.
The graph's nodes are the names declared **on this element**, and its edges
are every `var()` name reachable in a declaration's value — *including the
ones inside fallbacks* (#19). A name that can reach itself is in a cycle and
is guaranteed-invalid, fallback and all (#19, #20). A name merely *depending
on* a cycle member is not itself in one: `--c: var(--a, blue)` with `--a`
cyclic computes to blue, so the marking must be strictly the cycle members.

The rule that a draft resolver gets wrong silently is #21: **a name declared
on this element never sees its own inherited value.** Seeding the resolution
map from the parent and letting a declaration read through it makes
`--a: var(--a)` quietly resolve to the parent's `--a` instead of being the
self-cycle Chrome says it is. So the inherited entry for every name this
element declares is removed before resolution begins, and put back only as
that name's own resolved value.

With cycle members marked up front, resolution needs no stack at all: each
remaining name is resolved after its dependencies, which is what makes
declaration order within an element irrelevant (#23).

Cycle membership is computed by asking, for each declared name, whether it can
reach itself — O(n²) in the number of custom properties on one element, which
is a handful. Tarjan's algorithm is the general answer and is not worth its
own correctness risk at this size.

**A token budget is the second guard**, catching what no cycle check can: the
billion-laughs shape has *no* cycle and would grow until the heap died, the
failure `lexer.ts`'s recorded invariant exists to prevent elsewhere in this
repo.

**A measured divergence, recorded rather than discovered later:** Chrome
expanded 100,000 tokens and survived (#16). The budget here is **65,536
tokens per declaration**, comfortably above anything a real document
produces and below the point where transient allocation matters. Input
between the two figures renders in Chrome and is reported invalid here. No
real document is near it; the alternative is an unbounded expansion in a
library whose consumers hand it files they did not write.

**Pending re-expansion** substitutes into the shorthand's raw value, calls
`expandShorthand`, and takes the requested longhand. Failure of either step
makes that longhand invalid at computed-value time — and only that longhand,
which is what makes #8's "the other longhands still apply" fall out.

### `csscompute.ts` — one environment threaded through the walk it already makes

Per element, **before `font-size`**, the environment is built from the
element's own cascaded `--*` declarations resolved against the parent's. That
placement is what lets `font-size: var(--fs)` work without disturbing the
recorded font-size-then-color ordering, and it costs nothing: an element
declaring no custom properties **reuses the parent's map by identity**, so a
document with none allocates nothing and the existing byte-identity fences
cannot move.

`resolveProp` gains one step before `def.compute`: resolve the declared
`DeclValue` against the environment. A failure routes into the `fallback()`
that function already has — which is CSS's invalid-at-computed-value-time,
already implemented and already documented there for an unparsable value, and
which #14 and #15 confirm is the right shape (inherited properties inherit,
others take the initial). **The new failure path is the existing failure
path.**

Custom properties are **not** added to `ComputedStyle`. The 43-longhand count
stays 43 and stays asserted; the environment is a separate map that dies with
the walk.

### Reporting

`UnsupportedDeclaration.reason` gains `'undefined-var'` and `'var-cycle'`.
"`--brand` is not defined" is far more actionable for a caller than
"unparsable value", and this report exists precisely to make what we could not
render reportable. Additive at runtime; source-breaking only for a caller
doing an exhaustive `switch` on `reason`, the same class of change
`AnnotationTextKey` already records.

A budget overflow reports `'var-cycle'`, whose documentation reads "a
reference cycle, or an expansion that exceeded the budget". A third reason for
input no real document produces is noise, and a caller's action is identical.

## Testing

`test/cssvar.test.ts` drives the engine from hand-written token streams — no
DOM, no document — covering the five rules above, both termination guards, and
the pending re-expansion. Cascade-level behaviour (case sensitivity,
inheritance, `!important` on a custom property, pending shorthands) goes in
`test/csscascade.test.ts` and `test/csscompute.test.ts`. An end-to-end case
goes through the public `AddHtml` in `test/htmlflow.test.ts`.

Every rule is mutation-checked, and anything that reddens nothing is recorded
as uncovered rather than quietly kept — the practice that found two real gaps
in `zch2.2.6` and one redundant defence pair.

The Blink corpus in `test/fixtures/css-cascade/` grows by the cases in the
table above that compute to a comparable value, which is nearly all of them.
Because of #18 the generator can also record custom properties **by name**, so
the corpus checks the environment and not only its effect; that needs one
change to `test/helpers/cascade-goldens.ts`, which currently has no comparator
row for a `--*` property and would silently return `ok: true` for one. The
`isComparedProp` test already guards exactly that hole.

Two cases the corpus provably cannot see, pinned by unit test instead:

- **The budget divergence** (#16), for the reason recorded above.
- **A `var()` whose first argument is not a custom property name**
  (`var(nope, red)`). Measured: Chrome computes the inherited green, and so
  does a build that treats the declaration as invalid at parse time and one
  that treats it as invalid at computed-value time. The corpus cannot
  distinguish them; the spec says parse-time, and that is what we implement.

## Out of scope, stated so it stays a decision

- **`@property` and registered custom properties** — types, initial values,
  and the different invalidation rules that follow from them.
- **`env()`**.
- **`var()` in a selector or an at-rule prelude**, which CSS does not permit
  anyway.
- **Animation and transition of custom properties**, there being no animation
  in this stack at all.

Each is a separate feature rather than a corner of this one.
