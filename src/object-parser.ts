import { Lexer, Token } from './lexer.js';
import { PdfParseError } from './errors.js';
import { PdfObject, PdfDict, ref } from './types.js';
import { LoadLimits } from './loadlimits.js';

export type LengthResolver = (numOrValue: PdfObject) => number | undefined;

/** The delimiters no object production claims; `lexer.ts` returns each as a
 *  one-character keyword rather than throwing. */
const STRAY = new Set([')', '{', '}', '>']);

/** The COS object grammar.
 *
 *  **Invariant (`ibzo.2`):** it bounds what it builds — nesting depth, items per
 *  container, and one object's encoded bytes — and a bound reached is a
 *  `ResourceLimitError`, never a `PdfParseError`. The difference is what stops
 *  `Document.Open`'s build loop, which catches a parse failure per object and
 *  retries through the recovery ladder, from sweeping a hostile file.
 *
 *  **Invariant:** depth is counted HERE rather than left to the call stack. A
 *  stack overflow is a `RangeError`, which the build loop caught and reported
 *  as `object-parse-failure` — so a 10,000-deep array read as a broken file. */
export class ObjectParser {
  private depth = 0;

  /**
   * @param lenient skip a STRAY DELIMITER KEYWORD (`)`, `{`, `}`, `>`) where a
   *   dictionary KEY or an array ELEMENT is expected, rather than throwing.
   *
   *   **Invariant (lj8t): it is a LAST RESORT and OFF by default.** Strict
   *   rejection is what lets `sweepObjects` decide an offset holds no object,
   *   so only `Document.Open` asks for it, and only for an object that would
   *   otherwise refuse a structurally sound file. The two positions are the
   *   ones a stray token can be dropped from without changing what anything
   *   ELSE means; in a dictionary VALUE position it would pair every later key
   *   with the wrong value, so it still throws there. Acrobat PDFWriter 3.02
   *   wrote `/Title (pages))` -- an unescaped `)` closing the string early --
   *   into OPM SF 50's /Info, and that is the shape this exists for.
   */
  constructor(
    private readonly lx: Lexer,
    private readonly resolveLength?: LengthResolver,
    private readonly limits: LoadLimits = LoadLimits.defaults,
    private readonly lenient = false,
  ) {
    // The one site that turns the lexer's cap on. Object parsing owns this lexer
    // for as long as it runs, and no token can be larger than the object holding
    // it, so the object bound is also a sound token bound.
    if (limits.maxObjectBytes !== null) lx.maxTokenBytes = limits.maxObjectBytes;
  }

  /** The next token, refusing one the lexer stopped reading. */
  private take(): Token {
    const tok = this.lx.next();
    if (tok.over !== undefined)
      this.limits.enforce('maxObjectBytes', tok.over, `token at byte ${tok.pos}`);
    return tok;
  }

  /** Parse a single object starting at the lexer's current position. */
  parseObject(): PdfObject {
    return this.parseValue(this.take());
  }

  /** Parse an indirect object: `n g obj <value> endobj`. Returns the value. */
  parseIndirectObject(): { num: number; gen: number; value: PdfObject } {
    const start = this.lx.pos;
    const a = this.expectNum();
    const b = this.expectNum();
    const kw = this.take();
    if (kw.t !== 'kw' || kw.v !== 'obj') throw new PdfParseError('expected obj', kw.pos);
    const value = this.parseValue(this.take());
    this.limits.enforce('maxObjectBytes', this.lx.pos - start, `object ${a} ${b}`);
    return { num: a, gen: b, value };
  }

  private expect(t: Token['t']): Token {
    const tok = this.take();
    if (tok.t !== t) throw new PdfParseError(`expected ${t} got ${tok.t}`, tok.pos);
    return tok;
  }

  private expectNum(): number {
    const tok = this.take();
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
    const t2 = this.take();
    if (t2.t === 'num') {
      const t3 = this.take();
      if (t3.t === 'kw' && t3.v === 'R') return ref(first, t2.v as number);
    }
    this.lx.pos = save; // rewind: it was a plain number
    return first;
  }

  /** A delimiter no production claims, which the lexer hands back as a
   *  one-character keyword -- and which the LENIENT mode may skip. */
  private isStray(tok: Token): boolean {
    return this.lenient && tok.t === 'kw' && STRAY.has(tok.v as string);
  }

  /** Run `body` one container level deeper. */
  private nested<T>(at: number, body: () => T): T {
    this.limits.enforce('maxNestingDepth', ++this.depth, `container at byte ${at}`);
    try { return body(); } finally { this.depth--; }
  }

  private parseArray(): PdfObject[] {
    const at = this.lx.pos;
    return this.nested(at, () => {
      const arr: PdfObject[] = [];
      for (;;) {
        const tok = this.take();
        if (tok.t === 'delim' && tok.v === ']') return arr;
        if (tok.t === 'eof') throw new PdfParseError('unterminated array', tok.pos);
        if (this.isStray(tok)) continue;
        this.limits.enforce('maxContainerItems', arr.length + 1, `array at byte ${at}`);
        arr.push(this.parseValue(tok));
      }
    });
  }

  private parseDictOrStream(): PdfObject {
    const at = this.lx.pos;
    const dict: PdfDict = this.nested(at, () => {
      const d: PdfDict = new Map();
      for (;;) {
        const k = this.take();
        if (k.t === 'delim' && k.v === '>>') return d;
        if (this.isStray(k)) continue;
        if (k.t !== 'name') throw new PdfParseError('expected dict key', k.pos);
        // By ENTRY, which is what a dictionary holds; counting tokens would
        // halve the bound for every dictionary and for no array.
        this.limits.enforce('maxContainerItems', d.size + 1, `dictionary at byte ${at}`);
        d.set(k.v as string, this.parseValue(this.take()));
      }
    });
    // Is a stream following?
    const save = this.lx.pos;
    const maybe = this.take();
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
    this.limits.enforce('maxObjectBytes', end - start, `stream at byte ${start}`);
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
