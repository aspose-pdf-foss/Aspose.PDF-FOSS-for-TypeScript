# Type 4 PostScript calculator functions

Design for `aspose-pdf-foss-for-ts-imxw.3`, the last of the three constructs
named in the `imxw` epic (interpreter coverage for legacy font and function
types).

## Problem

[pdffunction.ts](../../../src/pdffunction.ts) implements FunctionType 0, 2 and
3. Everything else — including type 4, the PostScript calculator function —
falls through to a single branch that returns a constant:

```ts
// type 4 (PostScript) and anything unsupported: constant midpoint of Range/[0,1].
```

So every type 4 function evaluates to the midpoint of its `/Range`, for every
input. Three callers consume the result and none can tell:

| Caller | What a flat value produces |
|---|---|
| `raster.ts`, `svgrender.ts` (shadings) | a gradient of one uniform colour |
| `colorspace.ts` (`separationConverter`) | every Separation/DeviceN tint resolves to one colour |

No error is raised anywhere. The page renders, and it is the wrong colour.

This is the smallest of the epic's P0 items: one fallback branch to replace, no
new dependency, and no PDF object access in the new code.

## Scope

In scope: parsing and evaluating the type 4 program, and dispatching to it from
`parseFunction`.

Out of scope: the type 0 higher-dimensional interpolation (`pdffunction.ts`
currently uses nearest-neighbour for m > 1 and that is untouched here), and any
change to how the three callers request or cache colours beyond the evaluator's
own memo.

## Approaches considered

**Rejected: inline the interpreter in `pdffunction.ts`.** That file is 113 lines
and owns one clear job — read a function dict, return a numeric map. The
interpreter is ~200 lines of stack machine with no PDF knowledge at all. Folding
it in triples the file and merges two unrelated concerns.

**Rejected: a bespoke scanner.** The tokenizer already handles this grammar. See
below.

**Chosen: a separate pure module, `src/psfunc.ts`,** tokenized by the existing
`lexer.ts`, with `pdffunction.ts` keeping ownership of `/Domain`, `/Range` and
the type dispatch — exactly as it does for types 0, 2 and 3.

## Architecture

### `src/psfunc.ts` — the whole feature

Pure: bytes in, numeric map out. No `Document`, no `PdfDict`, no resolve/inflate
callbacks. This is what makes it testable against the spec's own worked examples
without building a PDF.

```ts
/** A parsed type 4 program. `undefined` from parsePostScriptFunction when the
 *  bytes are not a program we can read. */
export type PsProgram = PsOp[];
export function parsePostScriptFunction(src: Uint8Array): PsProgram | undefined;
/** Evaluate with `nOut` outputs. `undefined` on a runtime fault. */
export function evalPostScript(prog: PsProgram, input: number[], nOut: number): number[] | undefined;
```

### Grammar and tokenizing

Tokenized by `lexer.ts`, which already handles this grammar exactly:

- `{` and `}` are in its delimiter set and come back as one-character `kw`
  tokens. This is not incidental — CLAUDE.md records it as an invariant: they
  are "delimiters no production claims, so `readRegular` stops on them without
  advancing and they come back as one-character keywords".
- Numbers arrive as `num`, operators as `kw`, and `%` comments are skipped.

Type 4 therefore becomes the **fourth non-object grammar** over that tokenizer,
beside content streams, CMaps (`cmap.ts`) and `/DA` strings (`da.ts`). It
follows the same rule those three do, and the one that separates them from
`object-parser.ts`: **an unrecognised token is not a syntax error at this
layer.** Only `object-parser.ts` may reject, because only it has a grammar in
which a stray keyword cannot appear.

Parsed once into a nested op list. A `{ ... }` procedure becomes a sub-array,
which is the only shape it can take — procedures appear solely as the operands
of `if` and `ifelse`. The outer brace wrapping the whole program is accepted but
not required, since producers sometimes omit it.

### Semantics

The operator set is closed and fully enumerated in 32000-1 7.10.5: **42
operators** across its four tables — 21 arithmetic (`abs add atan ceiling cos
cvi cvr div exp floor idiv ln log mod mul neg round sin sqrt sub truncate`), 13
relational/boolean/bitwise (`and bitshift eq false ge gt le lt ne not or true
xor`), 2 conditional (`if ifelse`) and 6 stack (`copy dup exch index pop roll`).
Being closed is what makes completeness checkable rather than a judgement call.

Three properties are easy to implement wrongly in a way that still returns
plausible numbers.

