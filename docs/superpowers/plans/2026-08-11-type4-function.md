# Type 4 PostScript Calculator Functions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate FunctionType 4 (PostScript calculator) functions, so shadings, Separation/DeviceN tint transforms and soft masks stop painting a flat wrong colour.

**Architecture:** A new pure module `src/psfunc.ts` parses a type 4 program with the existing `lexer.ts` into a nested op list and interprets it over a `number | boolean | procedure` stack. `src/pdffunction.ts` keeps ownership of `/Domain`, `/Range` and the type dispatch, adds a bounded memo, and narrows its constant-midpoint fallback from "all type 4" to "genuinely unreadable".

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-08-11-type4-function-design.md](../specs/2026-08-11-type4-function-design.md)
**Issue:** `aspose-pdf-foss-for-ts-imxw.3`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Relative imports carry the `.js` extension.
- **`strict` TypeScript.** `npm run typecheck` must be clean.
- **`src/psfunc.ts` touches no PDF objects.** No `PdfDict`, no resolve/inflate callbacks, no `Document`. Bytes in, numbers out. This is what makes it testable without building a PDF, and it is a review gate, not a preference.
- **Nothing throws into rendering.** Parse failure returns `undefined`; a runtime fault returns `undefined`. `pdffunction.ts` converts either into the existing midpoint constant.
- **An unrecognised token is not a syntax error here.** Type 4 is the fourth non-object grammar over `lexer.ts` (with content streams, `cmap.ts` and `da.ts`); only `object-parser.ts` may reject. Skip what you do not recognise.
- **Both gates before closing:** `npm run typecheck` and `npm test`.
- **Task tracking is `bd`, not TodoWrite** (CLAUDE.md).
- **Commit after every task**, ending the message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `src/psfunc.ts` (create) | Parse + interpret a type 4 program. Pure |
| `src/pdffunction.ts` (modify) | Type 4 dispatch, `/Range` clamp, memo; midpoint narrowed |
| `test/psfunc.test.ts` (create) | The interpreter in isolation, operator by operator |
| `test/pdffunction.test.ts` (modify) | Dispatch, clamping, output order, fallback |
| `test/helpers/build-svg-fixtures.ts` (modify) | Two fixtures: a type 4 shading and a type 4 Separation |
| `test/raster-shading.test.ts` (modify) | Acceptance: a *varying* gradient |
| `CLAUDE.md`, `README.md` (modify) | Invariants and user-facing coverage |

---

### Task 1: The interpreter

**Files:**
- Create: `src/psfunc.ts`
- Test: `test/psfunc.test.ts` (create)

**Interfaces:**
- Consumes: `Lexer` from `./lexer.js`.
- Produces:

```ts
export type PsOp = number | boolean | string | PsOp[];
export type PsProgram = PsOp[];
export function parsePostScriptFunction(src: Uint8Array): PsProgram | undefined;
export function evalPostScript(prog: PsProgram, input: number[], nOut: number): number[] | undefined;
```

- [ ] **Step 1: Write the failing test**

