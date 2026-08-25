import { namedEntity } from './mdentity.js';
import { caseFold, unicodePunctuation } from './unicode-data.js';

/** Lexical scanners shared by the block and inline phases of the CommonMark
 *  parser.
 *
 *  Invariant: an HTML tag, an entity reference, a backslash escape, a link
 *  destination, a link title and a reference label each have exactly ONE
 *  scanner, here. Both phases need the HTML grammar — the block phase for HTML
 *  block conditions 1-7, the inline phase for HtmlInline — and a reference
 *  definition's destination must parse identically to an inline link's. Two
 *  copies differ only on the balanced-parenthesis and pointy-bracket forms,
 *  which no HTML rendering reveals. */

/** The 32 characters a backslash may escape (32000-1 has no say here; this is
 *  CommonMark 0.31.2's "ASCII punctuation character"). */
export const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const ASCII_PUNCT_SET = new Set(ASCII_PUNCT);

/** Zs, plus tab, LF, FF and CR — CommonMark's "Unicode whitespace character". */
export function isUnicodeWhitespace(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d) return true;
  if (cp === 0x20 || cp === 0xa0 || cp === 0x1680) return true;
  if (cp >= 0x2000 && cp <= 0x200a) return true;
  return cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/** CommonMark's "Unicode punctuation character": ASCII punctuation, or general
 *  category P* or S*. Every ASCII punctuation character is already one of those,
 *  so the first test is only a fast path. */
export function isPunctuation(cp: number): boolean {
  if (cp < 0x80) return ASCII_PUNCT_SET.has(String.fromCharCode(cp));
  return unicodePunctuation(cp);
}

/** A code point that no character reference may produce. */
function safeCodePoint(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

/** Resolve one character reference at `s[i]` (which must be '&'). Returns the
 *  replacement and the index just past the ';', or undefined when this is not
 *  a reference — in which case the '&' is literal text. */
function scanEntity(s: string, i: number): { text: string; end: number } | undefined {
  if (s[i] !== '&') return undefined;
  const semi = s.indexOf(';', i + 1);
  if (semi < 0 || semi === i + 1) return undefined;
  const body = s.slice(i + 1, semi);
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const digits = hex ? body.slice(2) : body.slice(1);
    const ok = hex ? /^[0-9A-Fa-f]{1,6}$/.test(digits) : /^[0-9]{1,7}$/.test(digits);
    if (!ok) return undefined;
    return { text: safeCodePoint(parseInt(digits, hex ? 16 : 10)), end: semi + 1 };
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(body)) return undefined;
  const v = namedEntity(body);
  return v === undefined ? undefined : { text: v, end: semi + 1 };
}

/** Resolve every character reference in `s`. An unknown or malformed reference
 *  stays literal — CommonMark has no such thing as a bad document. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] === '&') {
      const e = scanEntity(s, i);
      if (e !== undefined) { out += e.text; i = e.end; continue; }
    }
    out += s[i++];
  }
  return out;
}

/** Apply backslash escapes and character references in ONE pass.
 *
 *  The order matters and is not achievable with two sequential passes: `\&copy;`
 *  must stay the literal text "&copy;", so the '&' an escape produced must never
 *  be offered to the entity scanner. */