**Two numeric types, not one.** The calculator distinguishes integers from
reals. `idiv`, `mod` and `bitshift` are integer-only, and `cvi` truncates toward
zero while `cvr` widens. `1 2 idiv` is `0`, not `0.5`. A stack that holds only
JavaScript numbers and ignores the distinction produces smooth wrong output
rather than an error — the same silent-wrongness this issue exists to remove.

**`and`, `or`, `xor` and `not` are overloaded on operand type** — boolean logic
on booleans, bitwise on integers. So the stack is `(number | boolean)[]`, and
`if`/`ifelse` consume a real boolean rather than a truthy number.

**Trigonometry is in degrees.** `sin` and `cos` take degrees, and `atan`
*returns* degrees in the range 0–360 — not radians, and not signed. Using
radians yields a smooth, entirely plausible, entirely wrong gradient.

### Output

`/Range` is required for a type 4 function and fixes the output count `n`. The
result is the **topmost `n` values** on the stack, ordered so the last output is
on top; anything remaining below them is discarded. Each output is clamped to
its `/Range` pair.

Inputs are already clamped to `/Domain` by `pdffunction.ts`'s existing
`clampDomain`, so `psfunc.ts` neither sees nor needs the domain.

### Failure

Nothing in this module throws into rendering.

- **Parse failure** — unbalanced braces, a program that is not a program —
  returns `undefined`, and `parseFunction` falls through to the existing
  midpoint constant. A file we cannot read behaves exactly as it does today.
- **Runtime fault** — stack underflow, a `roll` with nonsense operands,
  recursion past the depth bound — returns the midpoint for that call.

The midpoint therefore stops being the answer for *all* type 4 functions and
becomes the answer only for genuinely broken ones, which is the issue's stated
acceptance criterion. The cost is acknowledged: a subtly broken program still
paints flat colour with no signal. That is the same trade the rest of the
renderer makes, and the alternative — throwing — would let one bad tint
transform take down a whole page.

An unrecognised operator is skipped rather than faulting, consistent with the
three other grammars over this tokenizer: damage costs the bytes it touches.

### Cache

A bounded memo inside the closure `parseFunction` returns, keyed on the input
tuple, capped at 4096 entries and cleared wholesale on overflow.

This exists because of one call pattern. Shadings evaluate a function 257 times
through `buildColorLut`, which is free. But `colorspace.ts`'s
`separationConverter` calls `tint` inside `toRgb`, which runs **per pixel** for
an image in a Separation or DeviceN space — potentially millions of interpreted
program runs. A 1-input Separation over 8-bit samples has only 256 distinct
inputs, so the memo collapses an entire image to 256 evaluations.

The function is pure by construction, so the cache is unobservable. It lives in
the evaluator rather than in `colorspace.ts` because caching one level up would
change behaviour for function types this issue does not touch.

## Testing

**`test/psfunc.test.ts`** — the interpreter in isolation, on hand-written
programs:

- each operator group, with the three subtle cases asserted directly: `idiv`
  and `mod` on integers, `and`/`not` in both their boolean and bitwise readings,
  and `sin`/`cos`/`atan` in degrees
- the two idioms that actually appear in real files: the two-argument minimum
  (`2 copy lt { pop } { exch pop } ifelse`) and a multi-output tint ramp, each
  with hand-computed expected values rather than quoted from the standard
- `if` and `ifelse`, including nesting
- `roll`, `index` and `copy`, whose off-by-ones are invisible in a gradient
- malformed programs: unbalanced braces, stack underflow, unknown operator

**`test/pdffunction.test.ts`** (extend) — dispatch to type 4, `/Range` clamping,
the output count and order, and the malformed-program fallback to the midpoint.

**Acceptance, matching the issue's two criteria** — a shading whose type 4
function drives a *varying* gradient, asserted on rendered pixels. Flatness is
what the bug produces, so the assertion must fail on a flat result. And a
Separation colorant with a PostScript tint transform resolving to the correct
alternate-space colour.

**Load-bearing, not merely green.** Per the repo's fixture rules, each assertion
is confirmed by breaking the path it covers: trig in radians rather than
degrees, `idiv` as ordinary division, the output order reversed, the `/Range`
clamp removed, and the `if`/`ifelse` branches swapped.

## Files

| File | Change |
|---|---|
| `src/psfunc.ts` | new — parser + evaluator, ~200 lines |
| `src/pdffunction.ts` | type 4 branch; midpoint fallback narrowed to unsupported types |
| `test/psfunc.test.ts` | new |
| `test/pdffunction.test.ts` | extend — the file exists and covers types 0/2/3 |
| `CLAUDE.md` | the tokenizer-reuse and degrees/integer invariants |
| `README.md` | shading and Separation coverage no longer excludes type 4 |