Create `test/psfunc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePostScriptFunction, evalPostScript } from '../src/psfunc.js';

/** Parse and run `src`, returning `nOut` outputs, or undefined on any fault. */
function run(src: string, input: number[] = [], nOut = 1): number[] | undefined {
  const prog = parsePostScriptFunction(new TextEncoder().encode(src));
  return prog === undefined ? undefined : evalPostScript(prog, input, nOut);
}
const approx = (v: number[] | undefined, n = 6): number[] | undefined =>
  v?.map((x) => +x.toFixed(n));

describe('type 4 arithmetic', () => {
  it('does the four basic operations', () => {
    expect(run('{ 3 4 add }')).toEqual([7]);
    expect(run('{ 10 3 sub }')).toEqual([7]);
    expect(run('{ 3 4 mul }')).toEqual([12]);
    expect(run('{ 7 2 div }')).toEqual([3.5]);
  });

  it('treats idiv and mod as integer operations', () => {
    // The case that separates a real implementation from a plausible one:
    // `div` here is 0.5, and a single-numeric-type interpreter returns it.
    expect(run('{ 7 2 idiv }')).toEqual([3]);
    expect(run('{ 1 2 idiv }')).toEqual([0]);
    expect(run('{ -7 2 idiv }')).toEqual([-3]);      // truncates toward zero
    expect(run('{ 7 2 mod }')).toEqual([1]);
    expect(run('{ -7 2 mod }')).toEqual([-1]);
  });

  it('converts and rounds', () => {
    expect(run('{ 3.7 cvi }')).toEqual([3]);
    expect(run('{ -3.7 cvi }')).toEqual([-3]);       // toward zero, not floor
    expect(run('{ 3 cvr }')).toEqual([3]);
    expect(run('{ 3.7 truncate }')).toEqual([3]);
    expect(run('{ 3.2 floor }')).toEqual([3]);
    expect(run('{ 3.2 ceiling }')).toEqual([4]);
    expect(run('{ 3.5 round }')).toEqual([4]);
    expect(run('{ -3.5 round }')).toEqual([-3]);     // ties toward +inf
  });

  it('does powers, roots and logarithms', () => {
    expect(run('{ 2 3 exp }')).toEqual([8]);
    expect(run('{ 9 sqrt }')).toEqual([3]);
    expect(run('{ 100 log }')).toEqual([2]);
    expect(approx(run('{ 1 ln }'))).toEqual([0]);
    expect(run('{ -5 abs }')).toEqual([5]);
    expect(run('{ 5 neg }')).toEqual([-5]);
  });

  it('does trigonometry in DEGREES, with atan in 0..360', () => {
    // Radians here produce a smooth, entirely plausible, entirely wrong ramp.
    expect(approx(run('{ 90 sin }'))).toEqual([1]);
    expect(approx(run('{ 0 sin }'))).toEqual([0]);
    expect(approx(run('{ 0 cos }'))).toEqual([1]);
    expect(approx(run('{ 180 cos }'))).toEqual([-1]);
    expect(approx(run('{ 60 sin }'), 4)).toEqual([0.866]);
    // `num den atan`, result in degrees, never negative.
    expect(approx(run('{ 0 1 atan }'))).toEqual([0]);
    expect(approx(run('{ 1 0 atan }'))).toEqual([90]);
    expect(approx(run('{ 0 -1 atan }'))).toEqual([180]);
    expect(approx(run('{ -1 0 atan }'))).toEqual([270]);
  });
});

describe('type 4 booleans and bitwise', () => {
  it('compares', () => {
    expect(run('{ 3 4 lt { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 4 3 lt { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ 3 3 eq { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 3 3 ne { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ 4 3 ge { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 3 4 le { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ 4 3 gt { 1 } { 0 } ifelse }')).toEqual([1]);
  });

  it('reads and/or/xor/not as boolean logic on booleans', () => {
    expect(run('{ true false and { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ true false or { 1 } { 0 } ifelse }')).toEqual([1]);
    expect(run('{ true true xor { 1 } { 0 } ifelse }')).toEqual([0]);
    expect(run('{ true not { 1 } { 0 } ifelse }')).toEqual([0]);
  });

  it('reads the same four as bitwise on integers', () => {
    expect(run('{ 12 10 and }')).toEqual([8]);
    expect(run('{ 12 10 or }')).toEqual([14]);
    expect(run('{ 12 10 xor }')).toEqual([6]);
    expect(run('{ 5 not }')).toEqual([-6]);          // ~5
    expect(run('{ 1 3 bitshift }')).toEqual([8]);
    expect(run('{ 8 -3 bitshift }')).toEqual([1]);   // negative shifts right
  });
});

describe('type 4 stack operators', () => {
  it('dup, exch and pop', () => {
    expect(run('{ 3 dup add }')).toEqual([6]);
    expect(run('{ 3 4 exch sub }')).toEqual([1]);    // 4 3 sub
    expect(run('{ 3 4 pop }')).toEqual([3]);
  });

  it('copy duplicates the top n', () => {
    expect(run('{ 1 2 3 2 copy }', [], 5)).toEqual([1, 2, 3, 2, 3]);
    expect(run('{ 1 2 3 0 copy }', [], 3)).toEqual([1, 2, 3]);
  });

  it('index reaches n down from the top', () => {
    expect(run('{ 10 20 30 2 index }', [], 4)).toEqual([10, 20, 30, 10]);
    expect(run('{ 10 20 30 0 index }', [], 4)).toEqual([10, 20, 30, 30]);
  });

  it('roll rotates the top n by j, in both directions', () => {
    expect(run('{ 1 2 3 3 1 roll }', [], 3)).toEqual([3, 1, 2]);
    expect(run('{ 1 2 3 3 -1 roll }', [], 3)).toEqual([2, 3, 1]);
    expect(run('{ 1 2 3 3 0 roll }', [], 3)).toEqual([1, 2, 3]);
    expect(run('{ 1 2 3 3 4 roll }', [], 3)).toEqual([3, 1, 2]);   // j wraps
  });
});

describe('type 4 conditionals', () => {
  it('runs if only when the condition holds', () => {
    expect(run('{ 5 true { 1 add } if }')).toEqual([6]);
    expect(run('{ 5 false { 1 add } if }')).toEqual([5]);
  });

  it('nests ifelse', () => {
    const src = '{ dup 0 lt { pop -1 } { dup 0 eq { pop 0 } { pop 1 } ifelse } ifelse }';
    expect(run(src, [-5])).toEqual([-1]);
    expect(run(src, [0])).toEqual([0]);
    expect(run(src, [5])).toEqual([1]);
  });

  it('computes a two-argument minimum, the idiom real files use', () => {
    const min = '{ 2 copy lt { pop } { exch pop } ifelse }';
    expect(run(min, [3, 4])).toEqual([3]);
    expect(run(min, [7, 4])).toEqual([4]);
    expect(run(min, [5, 5])).toEqual([5]);
  });
});

describe('type 4 inputs and outputs', () => {
  it('starts with the inputs already on the stack, in order', () => {
    expect(run('{ sub }', [10, 3])).toEqual([7]);
  });

  it('returns the TOPMOST n values, last output on top', () => {
    expect(run('{ 1 2 3 }', [], 2)).toEqual([2, 3]);
    expect(run('{ 1 2 3 }', [], 3)).toEqual([1, 2, 3]);
  });

  it('produces a multi-output tint ramp', () => {
    // 1 in, 3 out: R = t, G = 0, B = 1 - t.
    const ramp = '{ dup 0 exch 1 exch sub }';
    expect(approx(run(ramp, [0], 3))).toEqual([0, 0, 1]);
    expect(approx(run(ramp, [1], 3))).toEqual([1, 0, 0]);
    expect(approx(run(ramp, [0.25], 3))).toEqual([0.25, 0, 0.75]);
  });
});

describe('type 4 malformed programs', () => {
  it('rejects unbalanced braces at parse time', () => {
    expect(parsePostScriptFunction(new TextEncoder().encode('{ 1 2 add'))).toBeUndefined();
    expect(parsePostScriptFunction(new TextEncoder().encode('{ 1 { 2 }'))).toBeUndefined();
  });

  it('accepts a program with no outer brace', () => {
    expect(run('3 4 add')).toEqual([7]);
  });

  it('skips an operator it does not recognise', () => {
    // The rule every non-object grammar over this tokenizer follows: damage
    // costs the bytes it touches, not the whole program.
    expect(run('{ 3 bogusoperator 4 add }')).toEqual([7]);
  });

  it('faults rather than throwing on stack underflow', () => {
    expect(run('{ add }')).toBeUndefined();
    expect(run('{ 1 add }')).toBeUndefined();
  });

  it('faults when fewer than n outputs remain', () => {
    expect(run('{ 1 }', [], 3)).toBeUndefined();
  });

  it('faults on a non-finite result rather than emitting NaN', () => {
    expect(run('{ 0 0 div }')).toBeUndefined();
    expect(run('{ 1 0 div }')).toBeUndefined();
    expect(run('{ -1 sqrt }')).toBeUndefined();
  });

  it('faults on a type error instead of coercing', () => {
    expect(run('{ true 3 add }')).toBeUndefined();
    expect(run('{ 3 { 1 } add }')).toBeUndefined();
  });

  it('is bounded on a deeply nested program', () => {
    const deep = `${'{ '.repeat(500)}1${' }'.repeat(500)}`;
    expect(parsePostScriptFunction(new TextEncoder().encode(deep))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/psfunc.test.ts`
