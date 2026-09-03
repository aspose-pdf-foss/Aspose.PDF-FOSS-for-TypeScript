/** The CSS component-value parser (CSS Syntax Level 3 §5).
 *
 *  Invariant: a PURE LEAF over csstoken.js. No Document, no PDF object, no
 *  `node:` import, no htmldom.js, and it NEVER re-reads a character — the
 *  tokenizer's output is the only input. Collecting `<style>` element text is
 *  a walk over HtmlElement and so zch2.2.3's.
 *
 *  Invariant: NEVER throws. Every failure is a value: `bad-string` and
 *  `bad-url` arrive as error tokens, an unmatched close bracket becomes an
 *  error component value, and each entry point reports `empty`, `invalid` or
 *  `extra-input` rather than refusing.
 *
 *  Invariant this module owes the test serializer: NO `open` or `close` token
 *  ever reaches parser output. A matched pair becomes a block or a function;
 *  an unmatched close becomes an error value. The serializer has no case for
 *  either, so a leak shows up as a failed comparison naming the case rather
 *  than as silently plausible output. */

import { tokenize } from './csstoken.js';
import type { CssToken } from './csstoken.js';

export type CssValue =
  | CssToken
  | { kind: 'block'; open: '{' | '[' | '('; contents: CssValue[] }
  | { kind: 'function'; name: string; args: CssValue[] }
  | CssError;

export interface CssDeclaration {
  kind: 'declaration';
  name: string;
  value: CssValue[];
  important: boolean;
}

export interface CssAtRule {
  kind: 'at-rule';
  name: string;
  prelude: CssValue[];
  block: CssValue[] | null;
}

export interface CssQualifiedRule {
  kind: 'qualified-rule';
  prelude: CssValue[];
  block: CssValue[];
}

export interface CssError {
  kind: 'error';
  code: string;
}

const CLOSER: Record<string, '}' | ']' | ')'> = { '{': '}', '[': ']', '(': ')' };

function err(code: string): CssError {
  return { kind: 'error', code };
}

function isWs(t: CssToken | undefined): boolean {
  return t !== undefined && t.kind === 'whitespace';
}

/** A cursor over the token list. Every consumer advances it or reaches the
 *  end, the rule csstoken.ts records for characters. */
class Cursor {
  private readonly t: CssToken[];
  private i = 0;

  constructor(tokens: CssToken[]) {
    this.t = tokens;
  }

  peek(): CssToken | undefined {
    return this.t[this.i];
  }

  next(): CssToken | undefined {
    return this.t[this.i++];
  }

  done(): boolean {
    return this.i >= this.t.length;
  }

  skipWs(): void {
    while (isWs(this.peek())) this.i++;
  }
}

// ---- §5.4.7 consume a component value -------------------------------------

/** Nesting is built HERE. The tokenizer emits flat `function`, `open` and
 *  `close` tokens and knows nothing of blocks, which is what lets it stay a
 *  pure string -> token[] function with no recursion. */
function consumeComponentValue(c: Cursor): CssValue {
  const t = c.next() as CssToken;
  if (t.kind === 'open') return consumeBlock(c, t.open);
  if (t.kind === 'function') return consumeFunction(c, t.name);
  if (t.kind === 'close') return err(t.close);
  return t;
}

function consumeBlock(c: Cursor, open: '{' | '[' | '('): CssValue {
  const want = CLOSER[open] as '}' | ']' | ')';
  const contents: CssValue[] = [];
  for (;;) {
    const t = c.peek();
    if (t === undefined) return { kind: 'block', open, contents };
    if (t.kind === 'close' && t.close === want) { c.next(); return { kind: 'block', open, contents }; }
    contents.push(consumeComponentValue(c));
  }
}

function consumeFunction(c: Cursor, name: string): CssValue {
  const args: CssValue[] = [];
  for (;;) {
    const t = c.peek();
    if (t === undefined) return { kind: 'function', name, args };
    if (t.kind === 'close' && t.close === ')') { c.next(); return { kind: 'function', name, args }; }
    args.push(consumeComponentValue(c));
  }
}

// ---- §5.4.5 consume a declaration -----------------------------------------

/** Takes the values of one run. `!important` is matched from the END,
 *  case-insensitively, and the bang may be separated from the word. */
