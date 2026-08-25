import { Lexer } from './lexer.js';

export interface CMap {
  /** Number of bytes per code, from the codespace range (default 2). */
  readonly codeWidth: number;
  /** Map an integer code to its Unicode string, or undefined if unmapped. */
  lookup(code: number): string | undefined;
  /** Every mapping the CMap declares, in ascending code order. Exposed so that
   *  `scripts/gen-cidunicode.ts` can build the bundled CID→Unicode tables
   *  through this same parser, rather than a second one written beside it. */
  entries(): [number, string][];
}

/** Interpret hex-string bytes (big-endian) as an integer code. */
function bytesToCode(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) n = (n << 8) | b;
  return n >>> 0;
}

/** Interpret UTF-16BE bytes as a JS string (CMap bf destinations are UTF-16BE). */
function utf16beToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  if (bytes.length % 2 === 1) s += String.fromCharCode(bytes[bytes.length - 1]);
  return s;
}

/** Parse a (decoded) ToUnicode/CMap stream into a lookup table. */
export function parseCMap(buf: Uint8Array): CMap {
  const lx = new Lexer(buf);
  const single = new Map<number, string>();
  let codeWidth = 2;
  let sawCodespace = false;

  // Collect a flat token list of the values we care about.
  type V = { kind: 'hex'; bytes: Uint8Array } | { kind: 'num'; v: number }
    | { kind: 'op'; v: string } | { kind: 'arrStart' } | { kind: 'arrEnd' };
  const toks: V[] = [];
  for (;;) {
    const t = lx.next();
    if (t.t === 'eof') break;
    if (t.t === 'str') toks.push({ kind: 'hex', bytes: t.v });
    else if (t.t === 'num') toks.push({ kind: 'num', v: t.v });
    else if (t.t === 'kw') toks.push({ kind: 'op', v: t.v });
    else if (t.t === 'delim' && t.v === '[') toks.push({ kind: 'arrStart' });
    else if (t.t === 'delim' && t.v === ']') toks.push({ kind: 'arrEnd' });
    // names and other delims are ignored
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'op') continue;
    if (t.v === 'begincodespacerange') {
      // next two hex tokens define the range; width = low byte length
      const lo = toks[i + 1];
      if (lo && lo.kind === 'hex' && !sawCodespace) { codeWidth = lo.bytes.length || 2; sawCodespace = true; }
    } else if (t.v === 'beginbfchar') {
      let j = i + 1;
      while (j < toks.length && toks[j].kind !== 'op') {
        const src = toks[j], dst = toks[j + 1];
        if (src?.kind === 'hex' && dst?.kind === 'hex') {
          single.set(bytesToCode(src.bytes), utf16beToString(dst.bytes));
          j += 2;
        } else { j++; }
      }
      i = j;
    } else if (t.v === 'beginbfrange') {
      let j = i + 1;
      while (j < toks.length && toks[j].kind !== 'op') {
        const a = toks[j], b = toks[j + 1], c = toks[j + 2];
        if (a?.kind === 'hex' && b?.kind === 'hex' && c?.kind === 'arrStart') {
          // array form: [<..> <..> ...]
          const lo = bytesToCode(a.bytes);
          let k = j + 3, code = lo;
          while (k < toks.length && toks[k].kind !== 'arrEnd') {
            const e = toks[k];
            if (e.kind === 'hex') single.set(code++, utf16beToString(e.bytes));
            k++;
          }
          j = k + 1;
        } else if (a?.kind === 'hex' && b?.kind === 'hex' && c?.kind === 'hex') {
          const lo = bytesToCode(a.bytes), hi = bytesToCode(b.bytes);
          const base = utf16beToString(c.bytes);
          const baseCp = base.codePointAt(0) ?? 0;
          for (let code = lo; code <= hi; code++) {
            single.set(code, String.fromCodePoint(baseCp + (code - lo)));
          }
          j += 3;
        } else { j++; }
      }
      i = j;
    }
  }

  return {
    codeWidth,
    lookup: (code) => single.get(code),
    entries: () => [...single.entries()].sort((a, b) => a[0] - b[0]),
  };
}