Expected: FAIL — cannot resolve `../src/psfunc.js`.

- [ ] **Step 3: Write the implementation**

Create `src/psfunc.ts`:

```ts
import { Lexer } from './lexer.js';

/**
 * One node of a parsed type 4 program: a numeric or boolean literal, an
 * operator name, or a nested procedure.
 */
export type PsOp = number | boolean | string | PsOp[];
export type PsProgram = PsOp[];

/** Nesting bound for `{}` at parse time and for procedure calls at run time. */
const MAX_DEPTH = 100;
/**
 * Operand-stack bound. 32000-1 7.10.5 caps a conforming program's stack at 100
 * entries; this is deliberately looser, because rejecting a working file to
 * enforce a limit nobody checks would trade a real page for a rule. It exists
 * only so a runaway `copy` cannot exhaust memory.
 */
const MAX_STACK = 1000;

/** Thrown internally by a faulting operator; never escapes {@link evalPostScript}. */
class PsFault extends Error {}
function fault(): never { throw new PsFault('type 4 fault'); }

// ---------- parsing ----------

/**
 * Parse a type 4 program.
 *
 * Tokenized by `lexer.ts`, which already fits this grammar exactly: `{` and `}`
 * are delimiters no PDF production claims, so they come back as one-character
 * keywords. That makes this the fourth non-object grammar over that tokenizer,
 * beside content streams, CMaps and `/DA` — and it follows the same rule they
 * do: an unrecognised token is not a syntax error at this layer. Only
 * `object-parser.ts` may reject, because only it has a grammar in which a stray
 * keyword cannot appear.
 *
 * Returns `undefined` for bytes that are not a program we can read, which the
 * caller turns into its constant fallback.
 */
export function parsePostScriptFunction(src: Uint8Array): PsProgram | undefined {
  const lex = new Lexer(src);
  const start = lex.pos;
  const first = lex.next();
  if (first.t === 'kw' && first.v === '{') return parseBody(lex, 1, true);
  // No outer brace. Producers sometimes omit it, and a bare body is
  // unambiguous, so re-scan from the top rather than refusing the file.
  lex.pos = start;
  return parseBody(lex, 0, false);
}

/** `braced` distinguishes a procedure, which must end at `}`, from the whole
 *  program when the outer brace was absent, which ends at eof. */
function parseBody(lex: Lexer, depth: number, braced: boolean): PsProgram | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const out: PsProgram = [];
  for (;;) {
    const t = lex.next();
    if (t.t === 'eof') return braced ? undefined : out;      // unterminated procedure
    if (t.t === 'num') { out.push(t.v); continue; }
    if (t.t === 'kw') {
      if (t.v === '{') {
        const sub = parseBody(lex, depth + 1, true);
        if (sub === undefined) return undefined;
        out.push(sub);
        continue;
      }
      if (t.v === '}') return braced ? out : undefined;      // stray close
      if (t.v === 'true') { out.push(true); continue; }
      if (t.v === 'false') { out.push(false); continue; }
      out.push(t.v);
      continue;
    }
    // Names, strings and dict/array delimiters have no meaning in this grammar.
  }
}

// ---------- evaluation ----------

/** A stack entry: a number, a boolean, or a procedure awaiting `if`/`ifelse`. */
type Val = number | boolean | PsProgram;

/**
 * Run `prog` with `input` already on the stack, returning the topmost `nOut`
 * values — the last output on top, anything below them discarded.
 *
 * Returns `undefined` on any fault, which the caller turns into its constant
 * fallback. Nothing here throws: a broken tint transform must not take down a
 * page render.
 */
export function evalPostScript(prog: PsProgram, input: number[], nOut: number): number[] | undefined {
  const st: Val[] = input.slice();
  try {
    exec(prog, st, 0);
  } catch {
    return undefined;
  }
  if (st.length < nOut) return undefined;
  const out = st.slice(st.length - nOut);
  const res: number[] = [];
  for (const v of out) {
    // A leftover procedure or boolean in an output slot is a malformed program,
    // and a non-finite value would clamp to a Range endpoint that looks
    // deliberate. Both are faults.
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    res.push(v);
  }
  return res;
}

function exec(prog: PsProgram, st: Val[], depth: number): void {
  if (depth > MAX_DEPTH) fault();
  for (const op of prog) {
    if (typeof op === 'string') { applyOp(op, st, depth); continue; }
    if (st.length >= MAX_STACK) fault();
    st.push(op);                                    // number, boolean, procedure
  }
}

const popVal = (st: Val[]): Val => { if (st.length === 0) fault(); return st.pop()!; };
function popNum(st: Val[]): number {
  const v = popVal(st);
  if (typeof v !== 'number') fault();
  return v;
}
function popBool(st: Val[]): boolean {
  const v = popVal(st);
  if (typeof v !== 'boolean') fault();
  return v;
}
function popProc(st: Val[]): PsProgram {
  const v = popVal(st);
  if (!Array.isArray(v)) fault();
  return v;
}
function push(st: Val[], v: Val): void {
  if (st.length >= MAX_STACK) fault();
  st.push(v);
}

/**
 * `and`, `or`, `xor` and `not` are overloaded on operand type — boolean logic
 * on booleans, bitwise on integers. Implementing only one reading silently
 * mis-evaluates every program that uses the other.
 */
function logical(st: Val[], op: 'and' | 'or' | 'xor'): void {
  const b = popVal(st), a = popVal(st);
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    push(st, op === 'and' ? a && b : op === 'or' ? a || b : a !== b);
    return;
  }
  if (typeof a !== 'number' || typeof b !== 'number') fault();
  const x = Math.trunc(a), y = Math.trunc(b);
  push(st, op === 'and' ? x & y : op === 'or' ? x | y : x ^ y);
}

function applyOp(op: string, st: Val[], depth: number): void {
  switch (op) {
    // --- arithmetic ---
    case 'abs': push(st, Math.abs(popNum(st))); break;
    case 'add': { const b = popNum(st), a = popNum(st); push(st, a + b); break; }
    case 'sub': { const b = popNum(st), a = popNum(st); push(st, a - b); break; }
    case 'mul': { const b = popNum(st), a = popNum(st); push(st, a * b); break; }
    case 'div': { const b = popNum(st), a = popNum(st); push(st, a / b); break; }
    case 'idiv': {
      // Integer division. `1 2 idiv` is 0, where `div` would be 0.5. Operands
      // are truncated rather than rejected: a producer that pushes a real here
      // is out of spec, but refusing the file helps nobody.
      const b = Math.trunc(popNum(st)), a = Math.trunc(popNum(st));
      if (b === 0) fault();
      push(st, Math.trunc(a / b));
      break;
    }
    case 'mod': {
      const b = Math.trunc(popNum(st)), a = Math.trunc(popNum(st));
      if (b === 0) fault();
      push(st, a % b);
      break;
    }
    case 'neg': push(st, -popNum(st)); break;
    case 'ceiling': push(st, Math.ceil(popNum(st))); break;
    case 'floor': push(st, Math.floor(popNum(st))); break;
    case 'round': push(st, Math.round(popNum(st))); break;      // ties toward +inf
    case 'truncate': push(st, Math.trunc(popNum(st))); break;
    case 'cvi': push(st, Math.trunc(popNum(st))); break;        // toward zero
    case 'cvr': push(st, popNum(st)); break;
    case 'sqrt': push(st, Math.sqrt(popNum(st))); break;
    case 'exp': { const e = popNum(st), b = popNum(st); push(st, Math.pow(b, e)); break; }
    case 'ln': push(st, Math.log(popNum(st))); break;
    case 'log': push(st, Math.log10(popNum(st))); break;
    // Degrees, not radians. `atan` takes `num den` and returns 0..360.
    case 'sin': push(st, Math.sin((popNum(st) * Math.PI) / 180)); break;
    case 'cos': push(st, Math.cos((popNum(st) * Math.PI) / 180)); break;
    case 'atan': {
      const den = popNum(st), num = popNum(st);
      let a = (Math.atan2(num, den) * 180) / Math.PI;
      if (a < 0) a += 360;
      push(st, a);
      break;
    }

    // --- relational, boolean, bitwise ---
    case 'eq': { const b = popVal(st), a = popVal(st); push(st, a === b); break; }
    case 'ne': { const b = popVal(st), a = popVal(st); push(st, a !== b); break; }
    case 'gt': { const b = popNum(st), a = popNum(st); push(st, a > b); break; }
    case 'ge': { const b = popNum(st), a = popNum(st); push(st, a >= b); break; }
    case 'lt': { const b = popNum(st), a = popNum(st); push(st, a < b); break; }
    case 'le': { const b = popNum(st), a = popNum(st); push(st, a <= b); break; }
    case 'and': logical(st, 'and'); break;
    case 'or': logical(st, 'or'); break;
    case 'xor': logical(st, 'xor'); break;
    case 'not': {
      const v = popVal(st);
      if (typeof v === 'boolean') push(st, !v);
      else if (typeof v === 'number') push(st, ~Math.trunc(v));
      else fault();
      break;
    }
    case 'bitshift': {
      const shift = Math.trunc(popNum(st)), v = Math.trunc(popNum(st));
      push(st, shift >= 0 ? v << shift : v >> -shift);
      break;
    }
    case 'true': push(st, true); break;
    case 'false': push(st, false); break;

    // --- conditional ---
    case 'if': {
      const proc = popProc(st);
      if (popBool(st)) exec(proc, st, depth + 1);
      break;
    }
    case 'ifelse': {
      const alt = popProc(st), main = popProc(st);
      exec(popBool(st) ? main : alt, st, depth + 1);
      break;
    }

    // --- stack ---
    case 'pop': popVal(st); break;
    case 'exch': { const b = popVal(st), a = popVal(st); push(st, b); push(st, a); break; }
    case 'dup': { const v = popVal(st); push(st, v); push(st, v); break; }
    case 'copy': {
      const n = Math.trunc(popNum(st));
      if (n < 0 || n > st.length || st.length + n > MAX_STACK) fault();
      for (const v of st.slice(st.length - n)) st.push(v);
      break;
    }
    case 'index': {
      const n = Math.trunc(popNum(st));
      if (n < 0 || n >= st.length) fault();
      push(st, st[st.length - 1 - n]);
      break;
    }
    case 'roll': {
      const j = Math.trunc(popNum(st));
      const n = Math.trunc(popNum(st));
      if (n < 0 || n > st.length) fault();
      if (n === 0) break;
      const part = st.splice(st.length - n, n);
      const k = ((j % n) + n) % n;                  // j may exceed n or be negative
      st.push(...part.slice(n - k), ...part.slice(0, n - k));
      break;
    }

    // An operator we do not know. Skipping matches every other non-object
    // grammar over this tokenizer: damage costs the bytes it touches.
    default: break;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/psfunc.test.ts && npm run typecheck`
