/** The CSS tokenizer (CSS Syntax Level 3 §4), as a literal transcription.
 *
 *  Invariant: a PURE LEAF. No Document, no PDF object, no `node:` import, and
 *  no htmldom.js — a string goes in and tokens come out. Collecting `<style>`
 *  element text is a walk over HtmlElement and so zch2.2.3's, deliberately
 *  not here.
 *
 *  Invariant: NEVER throws. Syntax 3 defines a recovery for everything,
 *  including the two failure modes it gives their own kinds — `bad-string`,
 *  which ends at the newline that broke it, and `bad-url`, which consumes to
 *  the closing paren. This is htmltoken.ts's and markdown.ts's rule and the
 *  opposite of parseXml, which throws PdfParseError.
 *
 *  Invariant, and it is a DECISION rather than an oversight: this implements
 *  the spec era the VENDORED CORPUS is pinned to, not the current editor's
 *  draft. It emits `unicode-range`, the five match tokens (`~=` `|=` `^=`
 *  `$=` `*=`) and the column token (`||`), all of which the live draft has
 *  removed from the tokenizer. Eleven of the 149 vendored cases turn on it.
 *  See test/fixtures/css-parsing/PROVENANCE.md; do not "fix" this toward the
 *  current draft.
 *
 *  Invariant: consuming a token always advances the cursor or reaches EOF —
 *  the rule lexer.ts records for PDF. A token returned at an unchanged
 *  position is an infinite loop rather than a wrong parse. */

export type CssToken =
  | { kind: 'ident' | 'at-keyword' | 'string' | 'url'; value: string }
  | { kind: 'hash'; value: string; id: boolean }
  | { kind: 'delim' | 'match'; value: string }
  | { kind: 'number' | 'percentage'; repr: string; value: number; int: boolean }
  | { kind: 'dimension'; repr: string; value: number; int: boolean; unit: string }
  | { kind: 'unicode-range'; start: number; end: number }
  | { kind: 'function'; name: string }
  | { kind: 'error'; code: 'bad-string' | 'bad-url' | 'eof-in-string' | 'eof-in-url' }
  | { kind: 'whitespace' | 'colon' | 'semicolon' | 'comma' | 'cdo' | 'cdc' | 'column' }
  | { kind: 'open'; open: '{' | '[' | '(' }
  | { kind: 'close'; close: '}' | ']' | ')' };

const REPLACEMENT = String.fromCharCode(0xfffd);

