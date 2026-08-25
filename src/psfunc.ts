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
 * Parse a type 4 (PostScript calculator) program.
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
export function evalPostScript(
  prog: PsProgram, input: number[], nOut: number,
): number[] | undefined {
  const st: Val[] = input.slice();
  try {
    exec(prog, st, 0);
  } catch {
    return undefined;
  }
  if (st.length < nOut) return undefined;
  const res: number[] = [];
  for (const v of st.slice(st.length - nOut)) {
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
    push(st, op);                                   // number, boolean, procedure
  }
}

function popVal(st: Val[]): Val {
  if (st.length === 0) fault();
  return st.pop()!;
}
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
 * `and`, `or` and `xor` are overloaded on operand type — boolean logic on
 * booleans, bitwise on integers. Implementing only one reading silently
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