Expected: PASS, 26 tests (5 arithmetic, 3 boolean/bitwise, 4 stack,
3 conditional, 3 input/output, 8 malformed).

- [ ] **Step 5: Prove the subtle cases load-bearing**

These three are the whole reason the module exists rather than a naive stack
machine. Break each, confirm red, revert:

| Mutation | Must fail |
|---|---|
| `sin`/`cos` take radians (drop `* Math.PI / 180`) | the degrees case |
| `idiv` uses `a / b` without `Math.trunc` | the integer case |
| `not` always boolean (`push(st, !v)`) | the bitwise case |
| `evalPostScript` returns `st.slice(0, nOut)` | the output-order case |
| `roll` uses `j` without the modulo normalisation | the roll case |

- [ ] **Step 6: Commit**

```bash
git add src/psfunc.ts test/psfunc.test.ts
git commit -m "$(cat <<'EOF'
feat(function): Type 4 PostScript calculator interpreter (imxw.3)

All 42 operators of 32000-1 7.10.5, over the existing lexer.ts — { and } are
delimiters no PDF production claims, so they already arrive as one-character
keywords. This is the fourth non-object grammar over that tokenizer and follows
the same rule: an unrecognised token is skipped, not rejected.

Three semantics that return plausible wrong numbers rather than failing, and so
are asserted directly: integers are a distinct type (1 2 idiv is 0, not 0.5),
and/or/xor/not are overloaded on operand type, and trig is in degrees with atan
returning 0..360.

Pure: no PDF objects, so it is testable without building a file.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Dispatch, `/Range` clamping and the memo

**Files:**
- Modify: `src/pdffunction.ts` — the trailing fallback block (currently lines 106–113)
- Test: `test/pdffunction.test.ts` (extend)

**Interfaces:**
- Consumes: `parsePostScriptFunction`, `evalPostScript` from Task 1.
- Produces: no new exports. `parseFunction`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/pdffunction.test.ts`, and add to its imports at the top:
`import { PdfStream } from '../src/types.js';`

