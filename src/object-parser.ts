import { Lexer, Token } from './lexer.js';
import { PdfParseError } from './errors.js';
import { PdfObject, PdfDict, ref } from './types.js';

export type LengthResolver = (numOrValue: PdfObject) => number | undefined;

export class ObjectParser {
  constructor(private readonly lx: Lexer, private readonly resolveLength?: LengthResolver) {}

  /** Parse a single object starting at the lexer's current position. */
  parseObject(): PdfObject {
    return this.parseValue(this.lx.next());
  }

  /** Parse an indirect object: `n g obj <value> endobj`. Returns the value. */
  parseIndirectObject(): { num: number; gen: number; value: PdfObject } {
    const a = this.expectNum();
    const b = this.expectNum();
    const kw = this.lx.next();
    if (kw.t !== 'kw' || kw.v !== 'obj') throw new PdfParseError('expected obj', kw.pos);
    const value = this.parseValue(this.lx.next());
    return { num: a, gen: b, value };
  }

  private expect(t: Token['t']): Token {
    const tok = this.lx.next();
    if (tok.t !== t) throw new PdfParseError(`expected ${t} got ${tok.t}`, tok.pos);
    return tok;
  }

  private expectNum(): number {
    const tok = this.lx.next();
    if (tok.t !== 'num') throw new PdfParseError(`expected num got ${tok.t}`, tok.pos);
    return tok.v;
  }

  private parseValue(tok: Token): PdfObject {
    switch (tok.t) {
      case 'num': return this.maybeRef(tok.v as number);
      case 'name': return { kind: 'name', name: tok.v as string };
      case 'str': return { kind: 'string', bytes: tok.v as Uint8Array };
      case 'kw':
        if (tok.v === 'true') return true;
        if (tok.v === 'false') return false;
        if (tok.v === 'null') return null;
        throw new PdfParseError(`unexpected keyword ${tok.v}`, tok.pos);
      case 'delim':
        if (tok.v === '[') return this.parseArray();
        if (tok.v === '<<') return this.parseDictOrStream();
        throw new PdfParseError(`unexpected ${tok.v}`, tok.pos);
      default: throw new PdfParseError(`unexpected token ${tok.t}`, tok.pos);
    }
  }

  // After reading a number, peek for `g R` (reference). Otherwise it's just a number.
  private maybeRef(first: number): PdfObject {
    const save = this.lx.pos;
    const t2 = this.lx.next();
    if (t2.t === 'num') {
      const t3 = this.lx.next();
      if (t3.t === 'kw' && t3.v === 'R') return ref(first, t2.v as number);
    }
    this.lx.pos = save; // rewind: it was a plain number
    return first;
  }

  private parseArray(): PdfObject[] {
    const arr: PdfObject[] = [];
    for (;;) {
      const tok = this.lx.next();
      if (tok.t === 'delim' && tok.v === ']') return arr;
      if (tok.t === 'eof') throw new PdfParseError('unterminated array', tok.pos);
      arr.push(this.parseValue(tok));
    }
  }

  private parseDictOrStream(): PdfObject {
    const dict: PdfDict = new Map();
    for (;;) {
      const k = this.lx.next();
      if (k.t === 'delim' && k.v === '>>') break;
      if (k.t !== 'name') throw new PdfParseError('expected dict key', k.pos);
      dict.set(k.v as string, this.parseValue(this.lx.next()));
    }
    // Is a stream following?
    const save = this.lx.pos;
    const maybe = this.lx.next();
    if (maybe.t === 'kw' && maybe.v === 'stream') {
      return this.readStream(dict);
    }
    this.lx.pos = save;
    return dict;
  }

  private readStream(dict: PdfDict): PdfObject {
    // After the `stream` keyword: skip a single CRLF or LF.
    const buf = this.lx.buf;
    let p = this.lx.pos;
    if (buf[p] === 13) p++;
    if (buf[p] === 10) p++;
    const start = p;
    let end: number;
    const lenObj = dict.get('Length');
    const len = typeof lenObj === 'number' ? lenObj : this.resolveLength?.(lenObj!);
    if (typeof len === 'number' && len >= 0 && this.looksLikeEndstream(buf, start + len)) {
      end = start + len;
    } else {
      end = this.scanEndstream(buf, start);
    }
    const raw = buf.subarray(start, end);
    // advance lexer past endstream
    this.lx.pos = this.skipToAfterEndstream(buf, end);
    return { kind: 'stream', dict, raw };
  }

  private looksLikeEndstream(buf: Uint8Array, at: number): boolean {
    let p = at;
    while (p < buf.length && (buf[p] === 13 || buf[p] === 10 || buf[p] === 32)) p++;
    return this.matches(buf, p, 'endstream');
  }
  private scanEndstream(buf: Uint8Array, start: number): number {
    for (let p = start; p < buf.length - 8; p++) {
      if (this.matches(buf, p, 'endstream')) {
        let e = p;
        if (buf[e - 1] === 10) e--;
        if (buf[e - 1] === 13) e--;
        return e;
      }
    }
    throw new PdfParseError('endstream not found', start);
  }
  private skipToAfterEndstream(buf: Uint8Array, end: number): number {
    let p = end;
    while (p < buf.length && !this.matches(buf, p, 'endstream')) p++;
    return p + 'endstream'.length;
  }
  private matches(buf: Uint8Array, p: number, s: string): boolean {
    for (let i = 0; i < s.length; i++) if (buf[p + i] !== s.charCodeAt(i)) return false;
    return true;
  }
}