function declarationFrom(values: CssValue[]): CssDeclaration | CssError {
  let i = 0;
  while (i < values.length && (values[i] as CssToken).kind === 'whitespace') i++;
  const head = values[i];
  if (head === undefined || head.kind !== 'ident') return err('invalid');
  const name = head.value;
  i++;
  while (i < values.length && (values[i] as CssToken).kind === 'whitespace') i++;
  const colon = values[i];
  if (colon === undefined || colon.kind !== 'colon') return err('invalid');
  i++;

  // Trailing whitespace is KEPT: `foo: ` has the value `[" "]`, not `[]`, and
  // `foo: 9000 !important` keeps the space that preceded the bang. The value
  // is a list of component values rather than text, so nothing normalises it.
  const rest = values.slice(i);

  // The `!important` scan skips trailing whitespace to find the ident, then
  // skips more to find the bang, and truncates AT the bang — keeping the
  // whitespace that preceded it, which the corpus expects in the value.
  let important = false;
  let end = rest.length - 1;
  while (end >= 0 && (rest[end] as CssToken).kind === 'whitespace') end--;
  const last = rest[end];
  if (last !== undefined && last.kind === 'ident' && last.value.toLowerCase() === 'important') {
    let j = end - 1;
    while (j >= 0 && (rest[j] as CssToken).kind === 'whitespace') j--;
    const bang = rest[j];
    if (bang !== undefined && bang.kind === 'delim' && bang.value === '!') {
      important = true;
      rest.length = j;
    }
  }

  return { kind: 'declaration', name, value: rest, important };
}

/** Collect component values up to the next top-level `;`, which is consumed. */
function consumeUntilSemicolon(c: Cursor): CssValue[] {
  const out: CssValue[] = [];
  for (;;) {
    const t = c.peek();
    if (t === undefined) return out;
    if (t.kind === 'semicolon') { c.next(); return out; }
    out.push(consumeComponentValue(c));
  }
}

// ---- §5.4.2 / §5.4.3 consume a rule ---------------------------------------

function consumeAtRule(c: Cursor, name: string): CssAtRule {
  const prelude: CssValue[] = [];
  for (;;) {
    const t = c.peek();
    if (t === undefined) return { kind: 'at-rule', name, prelude, block: null };
    if (t.kind === 'semicolon') { c.next(); return { kind: 'at-rule', name, prelude, block: null }; }
    if (t.kind === 'open' && t.open === '{') {
      c.next();
      const b = consumeBlock(c, '{') as { contents: CssValue[] };
      return { kind: 'at-rule', name, prelude, block: b.contents };
    }
    prelude.push(consumeComponentValue(c));
  }
}

function consumeQualifiedRule(c: Cursor): CssQualifiedRule | CssError {
  const prelude: CssValue[] = [];
  for (;;) {
    const t = c.peek();
    if (t === undefined) return err('invalid');
    if (t.kind === 'open' && t.open === '{') {
      c.next();
      const b = consumeBlock(c, '{') as { contents: CssValue[] };
      return { kind: 'qualified-rule', prelude, block: b.contents };
    }
    prelude.push(consumeComponentValue(c));
  }
}

type Rule = CssAtRule | CssQualifiedRule | CssError;

/** §5.4.1. `topLevel` drops CDO and CDC, which is true for a stylesheet and
 *  false everywhere else — the one behavioural difference between
 *  parseStylesheet and parseRuleList. */
function consumeRuleList(c: Cursor, topLevel: boolean): Rule[] {
  const out: Rule[] = [];
  for (;;) {
    const t = c.peek();
    if (t === undefined) return out;
    if (t.kind === 'whitespace') { c.next(); continue; }
    if (t.kind === 'cdo' || t.kind === 'cdc') {
      if (topLevel) { c.next(); continue; }
      out.push(consumeQualifiedRule(c));
      continue;
    }
    if (t.kind === 'at-keyword') { c.next(); out.push(consumeAtRule(c, t.value)); continue; }
    out.push(consumeQualifiedRule(c));
  }
}

// ---- entry points ---------------------------------------------------------

export function parseComponentValueList(css: string): CssValue[] {
  const c = new Cursor(tokenize(css));
  const out: CssValue[] = [];
  while (!c.done()) out.push(consumeComponentValue(c));
  return out;
}

/** The four single-item entry points share this wrapper: skip leading
 *  whitespace, report `empty` at the end, delegate, then require nothing but
 *  whitespace after or report `extra-input`. */
function single<T>(css: string, take: (c: Cursor) => T | CssError): T | CssError {
  const c = new Cursor(tokenize(css));
  c.skipWs();
  if (c.done()) return err('empty');
  const v = take(c);
  if ((v as CssError).kind === 'error') return v as CssError;
  c.skipWs();
  return c.done() ? v : err('extra-input');
}

export function parseOneComponentValue(css: string): CssValue | CssError {
  return single(css, (c) => consumeComponentValue(c));
}

export function parseOneDeclaration(css: string): CssDeclaration | CssError {
  const c = new Cursor(tokenize(css));
  c.skipWs();
  if (c.done()) return err('empty');
  const values: CssValue[] = [];
  while (!c.done()) values.push(consumeComponentValue(c));
  return declarationFrom(values);
}

