// src/afcall.ts
/**
 * Recognising one call to a standard Acrobat AForm function (jzn8).
 *
 * The library never executes document JavaScript (6t2v.2). What it can do is
 * recognise the SHAPE Acrobat writes for its own built-in functions — exactly
 * one call, literal arguments — and hand the name and arguments to a native
 * implementation. Anything else is `undefined`: a second statement, an
 * identifier or expression as an argument, an escape this scanner does not
 * decode, or a name outside the table. Nothing is partially understood.
 *
 * A pure leaf importing nothing.
 */

type ArgSpec = 'n' | 's' | 'b' | 'b?' | 'fields';

/** Each function's arguments, in order. 'b?' is an optional trailing boolean;
 *  'fields' is AFSimple_Calculate's list, an array or a comma-separated string. */
export const AF_SIGNATURES = {
  AFNumber_Format: ['n', 'n', 'n', 'n', 's', 'b'],
  AFNumber_Keystroke: ['n', 'n', 'n', 'n', 's', 'b'],
  AFPercent_Format: ['n', 'n', 'b?'],
  AFPercent_Keystroke: ['n', 'n'],
  AFDate_Format: ['n'],
  AFDate_FormatEx: ['s'],
  AFDate_Keystroke: ['n'],
  AFDate_KeystrokeEx: ['s'],
  AFTime_Format: ['n'],
  AFTime_FormatEx: ['s'],
  AFTime_Keystroke: ['n'],
  AFTime_KeystrokeEx: ['s'],
  AFSpecial_Format: ['n'],
  AFSpecial_Keystroke: ['n'],
  AFSpecial_KeystrokeEx: ['s'],
  AFRange_Validate: ['b', 'n', 'b', 'n'],
  AFSimple_Calculate: ['s', 'fields'],
} as const satisfies Record<string, readonly ArgSpec[]>;

export type AfName = keyof typeof AF_SIGNATURES;
export type AfArg = number | string | boolean | readonly string[];
export interface AfCall { readonly name: AfName; readonly args: readonly AfArg[] }

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', n: '\n', r: '\r', t: '\t' };
const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', ' ', '﻿']);

class Scanner {
  pos = 0;
  bad = false;
  constructor(private readonly s: string) {}

  /** Skip whitespace and comments. An unterminated block comment marks the scan bad. */
  ws(): void {
    for (;;) {
      const c = this.s[this.pos];
      if (c !== undefined && SPACE.has(c)) { this.pos++; continue; }
      if (c === '/' && this.s[this.pos + 1] === '/') {
        const nl = this.s.indexOf('\n', this.pos);
        this.pos = nl < 0 ? this.s.length : nl + 1;
        continue;
      }
      if (c === '/' && this.s[this.pos + 1] === '*') {
        const end = this.s.indexOf('*/', this.pos + 2);
        if (end < 0) { this.bad = true; this.pos = this.s.length; return; }
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  eat(ch: string): boolean {
    if (this.s[this.pos] !== ch) return false;
    this.pos++;
    return true;
  }

  sticky(re: RegExp): string | undefined {
    re.lastIndex = this.pos;
    const m = re.exec(this.s);
    if (m === null) return undefined;
    this.pos = re.lastIndex;
    return m[0];
  }

  atEnd(): boolean { return this.pos >= this.s.length; }

  string(): string | undefined {
    const q = this.s[this.pos];
    if (q !== '"' && q !== "'") return undefined;
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.s[this.pos++];
      if (c === undefined || c === '\n' || c === '\r') return undefined;
      if (c === q) return out;
      if (c === '\\') {
        const e = this.s[this.pos++];
        if (e === undefined || !Object.hasOwn(ESCAPES, e)) return undefined;
        out += ESCAPES[e];
        continue;
      }
      out += c;
    }
  }

  /** A comma-separated list of strings; the opener has been consumed. */
  strings(close: string): string[] | undefined {
    const out: string[] = [];
    this.ws();
    if (this.eat(close)) return out;
    for (;;) {
      this.ws();
      const v = this.string();
      if (v === undefined) return undefined;
      out.push(v);
      this.ws();
      if (this.eat(close)) return out;
      if (!this.eat(',')) return undefined;
    }
  }

  arg(): AfArg | undefined {
    const c = this.s[this.pos];
    if (c === '"' || c === "'") return this.string();
    if (c === '[') { this.pos++; return this.strings(']'); }
    const num = this.sticky(NUMBER);
    if (num !== undefined) {
      // `1x` needs no check here: the caller demands `,` or `)` next.
      const v = Number(num);
      return Number.isFinite(v) ? v : undefined;
    }
    const id = this.sticky(IDENT);
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'new') {
      this.ws();
      if (this.sticky(IDENT) !== 'Array') return undefined;
      this.ws();
      if (!this.eat('(')) return undefined;
      return this.strings(')');
    }
    return undefined;
  }
}

/** One recognised AForm call, or undefined. Never throws. */
export function parseAfCall(script: string): AfCall | undefined {
  if (typeof script !== 'string') return undefined;
  const sc = new Scanner(script);
  sc.ws();
  const name = sc.sticky(IDENT);
  if (name === undefined || !Object.hasOwn(AF_SIGNATURES, name)) return undefined;
  sc.ws();
  if (!sc.eat('(')) return undefined;
  const args: AfArg[] = [];
  sc.ws();
  if (!sc.eat(')')) {
    for (;;) {
      sc.ws();
      const a = sc.arg();
      if (a === undefined) return undefined;
      args.push(a);
      sc.ws();
      if (sc.eat(')')) break;
      if (!sc.eat(',')) return undefined;
    }
  }
  sc.ws();
  sc.eat(';');
  sc.ws();
  if (sc.bad || !sc.atEnd()) return undefined;
  const call: AfCall = { name: name as AfName, args };
  return fits(call) ? call : undefined;
}

function fits({ name, args }: AfCall): boolean {
  const spec: readonly ArgSpec[] = AF_SIGNATURES[name];
  const required = spec.filter((t) => t !== 'b?').length;
  if (args.length < required || args.length > spec.length) return false;
  return args.every((a, i) => {
    switch (spec[i]) {
      case 'n': return typeof a === 'number';
      case 's': return typeof a === 'string';
      case 'b': case 'b?': return typeof a === 'boolean';
      case 'fields': return typeof a === 'string' || Array.isArray(a);
      default: return false;
    }
  });
}