```ts
/** A type 4 function stream carrying `src` as its program. */
function psFn(src: string, range: number[], domain: number[] = [0, 1]): PdfStream {
  return {
    kind: 'stream',
    dict: dict({ FunctionType: 4, Domain: domain, Range: range }),
    raw: new TextEncoder().encode(src),
  };
}

describe('parseFunction — type 4', () => {
  it('evaluates a PostScript calculator function instead of a flat midpoint', () => {
    // R = t, G = 0, B = 1 - t. The midpoint fallback would return
    // [0.5, 0.5, 0.5] for every input, so a varying result is the assertion.
    const f = parseFunction(psFn('{ dup 0 exch 1 exch sub }', [0, 1, 0, 1, 0, 1]), id, inflate);
    expect(f([0]).map((n) => +n.toFixed(3))).toEqual([0, 0, 1]);
    expect(f([1]).map((n) => +n.toFixed(3))).toEqual([1, 0, 0]);
    expect(f([0.25]).map((n) => +n.toFixed(3))).toEqual([0.25, 0, 0.75]);
  });

  it('clamps each output to its own /Range pair', () => {
    const f = parseFunction(psFn('{ pop 5 -5 }', [0, 1, 0, 2]), id, inflate);
    expect(f([0])).toEqual([1, 0]);
  });

  it('takes the output count from /Range', () => {
    const f = parseFunction(psFn('{ pop 1 2 3 }', [0, 9, 0, 9]), id, inflate);
    expect(f([0])).toEqual([2, 3]);        // topmost 2, last on top
  });

  it('clamps the input to /Domain before running the program', () => {
    const f = parseFunction(psFn('{ }', [0, 10], [2, 5]), id, inflate);
    expect(f([9])).toEqual([5]);
    expect(f([-3])).toEqual([2]);
  });

  it('falls back to the Range midpoint when the program will not parse', () => {
    const f = parseFunction(psFn('{ 1 2 add', [0, 1, 0, 4]), id, inflate);
    expect(f([0])).toEqual([0.5, 2]);
  });

  it('falls back to the Range midpoint when the program faults at run time', () => {
    const f = parseFunction(psFn('{ pop add }', [0, 1]), id, inflate);
    expect(f([0])).toEqual([0.5]);
  });

  it('keeps the midpoint fallback for genuinely unsupported function types', () => {
    const f = parseFunction(dict({ FunctionType: 7, Domain: [0, 1], Range: [0, 1] }), id, inflate);
    expect(f([0])).toEqual([0.5]);
  });

  it('returns equal results from the cache on a repeated input', () => {
    const f = parseFunction(psFn('{ dup mul }', [0, 100]), id, inflate);
    expect(f([3])).toEqual([9]);
    expect(f([3])).toEqual([9]);
    expect(f([4])).toEqual([16]);
    expect(f([3])).toEqual([9]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/pdffunction.test.ts`