export function parseOneRule(css: string): CssAtRule | CssQualifiedRule | CssError {
  return single(css, (c) => {
    const t = c.peek() as CssToken;
    if (t.kind === 'at-keyword') { c.next(); return consumeAtRule(c, t.value); }
    return consumeQualifiedRule(c);
  });
}

export function parseRuleList(css: string): Rule[] {
  return consumeRuleList(new Cursor(tokenize(css)), false);
}

export function parseStylesheet(css: string): Rule[] {
  return consumeRuleList(new Cursor(tokenize(css)), true);
}

/** §5.4.4. Declarations and at-rules, `;`-separated; a run that is not a
 *  valid declaration is an `invalid` error rather than a dropped run. */
export function parseDeclarationList(css: string): (CssDeclaration | CssAtRule | CssError)[] {
  const c = new Cursor(tokenize(css));
  const out: (CssDeclaration | CssAtRule | CssError)[] = [];
  for (;;) {
    c.skipWs();
    const t = c.peek();
    if (t === undefined) return out;
    if (t.kind === 'semicolon') { c.next(); continue; }
    if (t.kind === 'at-keyword') { c.next(); out.push(consumeAtRule(c, t.value)); continue; }
    const values = consumeUntilSemicolon(c);
    if (values.length === 0) continue;
    out.push(declarationFrom(values));
  }
}

/** The modern "consume a block's contents": declarations, at-rules AND
 *  qualified rules interleaved.
 *
 *  It is NOT parseDeclarationList with a different name, which is what it
 *  looks like until a nested rule appears. A run starting with an ident may
 *  be either — `a:hover { … }` opens exactly like a declaration — so the
 *  algorithm MARKS the position, tries a declaration, and rewinds to consume
 *  a qualified rule when that fails. Five vendored cases turn on it.
 *
 *  A declaration attempt fails when the run has no `ident :` head, or when
 *  its value ends in a `{}` block: that last rule is the whole nested-rule
 *  disambiguation, and without it `a:hover { c: 1 }` parses as a declaration
 *  named `a` whose value is `hover` and a block. */
export function parseBlocksContents(
  css: string,
): (CssDeclaration | CssAtRule | CssQualifiedRule | CssError)[] {
  const c = new Cursor(tokenize(css));
  const out: (CssDeclaration | CssAtRule | CssQualifiedRule | CssError)[] = [];
  for (;;) {
    c.skipWs();
    const t = c.peek();
    if (t === undefined) return out;
    if (t.kind === 'semicolon') { c.next(); continue; }
    if (t.kind === 'at-keyword') { c.next(); out.push(consumeAtRule(c, t.value)); continue; }

    const { values, sawBlock } = consumeBlockRun(c);
    if (values.length === 0) continue;
    if (sawBlock) { out.push(ruleFromValues(values)); continue; }
    out.push(declarationFrom(values));
  }
}

/** Collect one run: up to the next top-level `;`, to EOF, or — and this is
 *  the part a `;`-only collector gets wrong — up to and INCLUDING the first
 *  top-level `{}` block, because a qualified rule ENDS at its block and
 *  parsing resumes immediately after the `}`. In `a b{c:d}e:f` the `e:f` is a
 *  second construct, not part of the rule. */
function consumeBlockRun(c: Cursor): { values: CssValue[]; sawBlock: boolean } {
  const values: CssValue[] = [];
  for (;;) {
    const t = c.peek();
    if (t === undefined) return { values, sawBlock: false };
    if (t.kind === 'semicolon') { c.next(); return { values, sawBlock: false }; }
    const v = consumeComponentValue(c);
    values.push(v);
    if (v.kind === 'block' && (v as { open: string }).open === '{') {
      return { values, sawBlock: true };
    }
  }
}

/** The decision is made from the RUN we already delimited, never by rewinding
 *  the cursor. Rewinding would re-consume past the `;` that ended the run —
 *  `z;a:b` would swallow the `a:b` into a failed qualified rule and lose it,
 *  where the corpus keeps both the error and the declaration. */
function ruleFromValues(values: CssValue[]): CssQualifiedRule | CssError {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i] as CssValue;
    if (v.kind === 'block' && (v as { open: string }).open === '{') {
      return {
        kind: 'qualified-rule',
        prelude: values.slice(0, i),
        block: (v as { contents: CssValue[] }).contents,
      };
    }
  }
  return err('invalid');
}


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

    // Read `kind` off the VALUE rather than the CssToken view: a block is a
    // component value and not a token, so the narrowed view has no case for it.
    if ((x as { kind: string }).kind === 'block' && (x as { open: string }).open === '{') {
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