export function unescapeString(s: string): string {
  if (!s.includes('\\') && !s.includes('&')) return s;
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT_SET.has(s[i + 1])) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '&') {
      const e = scanEntity(s, i);
      if (e !== undefined) { out += e.text; i = e.end; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

/** The key a link reference definition and a reference link agree on: strip,
 *  collapse internal whitespace, case fold.
 *
 *  This is full case folding, not lowercasing. The difference is load-bearing:
 *  spec example 540 expects `[ẞ]` to find `[SS]: /url`, and toLowerCase maps
 *  'ẞ' to 'ß' while folding maps both it and 'SS' to 'ss'. */
export function normalizeLabel(s: string): string {
  return caseFold(s.trim().replace(/[ \t\r\n]+/g, ' '));
}

const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*/;
const ATTR_NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;

/** The end index of the HTML tag starting at `s[i]`, or -1. Implements the
 *  spec's tag grammar: open tag, closing tag, comment, processing instruction,
 *  declaration, CDATA section. */
export function scanHtmlTag(s: string, i: number): number {
  if (s[i] !== '<') return -1;
  const rest = s.slice(i + 1);

  if (rest.startsWith('!--')) {
    // CommonMark 0.31.2: a comment is `<!-->`, `<!--->`, or `<!--` followed by
    // any characters not containing `-->`, then `-->`. This is looser than
    // 0.30, which rejected `<!-->` outright and forbade `--` in the body —
    // implementing the older rule costs two Raw HTML cases.
    if (rest.startsWith('!-->')) return i + 5;
    if (rest.startsWith('!--->')) return i + 6;
    const m = /^!--[\s\S]*?-->/.exec(rest);
    return m === null ? -1 : i + 1 + m[0].length;
  }
  if (rest.startsWith('?')) {
    const e = s.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (rest.startsWith('![CDATA[')) {
    const e = s.indexOf(']]>', i + 9);
    return e < 0 ? -1 : e + 3;
  }
  if (rest.startsWith('!') && /^[A-Za-z]/.test(rest.slice(1))) {
    const e = s.indexOf('>', i + 2);
    return e < 0 ? -1 : e + 1;
  }

  if (rest.startsWith('/')) {
    const m = TAG_NAME.exec(rest.slice(1));
    if (m === null) return -1;
    let j = i + 2 + m[0].length;
    while (j < s.length && /[ \t\r\n]/.test(s[j])) j++;
    return s[j] === '>' ? j + 1 : -1;
  }

  const name = TAG_NAME.exec(rest);
  if (name === null) return -1;
  let j = i + 1 + name[0].length;
  for (;;) {
    const wsStart = j;
    while (j < s.length && /[ \t\r\n]/.test(s[j])) j++;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    // An attribute must be preceded by whitespace.
    if (j === wsStart) return -1;
    const an = ATTR_NAME.exec(s.slice(j));
    if (an === null) return -1;
    j += an[0].length;
    const eqStart = j;
    while (j < s.length && /[ \t\r\n]/.test(s[j])) j++;
    if (s[j] !== '=') { j = eqStart; continue; }
    j++;
    while (j < s.length && /[ \t\r\n]/.test(s[j])) j++;
    const q = s[j];
    if (q === '"' || q === "'") {
      const e = s.indexOf(q, j + 1);
      if (e < 0) return -1;
      j = e + 1;
    } else {
      const uv = /^[^ \t\r\n"'=<>`]+/.exec(s.slice(j));
      if (uv === null) return -1;
      j += uv[0].length;
    }
  }
}

/** A link destination: `<...>` with no unescaped '<', '>' or newline, or a bare
 *  run of non-space, non-control characters in which parentheses balance. */
export function scanLinkDestination(s: string, i: number): { dest: string; end: number } | undefined {
  if (s[i] === '<') {
    let j = i + 1;
    let raw = '';
    while (j < s.length) {
      const c = s[j];
      if (c === '\n' || c === '<') return undefined;
      if (c === '>') return { dest: unescapeString(raw), end: j + 1 };
      if (c === '\\' && j + 1 < s.length && ASCII_PUNCT_SET.has(s[j + 1])) { raw += c + s[j + 1]; j += 2; continue; }
      raw += c;
      j++;
    }
    return undefined;
  }
  let j = i;
  let depth = 0;
  let raw = '';
  while (j < s.length) {
    const c = s[j];
    const code = s.charCodeAt(j);
    if (code < 0x20 || code === 0x7f || c === ' ') break;
    if (c === '\\' && j + 1 < s.length && ASCII_PUNCT_SET.has(s[j + 1])) { raw += c + s[j + 1]; j += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    raw += c;
    j++;
  }
  if (depth !== 0) return undefined;
  // Consuming nothing is a destination only in `[a]()`, where ')' follows. A
  // reference definition with no destination at all is not a definition.
  if (j === i) return s[i] === ')' ? { dest: '', end: i } : undefined;
  return { dest: unescapeString(raw), end: j };
}

/** A link title in any of its three quotings. A parenthesised title may not
 *  contain an unescaped '('. */
export function scanLinkTitle(s: string, i: number): { title: string; end: number } | undefined {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return undefined;
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  let raw = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ASCII_PUNCT_SET.has(s[j + 1])) { raw += c + s[j + 1]; j += 2; continue; }
    if (c === close) return { title: unescapeString(raw), end: j + 1 };
    if (open === '(' && c === '(') return undefined;
    raw += c;
    j++;
  }
  return undefined;
}