Expected: FAIL — every type 4 case returns the midpoint.

- [ ] **Step 3: Wire it up**

In `src/pdffunction.ts`, add to the imports:

```ts
import { evalPostScript, parsePostScriptFunction, type PsProgram } from './psfunc.js';
```

Replace the trailing fallback block:

```ts
  // type 4 (PostScript) and anything unsupported: constant midpoint of Range/[0,1].
  const range = nums(dict.get('Range'), resolve);
  const outN = range.length / 2 || 1;
  const constOut: number[] = [];
  for (let o = 0; o < outN; o++) constOut.push(((range[2 * o] ?? 0) + (range[2 * o + 1] ?? 1)) / 2);
  return () => constOut;
}
```

with:

```ts
  const range = nums(dict.get('Range'), resolve);
  const outN = range.length / 2 || 1;
  const midpoint: number[] = [];
  for (let o = 0; o < outN; o++) midpoint.push(((range[2 * o] ?? 0) + (range[2 * o + 1] ?? 1)) / 2);

  if (type === 4 && isStream(r) && range.length >= 2) {
    const nOut = range.length / 2;
    // Typed explicitly: a bare `let prog;` is implicitly `any` under `strict`.
    // The try guards `inflate`, which throws on a corrupt stream;
    // parsePostScriptFunction itself reports failure by returning undefined.
    let prog: PsProgram | undefined;
    try { prog = parsePostScriptFunction(inflate(r)); } catch { prog = undefined; }
    if (prog) {
      // A tint transform runs per pixel for an image in a Separation or DeviceN
      // space, so an interpreted program would be re-run millions of times. The
      // function is pure, so memoizing on the input tuple is unobservable; a
      // 1-input Separation over 8-bit samples has only 256 distinct inputs.
      const cache = new Map<string, number[]>();
      return (input) => {
        const clamped = clampDomain(input);
        const key = clamped.join(',');
        const hit = cache.get(key);
        if (hit) return hit;
        const raw = evalPostScript(prog, clamped, nOut);
        const out = raw
          ? raw.map((v, i) => clamp(v, range[2 * i], range[2 * i + 1]))
          : midpoint;
        if (cache.size >= 4096) cache.clear();
        cache.set(key, out);
        return out;
      };
    }
  }

  // Anything left — an unsupported function type, or a type 4 program we could
  // not read — is a constant midpoint of /Range. This is the only remaining
  // caller of that fallback; before type 4 was implemented it also answered for
  // every PostScript function in every file.
  return () => midpoint;
}
```