function isWs(c: string): boolean {
  return c === '\n' || c === '\t' || c === ' ';
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

/** §4.2: a name-start is a letter, a non-ASCII code point, or `_`.
 *
 *  The non-ASCII half is a CODE-POINT compare rather than a character literal.
 *  A literal works and reads worse: a raw U+0080 in source is invisible in a
 *  terminal and JSON.stringify does not escape it, so "is that bound still
 *  there" cannot be answered by looking. The bound is >= 0x80 rather than
 *  > 0x80, which is what "non-ASCII" means and includes U+0080 itself. */
function isNameStart(c: string): boolean {
  if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') return true;
  const cp = c.codePointAt(0);
  return cp !== undefined && cp >= 0x80;
}

function isName(c: string): boolean {
  return isNameStart(c) || isDigit(c) || c === '-';
}

/** §4.2's non-printable set, which only a url token consults: U+0000–U+0008,
 *  U+000B, U+000E–U+001F and U+007F. Tab, LF and FF are NOT in it, and
 *  preprocessing has already turned FF and CR into LF and NUL into U+FFFD.
 *
 *  U+007F is the one that gets forgotten, and it is invisible in every tool
 *  that shows you the corpus: JSON.stringify escapes control points below
 *  U+0020 and leaves DEL raw, so `url(<DEL>)` reads on screen as `url()` —
 *  a valid empty url rather than the bad-url the corpus expects. */
function isNonPrintable(c: string): boolean {
  const cp = c.codePointAt(0);
  if (cp === undefined) return false;
  return cp <= 0x08 || cp === 0x0b || (cp >= 0x0e && cp <= 0x1f) || cp === 0x7f;
}

class Tokenizer {
  private readonly s: string;
  private i = 0;
  /** A second token the current state wants emitted after its own.
   *
   *  Hitting EOF inside a string or a url emits the SALVAGED VALUE and THEN
   *  the error, rather than replacing the value with it: `'eof` is
   *  `["string","eof"]` followed by `eof-in-string`, and a bare `url(` is
   *  `["url",""]` followed by `eof-in-url`. A slot is a much smaller change
   *  than making every state return a list for the sake of two of them. */
  private pending: CssToken | undefined;

  constructor(src: string) {
    // §3.3 preprocessing: CRLF and a lone CR become LF, FF becomes LF, and a
    // NUL becomes U+FFFD. Running it up front is what lets every state below
    // ignore all four.
    this.s = src
      .replace(/\r\n?/g, '\n')
      .replace(/\f/g, '\n')
      .replace(/\0/g, REPLACEMENT);
  }

  private peek(n = 0): string {
    return this.s[this.i + n] ?? '';
  }

  private eof(): boolean {
    return this.i >= this.s.length;
  }

  run(): CssToken[] {
    const out: CssToken[] = [];
    for (;;) {
      this.skipComments();
      if (this.eof()) return out;
      const before = this.i;
      const t = this.next();
      if (t !== undefined) out.push(t);
      if (this.pending !== undefined) { out.push(this.pending); this.pending = undefined; }
      // The advance invariant: a state that consumed nothing would spin.
      if (this.i === before) this.i++;
    }
  }

  /** Comments are removed rather than tokenized, and removing them must not
   *  join the tokens either side: `a/**\/b` is two idents. */
  private skipComments(): void {
    for (;;) {
      if (this.peek() !== '/' || this.peek(1) !== '*') return;
      const end = this.s.indexOf('*/', this.i + 2);
      this.i = end < 0 ? this.s.length : end + 2;
    }
  }

  private next(): CssToken | undefined {
    const c = this.peek();
    if (isWs(c)) {
      while (isWs(this.peek())) this.i++;
      return { kind: 'whitespace' };
    }
    if (c === '"' || c === "'") return this.consumeString(c);
    if (c === '#') return this.consumeHash();
    if (c === '(') { this.i++; return { kind: 'open', open: '(' }; }
    if (c === ')') { this.i++; return { kind: 'close', close: ')' }; }
    if (c === '[') { this.i++; return { kind: 'open', open: '[' }; }
    if (c === ']') { this.i++; return { kind: 'close', close: ']' }; }
    if (c === '{') { this.i++; return { kind: 'open', open: '{' }; }
    if (c === '}') { this.i++; return { kind: 'close', close: '}' }; }
    if (c === ',') { this.i++; return { kind: 'comma' }; }
    if (c === ':') { this.i++; return { kind: 'colon' }; }
    if (c === ';') { this.i++; return { kind: 'semicolon' }; }

    // The five match tokens and the column token. Present at the corpus's
    // spec era and absent from the current draft — see the module comment.
    if (this.peek(1) === '=' && (c === '~' || c === '|' || c === '^' || c === '$' || c === '*')) {
      this.i += 2;
      return { kind: 'match', value: `${c}=` };
    }
    if (c === '|' && this.peek(1) === '|') { this.i += 2; return { kind: 'column' }; }

    if (c === '<' && this.s.startsWith('<!--', this.i)) { this.i += 4; return { kind: 'cdo' }; }
    if (c === '-' && this.s.startsWith('-->', this.i)) { this.i += 3; return { kind: 'cdc' }; }

    if (c === '@') {
      if (this.startsIdent(1)) {
        this.i++;
        return { kind: 'at-keyword', value: this.consumeName() };
      }
      this.i++;
      return { kind: 'delim', value: '@' };
    }

    if (c === '\\') {
      if (this.validEscape(0)) return this.consumeIdentLike();
      this.i++;
      return { kind: 'delim', value: '\\' };
    }

    if ((c === 'u' || c === 'U') && this.startsUnicodeRange()) return this.consumeUnicodeRange();
    if (isDigit(c) || ((c === '+' || c === '-' || c === '.') && this.startsNumber(0))) {
      return this.consumeNumeric();
    }
    if (this.startsIdent(0)) return this.consumeIdentLike();

    this.i++;
    return { kind: 'delim', value: c };
  }

  // ---- §4.3.8 check if two code points are a valid escape ----------------

  /** Note what is NOT required: a following code point. The rule is "a
   *  backslash whose next code point is not a newline", and EOF is not a
   *  newline — so a TRAILING backslash is a valid escape and yields U+FFFD
   *  inside the name being consumed, rather than ending the name and leaving
   *  a delim behind. Requiring a next character reddens four corpus cases. */
  private validEscape(at: number): boolean {
    return this.peek(at) === '\\' && this.peek(at + 1) !== '\n';
  }

  /** §4.3.9: would the code points starting at `at` begin an identifier? */
  private startsIdent(at: number): boolean {
    const c = this.peek(at);
    if (c === '-') {
      const d = this.peek(at + 1);
      return isNameStart(d) || d === '-' || this.validEscape(at + 1);
    }
    if (isNameStart(c)) return true;
    return this.validEscape(at);
  }

  /** §4.3.10: would the code points starting at `at` begin a number? */
  private startsNumber(at: number): boolean {
    const c = this.peek(at);
    if (c === '+' || c === '-') {
      if (isDigit(this.peek(at + 1))) return true;
      return this.peek(at + 1) === '.' && isDigit(this.peek(at + 2));
    }
    if (c === '.') return isDigit(this.peek(at + 1));
    return isDigit(c);
  }

  // ---- §4.3.7 consume an escaped code point ------------------------------

  private consumeEscape(): string {
    this.i++; // the backslash
    if (this.eof()) return REPLACEMENT;
    const c = this.peek();
    if (!isHex(c)) { this.i++; return c; }
    let hex = '';
    while (hex.length < 6 && isHex(this.peek())) { hex += this.peek(); this.i++; }
    if (isWs(this.peek())) this.i++;
    const cp = parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return REPLACEMENT;
    return String.fromCodePoint(cp);
  }

  private consumeName(): string {
    let out = '';
    for (;;) {
      const c = this.peek();
      if (isName(c)) { out += c; this.i++; continue; }
      if (this.validEscape(0)) { out += this.consumeEscape(); continue; }
      return out;
    }
  }

  // ---- §4.3.4 consume a string -------------------------------------------

  /** A bad string ends at the NEWLINE that broke it, leaving the newline for
   *  the next token; running to EOF instead is `eof-in-string`. Collapsing
   *  either into a good string changes what the rest of the stylesheet parses
   *  as, which is why Syntax 3 gives them their own kinds. */
  private consumeString(quote: string): CssToken {
    this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) {
        this.pending = { kind: 'error', code: 'eof-in-string' };
        return { kind: 'string', value: out };
      }
      const c = this.peek();
      if (c === quote) { this.i++; return { kind: 'string', value: out }; }
      if (c === '\n') return { kind: 'error', code: 'bad-string' };
      if (c === '\\') {
        if (this.i + 1 >= this.s.length) { this.i++; continue; }
        if (this.peek(1) === '\n') { this.i += 2; continue; }
        out += this.consumeEscape();
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private consumeHash(): CssToken {
    this.i++;
    if (isName(this.peek()) || this.validEscape(0)) {
      const id = this.startsIdent(0);
      return { kind: 'hash', value: this.consumeName(), id };
    }
    return { kind: 'delim', value: '#' };
  }

  // ---- §4.3.3 consume a numeric token ------------------------------------

  private consumeNumeric(): CssToken {
    const { repr, value, int } = this.consumeNumber();
    if (this.startsIdent(0)) {
      return { kind: 'dimension', repr, value, int, unit: this.consumeName() };
    }
    if (this.peek() === '%') { this.i++; return { kind: 'percentage', repr, value, int }; }
    return { kind: 'number', repr, value, int };
  }

  /** The REPRESENTATION is kept beside the value, and the type flag beside
   *  both: `1` and `1.0` have equal values and differ only in the flag, while
   *  `+1` and `1` differ only in the representation. */
  private consumeNumber(): { repr: string; value: number; int: boolean } {
    const start = this.i;
    let int = true;
    if (this.peek() === '+' || this.peek() === '-') this.i++;
    while (isDigit(this.peek())) this.i++;
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      int = false;
      this.i += 2;
      while (isDigit(this.peek())) this.i++;
    }
    const e = this.peek();
    if (e === 'e' || e === 'E') {
      const signed = this.peek(1) === '+' || this.peek(1) === '-';
      if (isDigit(this.peek(1)) || (signed && isDigit(this.peek(2)))) {
        int = false;
        this.i += signed ? 2 : 1;
        while (isDigit(this.peek())) this.i++;
      }
    }
    const repr = this.s.slice(start, this.i);
    const n = Number(repr);
    // NEGATIVE ZERO is normalised away. `Number('-0')` is -0, and the sign of
    // a zero is not something CSS carries — the representation string already
    // records that a minus was written. It matters because it is INVISIBLE:
    // JSON.stringify renders -0 and 0 identically as "0", so a diff of
    // serialized output shows nothing, while a deep-equality assertion uses
    // Object.is and fails. Four corpus cases turn on it, and they are the
    // only four whose failure a JSON diff could not explain.
    return { repr, value: n === 0 ? 0 : n, int };
  }

  // ---- §4.3.2 consume an ident-like token --------------------------------

  /** `url(` is a url-token whose value runs to the closing paren with no
   *  quoting; `url (` is an ident then a function token, and a QUOTED
   *  `url("a")` is a function too. A tokenizer that treats `url` as a name
   *  everywhere produces a plausible token stream that is wrong for every
   *  unquoted URL. */
  private consumeIdentLike(): CssToken {
    const name = this.consumeName();
    if (this.peek() === '(') {
      if (name.toLowerCase() === 'url') {
        let at = 1;
        while (isWs(this.peek(at))) at++;
        const q = this.peek(at);
        if (q !== '"' && q !== "'") { this.i++; return this.consumeUrl(); }
      }
      this.i++;
      return { kind: 'function', name };
    }
    return { kind: 'ident', value: name };
  }

  // ---- §4.3.6 consume a url token ----------------------------------------

  /** A bad url consumes to the CLOSING PAREN, unlike a bad string which stops
   *  at a newline. Running to EOF instead is `eof-in-url`. */
  private consumeUrl(): CssToken {
    while (isWs(this.peek())) this.i++;
    let out = '';
    for (;;) {
      if (this.eof()) {
        this.pending = { kind: 'error', code: 'eof-in-url' };
        return { kind: 'url', value: out };
      }
      const c = this.peek();
      if (c === ')') { this.i++; return { kind: 'url', value: out }; }
      if (isWs(c)) {
        while (isWs(this.peek())) this.i++;
        if (this.eof()) {
          this.pending = { kind: 'error', code: 'eof-in-url' };
          return { kind: 'url', value: out };
        }
        if (this.peek() === ')') { this.i++; return { kind: 'url', value: out }; }
        return this.badUrl();
      }
      if (c === '"' || c === "'" || c === '(' || isNonPrintable(c)) return this.badUrl();
      if (c === '\\') {
        if (this.validEscape(0)) { out += this.consumeEscape(); continue; }
        return this.badUrl();
      }
      out += c;
      this.i++;
    }
  }

  private badUrl(): CssToken {
    for (;;) {
      if (this.eof()) return { kind: 'error', code: 'bad-url' };
      const c = this.peek();
      this.i++;
      if (c === ')') return { kind: 'error', code: 'bad-url' };
      if (c === '\\' && !this.eof()) this.i++;
    }
  }

  // ---- unicode-range, at the corpus's spec era ---------------------------

  /** `U+` followed by a hex digit or a `?`. The current editor's draft parses
   *  this at the value level instead; see the module comment. */
  private startsUnicodeRange(): boolean {
    if (this.peek(1) !== '+') return false;
    const c = this.peek(2);
    return isHex(c) || c === '?';
  }

  private consumeUnicodeRange(): CssToken {
    this.i += 2;
    let digits = '';
    while (digits.length < 6 && isHex(this.peek())) { digits += this.peek(); this.i++; }
    let marks = '';
    while (digits.length + marks.length < 6 && this.peek() === '?') { marks += '?'; this.i++; }
    if (marks !== '') {
      const start = parseInt(digits + '0'.repeat(marks.length), 16);
      const end = parseInt(digits + 'F'.repeat(marks.length), 16);
      return { kind: 'unicode-range', start, end };
    }
    const start = parseInt(digits, 16);
    if (this.peek() === '-' && isHex(this.peek(1))) {
      this.i++;
      let tail = '';
      while (tail.length < 6 && isHex(this.peek())) { tail += this.peek(); this.i++; }
      return { kind: 'unicode-range', start, end: parseInt(tail, 16) };
    }
    return { kind: 'unicode-range', start, end: start };
  }
}

export function tokenize(css: string): CssToken[] {
  return new Tokenizer(css).run();
}
