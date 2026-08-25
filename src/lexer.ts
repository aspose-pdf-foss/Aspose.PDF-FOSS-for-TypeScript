export type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'str'; v: Uint8Array; pos: number }
  | { t: 'delim'; v: '[' | ']' | '<<' | '>>'; pos: number }
  | { t: 'kw'; v: string; pos: number }
  | { t: 'eof'; pos: number };

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ()<>[]{}/%
const isWs = (b: number) => WS.has(b);
const isDelim = (b: number) => DELIM.has(b);
const isReg = (b: number) => !isWs(b) && !isDelim(b);

export class Lexer {
  pos = 0;
  constructor(readonly buf: Uint8Array, start = 0) { this.pos = start; }

  private skipWsAndComments() {
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos];
      if (isWs(b)) { this.pos++; continue; }
      if (b === 37) { // % comment to EOL
        while (this.pos < this.buf.length && this.buf[this.pos] !== 10 && this.buf[this.pos] !== 13) this.pos++;
        continue;
      }
      break;
    }
  }

  next(): Token {
    this.skipWsAndComments();
    const pos = this.pos;
    if (this.pos >= this.buf.length) return { t: 'eof', pos };
    const b = this.buf[this.pos];

    if (b === 91) { this.pos++; return { t: 'delim', v: '[', pos }; }
    if (b === 93) { this.pos++; return { t: 'delim', v: ']', pos }; }
    if (b === 60) {
      if (this.buf[this.pos + 1] === 60) { this.pos += 2; return { t: 'delim', v: '<<', pos }; }
      return { t: 'str', v: this.readHexString(), pos };
    }
    if (b === 62 && this.buf[this.pos + 1] === 62) { this.pos += 2; return { t: 'delim', v: '>>', pos }; }
    if (b === 40) return { t: 'str', v: this.readLiteralString(), pos };
    if (b === 47) return { t: 'name', v: this.readName(), pos };
    if (b === 43 || b === 45 || b === 46 || (b >= 48 && b <= 57)) {
      const r = this.readRegular();
      const n = Number(r);
      if (!Number.isNaN(n) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(r)) return { t: 'num', v: n, pos };
      return { t: 'kw', v: r, pos };
    }
    const kw = this.readRegular();
    // `)`, `{`, `}` and an unmatched `>` reach here: they are delimiters, so
    // readRegular stops on them without consuming anything. Take the byte as a
    // one-character keyword rather than returning an empty one at an unchanged
    // position — next() must always advance or report eof, since every caller
    // loops until eof and a standing-still token is an infinite loop.
    // parseContentStream appends an op per turn, so a single such byte in a
    // corrupt (or still-encrypted) content stream exhausted the heap and killed
    // the process.
    //
    // Deciding that a byte is a *syntax error* belongs to the caller, which is
    // the only layer that knows the grammar. ObjectParser rejects a stray
    // keyword in every position it can appear, so object parsing throws exactly
    // as before; the three grammars over the same tokenizer that already ignore
    // keywords they do not recognise — content streams, CMaps and /DA strings —
    // lose the bytes they cannot read instead of the page, the font decoder or
    // the appearance.
    if (kw.length === 0) { this.pos++; return { t: 'kw', v: String.fromCharCode(b), pos }; }
    return { t: 'kw', v: kw, pos };
  }

  private readRegular(): string {
    const start = this.pos;
    while (this.pos < this.buf.length && isReg(this.buf[this.pos])) this.pos++;
    return new TextDecoder('latin1').decode(this.buf.subarray(start, this.pos));
  }

  private readName(): string {
    this.pos++; // skip '/'
    const out: number[] = [];
    while (this.pos < this.buf.length && isReg(this.buf[this.pos])) {
      let b = this.buf[this.pos++];
      if (b === 35 && this.pos + 1 < this.buf.length) { // # hex escape
        b = parseInt(new TextDecoder('latin1').decode(this.buf.subarray(this.pos, this.pos + 2)), 16);
        this.pos += 2;
      }
      out.push(b);
    }
    // Map bytes to code points 1:1. NOT TextDecoder('latin1') — that is a
    // WHATWG alias for windows-1252, which decodes 0x80-0x9F to other code
    // points (0x80 -> U+20AC), so `/A#80B` would parse as a different name and
    // serialize back as the malformed `/A#20acB`.
    return String.fromCharCode(...out);
  }

  private readLiteralString(): Uint8Array {
    this.pos++; // skip '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      let b = this.buf[this.pos++];
      if (b === 92) { // backslash escape
        const e = this.buf[this.pos++];
        switch (e) {
          case 110: out.push(10); break; // n
          case 114: out.push(13); break; // r
          case 116: out.push(9); break;  // t
          case 98: out.push(8); break;   // b
          case 102: out.push(12); break; // f
          case 40: out.push(40); break;
          case 41: out.push(41); break;
          case 92: out.push(92); break;
          case 13: if (this.buf[this.pos] === 10) this.pos++; break; // line continuation
          case 10: break;
          default:
            if (e >= 48 && e <= 55) { // up to 3 octal digits
              let oct = e - 48;
              for (let i = 0; i < 2 && this.buf[this.pos] >= 48 && this.buf[this.pos] <= 55; i++)
                oct = oct * 8 + (this.buf[this.pos++] - 48);
              out.push(oct & 0xff);
            } else out.push(e);
        }
        continue;
      }
      if (b === 40) { depth++; out.push(b); continue; }
      if (b === 41) { depth--; if (depth === 0) break; out.push(b); continue; }
      out.push(b);
    }
    return Uint8Array.from(out);
  }

  private readHexString(): Uint8Array {
    this.pos++; // skip '<'
    const digits: number[] = [];
    while (this.pos < this.buf.length && this.buf[this.pos] !== 62) {
      const b = this.buf[this.pos++];
      if (isWs(b)) continue;
      digits.push(b);
    }
    this.pos++; // skip '>'
    if (digits.length % 2 === 1) digits.push(48); // pad with '0'
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++)
      out[i] = parseInt(String.fromCharCode(digits[2 * i], digits[2 * i + 1]), 16);
    return out;
  }
}