Note the `type === 4` branch sits **after** the `type === 0` block, so it must be
placed where the old fallback was, not earlier in the chain.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/pdffunction.test.ts test/psfunc.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pdffunction.ts test/pdffunction.test.ts
git commit -m "$(cat <<'EOF'
feat(function): dispatch FunctionType 4 and narrow the midpoint fallback (imxw.3)

pdffunction.ts returned a constant midpoint of /Range for every type 4
function, so every PostScript-driven shading and every Separation/DeviceN tint
transform painted one flat wrong colour with no error raised anywhere. The
midpoint now answers only for genuinely unsupported types and for programs we
cannot read.

Outputs are the topmost n values on the stack, n coming from /Range, each
clamped to its own pair. Results are memoized on the input tuple: a tint
transform runs per pixel for an image, and the function is pure, so the cache
is unobservable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Acceptance — a varying gradient and a real tint transform

**Files:**
- Modify: `test/helpers/build-svg-fixtures.ts` (add two builders)
- Modify: `test/raster-shading.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `parseFunction`'s type 4 support from Task 2.
- Produces:
```ts
export function type4ShadingPdf(): Uint8Array;
export function type4SeparationPdf(): Uint8Array;
```

- [ ] **Step 1: Add the fixtures**

Append to `test/helpers/build-svg-fixtures.ts`. Note `buildSvgPdf`'s `extra`
already accepts a stream as `{ dict, raw }`, which a type 4 function must be.

```ts
/** An axial shading whose colour comes from a type 4 PostScript function:
 *  R = t, G = 0, B = 1 - t. Deliberately the same visual ramp as
 *  `axialShadingPdf`, so a flat mid-grey result means the program did not run. */
export function type4ShadingPdf(): Uint8Array {
  const prog = '{ dup 0 exch 1 exch sub }';
  const res = '<< /Shading << /Sh0 5 0 R >> >>';
  const shading = '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] '
    + '/Function 6 0 R /Extend [true true] >>';
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q 0 0 200 200 re W n /Sh0 sh Q',
    extra: {
      5: shading,
      6: {
        dict: `<< /FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
        raw: enc(prog),
      },
    },
  });
}

/** A rect filled through a /Separation whose tint transform is a type 4
 *  program: R = 1 - t, G = 1, B = 1 - t, so tint 1 is pure green. */
export function type4SeparationPdf(): Uint8Array {
  const prog = '{ 1 exch sub dup 1 exch }';
  const res = '<< /ColorSpace << /CS0 5 0 R >> >>';
  const cs = '[/Separation /Spot /DeviceRGB 6 0 R]';
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: res,
    content: 'q /CS0 cs 1 scn 20 20 160 160 re f Q',
    extra: {
      5: cs,
      6: {
        dict: `<< /FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1] /Length ${prog.length} >>`,
        raw: enc(prog),
      },
    },
  });
}
```

`enc` is already defined at the top of that file
(`const enc = (s: string) => new TextEncoder().encode(s)`, line 3) and is in
scope for the append — no import needed.

- [ ] **Step 2: Write the failing acceptance test**

Append to `test/raster-shading.test.ts`, adding `type4ShadingPdf` and
`type4SeparationPdf` to the existing import from `./helpers/build-svg-fixtures.js`:

```ts
describe('Page.ToImage — type 4 PostScript functions', () => {
  it('ramps blue → red across an axial shading driven by a PostScript program', () => {
    const p = decodePng(Document.Open(type4ShadingPdf()).Pages[0].ToImage());
    // The bug this covers paints a flat colour, so the assertion is that the
    // two ends DIFFER and land where the program says — not merely that the
    // page is painted.
    const [lr, lg, lb] = p.at(6, 100);           // t ~ 0 → blue
    expect(lr).toBeLessThan(40);
    expect(lg).toBeLessThan(40);
    expect(lb).toBeGreaterThan(220);
    const [rr, rg, rb] = p.at(194, 100);         // t ~ 1 → red
    expect(rr).toBeGreaterThan(220);
    expect(rg).toBeLessThan(40);
    expect(rb).toBeLessThan(40);
    const [cr, cg, cb] = p.at(100, 100);         // t ~ 0.5 → purple
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('resolves a Separation tint transform to its alternate-space colour', () => {
    const p = decodePng(Document.Open(type4SeparationPdf()).Pages[0].ToImage());
    const [r, g, b] = p.at(100, 100);            // tint 1 → (0,1,0)
    expect(r).toBeLessThan(40);
    expect(g).toBeGreaterThan(220);
    expect(b).toBeLessThan(40);
    const [wr, wg, wb] = p.at(5, 5);             // outside the rect → white page
    expect(wr).toBeGreaterThan(230);
    expect(wg).toBeGreaterThan(230);
    expect(wb).toBeGreaterThan(230);
  });
});
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test/raster-shading.test.ts`
Expected: PASS — Task 2 already made the functions evaluate.

If either fails, do not adjust the thresholds. A flat mid-grey result
(`128,128,128` everywhere) means the type 4 branch is not being reached; check
that the `type === 4` block sits where the old fallback was and that
`isStream(r)` holds for a stream-valued `/Function`.

- [ ] **Step 4: Prove the acceptance tests load-bearing**

Revert `src/pdffunction.ts`'s type 4 branch to the old midpoint (stash it, or
temporarily change the branch condition to `type === -1`), run
`npx vitest run test/raster-shading.test.ts`, and confirm **both** new cases
fail. Restore. Without this the tests could be passing on a white page or on
`Extend` behaviour rather than on the function.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green. Type 4 previously returned a midpoint everywhere, so any
existing test that silently depended on that constant will surface here.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/build-svg-fixtures.ts test/raster-shading.test.ts
git commit -m "$(cat <<'EOF'
test(render): type 4 shading and Separation tint acceptance (imxw.3)

The issue's two acceptance criteria, asserted on rendered pixels: a shading
driven by a PostScript program produces a varying gradient, and a Separation
colorant with a PostScript tint transform resolves to the right alternate-space
colour.

Both assert that the ends DIFFER and land where the program says. The bug being
fixed paints a flat midpoint, which a "the page is painted" assertion would
have accepted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Documentation and close-out

**Files:**
- Modify: `CLAUDE.md` (the `svgrender.ts`/`raster.ts` rendering bullet, which already names `pdffunction.ts`)
- Modify: `README.md` (the `Rendering (page → PNG)` paragraph, line 58)

- [ ] **Step 1: Record the invariants in CLAUDE.md**

Add `psfunc.ts` beside `pdffunction.ts` in the rendering bullet's backing-module
list, and add these invariants:

```markdown
  **Invariant:** a type 4 (PostScript calculator) function is interpreted by
  `psfunc.ts`, which touches no PDF objects — bytes in, numbers out. That is
  what lets all 42 operators be tested against hand-written programs without
  building a file, and `pdffunction.ts` keeps `/Domain`, `/Range` and the type
  dispatch as it does for types 0, 2 and 3.
  **Invariant:** type 4 is the fourth non-object grammar over `lexer.ts`, with
  content streams, `cmap.ts` and `da.ts` — `{` and `}` are delimiters no PDF
  production claims, so they already arrive as one-character keywords. It is
  bound by the same rule as the other three: an unrecognised token is skipped,
  not rejected. Only `object-parser.ts` may treat a stray keyword as an error.
  **Invariant:** three type 4 semantics return plausible wrong numbers rather
  than failing, so each is asserted directly rather than trusted. Integers are a
  distinct type — `1 2 idiv` is 0 where `div` is 0.5; `and`/`or`/`xor`/`not` are
  overloaded on operand type, boolean on booleans and bitwise on integers; and
  trigonometry is in **degrees**, with `atan` returning 0..360 rather than a
  signed radian. Each of the three produces a smooth, entirely plausible,
  entirely wrong ramp.
  **Invariant:** the constant `/Range` midpoint in `pdffunction.ts` now answers
  only for genuinely unsupported function types and for a type 4 program that
  will not parse. It used to answer for *every* type 4 function, which is how a
  PostScript-driven shading came to paint one flat colour with no error raised
  anywhere.
  **Invariant:** the type 4 memo lives in the evaluator, not in `colorspace.ts`.
  A tint transform runs per pixel for an image in a Separation or DeviceN space,
  so an interpreted program would be re-run millions of times; the function is
  pure, so the cache is unobservable. Caching one level up would change
  behaviour for function types this work does not touch.
```

- [ ] **Step 2: Update README.md**

In the `Rendering (page → PNG)` paragraph at line 58, the shading sentence
currently reads:

> are sampled per device pixel through the PDF-function evaluator and colorspace resolver (with `/Extend` and a 257-entry color LUT)

Extend the parenthetical to name the supported function types:

> are sampled per device pixel through the PDF-function evaluator and colorspace resolver (sampled, exponential, stitching and PostScript-calculator functions — types 0, 2, 3 and 4; with `/Extend` and a 257-entry color LUT)

- [ ] **Step 3: Run both gates**

```bash
npm run typecheck
npm test
```
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs(function): Type 4 invariants and README coverage (imxw.3)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-imxw.3
bd show aspose-pdf-foss-for-ts-imxw     # epic should read 3/4
git add .beads/
git commit -m "chore(beads): sync interactions log for imxw.3

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status                              # MUST show up to date with origin
```

---

## Verification checklist

- [ ] `npm run typecheck` clean
- [ ] `npm test` green, full suite
- [ ] All five Task 1 Step 5 mutations confirmed failing, and reverted
- [ ] Task 3 Step 4 confirmed: both acceptance cases fail with the midpoint restored
- [ ] `git status` shows the branch up to date with origin
- [ ] `aspose-pdf-foss-for-ts-imxw.3` closed; epic `imxw` at 3/4
