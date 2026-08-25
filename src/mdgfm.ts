import type { MdInline } from './mdast.js';
import { isPunctuation, isUnicodeWhitespace } from './mdscan.js';

/** The GitHub Flavored Markdown extensions that are not the table block:
 *  strikethrough, task list items, extended autolinks, and the
 *  disallowed-raw-HTML filter.
 *
 *  Pure: strings and data in, strings and data out. Nothing here touches a
 *  Document or allocates a PDF object, and nothing here imports the block or
 *  inline phase — the phase modules call in, never the other way round. */

/** Whether a run of `n` tildes may join the delimiter stack.
 *
 *  One or two, never three or more — cmark-gfm's strikethrough.c pushes a
 *  delimiter only for `delims == 2 || delims == 1`, so `~~~x~~~` is literal
 *  text. The spec's prose says "two tildes" and its two examples only use two;
 *  the single-tilde form is real GitHub behaviour and is pinned by hand in
 *  test/gfm-ast.test.ts. */
export function strikeDelimiters(n: number): boolean {
  return n === 1 || n === 2;
}

// ---- disallowed raw HTML --------------------------------------------------

/** The nine tags GFM's tagfilter extension neutralizes. They are the ones that
 *  change how the HTML around them is interpreted, so a document that embeds
 *  one changes the meaning of everything after it. */
const DISALLOWED_TAGS = [
  'title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext',
];

const DISALLOWED = new RegExp(`<(/?)(${DISALLOWED_TAGS.join('|')})(?=[\\s/>])`, 'gi');

/** GFM's "disallowed raw HTML": replace the leading `<` of a disallowed tag
 *  with `&lt;`.
 *
 *  This is a RENDERING transform — the spec defines it as applying "when
 *  rendering HTML output" — so it does not touch the tree: MdHtmlBlock and
 *  MdHtmlInline keep their literal raw, exactly as a link destination is stored
 *  unencoded. It lives here because the tag list belongs with the other GFM
 *  rules and because a consumer emitting HTML from this AST needs it; this
 *  library's own renderer produces PDF and drops raw HTML entirely, so nothing
 *  in src/ calls it. That is deliberate, and the same trade cmapcodec.ts makes
 *  with its build-time encoder: one owner for a rule beats two copies. */
export function filterDisallowedHtml(html: string): string {
  return html.replace(DISALLOWED, (_m, slash: string, name: string) => `&lt;${slash}${name}`);
}

// ---- extended autolinks ---------------------------------------------------
//
// Ports of cmark-gfm's extensions/autolink.c. cmark matches www/url during
// inline parsing, on the trigger characters 'w' and ':', and emails in a
// postprocess; here both run as one post-pass over the finished inline list,
// in that same order.

const isAlpha = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isAlnum = (c: string | undefined): boolean =>
  isAlpha(c) || (c !== undefined && c >= '0' && c <= '9');
/** cmark's isspace, which is C's: space, tab, and the vertical forms. */
const isCSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';

/** Trailing characters autolink_delim drops one at a time. */
const TRAILING = new Set(['?', '!', '.', ',', ':', '*', '_', '~', "'", '"']);

/** cmark's is_valid_hostchar: neither Unicode whitespace nor punctuation.
 *  Ours is CommonMark 0.31's P*+S* class rather than cmark's hand-rolled table;
 *  the two agree on every ASCII character, which is all any spec example uses. */
function isHostChar(s: string, i: number): boolean {
  const cp = s.codePointAt(i);
  if (cp === undefined) return false;
  return !isUnicodeWhitespace(cp) && !isPunctuation(cp);
}

/** cmark's autolink_delim: where the link really ends.
 *
 *  `sub` starts at the link and `end` is the candidate length. Trailing
 *  sentence punctuation is dropped, a closing paren is kept only while the
 *  parens balance, a trailing `&entity;` is dropped whole, and a `<` ends the
 *  link outright. */
export function autolinkDelim(sub: string, end: number): number {
  let linkEnd = end;
  let opening = 0;
  let closing = 0;

  for (let i = 0; i < linkEnd; i++) {
    const c = sub[i];
    if (c === '<') { linkEnd = i; break; }
    if (c === '(') opening++;
    else if (c === ')') closing++;
  }

  while (linkEnd > 0) {
    const c = sub[linkEnd - 1];
    if (c === ')') {
      if (closing <= opening) return linkEnd;
      closing--;
      linkEnd--;
    } else if (TRAILING.has(c)) {
      linkEnd--;
    } else if (c === ';') {
      let newEnd = linkEnd - 2;
      while (newEnd > 0 && isAlpha(sub[newEnd])) newEnd--;
      if (newEnd < linkEnd - 2 && sub[newEnd] === '&') linkEnd = newEnd;
      else linkEnd--;
    } else {
      return linkEnd;
    }
  }
  return linkEnd;
}

/** cmark's check_domain: the length of the domain at the start of `s`, or 0.
 *
 *  `allowShort` drops the requirement of a dot — a scheme'd URL may point at a
 *  bare host, a `www.` link may not. The underscore rule bars `_` from either
 *  of the last two segments, because host names may not carry one; it is
 *  skipped past ten segments, which is cmark's own denial-of-service guard.
 *
 *  The loop bounds are cmark's: from 1, stopping before the last character. The
 *  caller extends past the end anyway. */
export function checkDomain(s: string, allowShort: boolean): number {
  let np = 0;
  let uscore1 = 0;
  let uscore2 = 0;
  let i = 1;
  for (; i < s.length - 1; i++) {
    if (s[i] === '\\' && i < s.length - 2) i++;
    if (s[i] === '_') uscore2++;
    else if (s[i] === '.') { uscore1 = uscore2; uscore2 = 0; np++; }
    else if (!isHostChar(s, i) && s[i] !== '-') break;
  }
  if ((uscore1 > 0 || uscore2 > 0) && np <= 10) return 0;
  if (allowShort) return i;
  return np > 0 ? i : 0;
}

const SCHEME = /(?:https?|ftp):\/\//gi;

function mkLink(destination: string, text: string): MdInline {
  return { type: 'link', destination, title: '', children: [{ type: 'text', value: text }] };
}

/** cmark's www_match and url_match, over one text node.
 *
 *  One divergence from cmark is accepted and recorded rather than hidden: there
 *  these run while the bracket stack still exists and refuse to fire inside an
 *  open bracket, so `[a www.b.com]` with no matching reference stays plain text.
 *  Running after the fact links it. Matching inline instead would break every
 *  text run in every document on 'w' and ':' to catch a construct no spec
 *  example covers. */
function splitUrls(s: string): MdInline[] {
  const out: MdInline[] = [];
  let base = 0;
  let i = 0;

  while (i < s.length) {
    SCHEME.lastIndex = i;
    const m = SCHEME.exec(s);
    const url = m === null ? -1 : m.index;
    const www = s.indexOf('www.', i);
    if (url < 0 && www < 0) break;

    const isWww = url < 0 || (www >= 0 && www < url);
    const start = isWww ? www : url;
    let end = 0;

    if (isWww) {
      // The character before must be start-of-text, whitespace, or one of *_~(.
      const prev = start === 0 ? undefined : s[start - 1];
      if (prev === undefined || isCSpace(prev)
        || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
        const domain = checkDomain(s.slice(start), false);
        if (domain > 0) end = start + domain;
      }
    } else {
      // A scheme preceded by a letter is part of a longer word, not a scheme.
      const afterScheme = start + m![0].length;
      if (!isAlpha(s[start - 1]) && isHostChar(s, afterScheme)) {
        const domain = checkDomain(s.slice(afterScheme), true);
        if (domain > 0) end = afterScheme + domain;
      }
    }

    if (end === 0) { i = start + 1; continue; }

    while (end < s.length && !isCSpace(s[end]) && s[end] !== '<') end++;
    const len = autolinkDelim(s.slice(start), end - start);
    if (len === 0) { i = start + 1; continue; }

    const text = s.slice(start, start + len);
    if (start > base) out.push({ type: 'text', value: s.slice(base, start) });
    out.push(mkLink(isWww ? `http://${text}` : text, text));
    base = start + len;
    i = base;
  }

  if (base < s.length) out.push({ type: 'text', value: s.slice(base) });
  return out;
}

/** cmark's validate_protocol: whether `protocol` sits immediately before the
 *  local part, and is itself preceded by a non-alphanumeric. */
function validateProtocol(
  protocol: string, s: string, at: number, rewind: number, maxRewind: number,
): boolean {
  const len = protocol.length;
  if (len > maxRewind - rewind) return false;
  const from = at - rewind - len;
  if (s.slice(from, from + len) !== protocol) return false;
  if (len === maxRewind - rewind) return true;
  return !isAlnum(s[from - 1]);
}

/** cmark's postprocess_text: bare email addresses, plus explicit mailto: and
 *  xmpp: URLs, which share the same local-part scan.
 *
 *  Runs after splitUrls, mirroring cmark's ordering — there, www/url match
 *  during inline parsing and this is the postprocess, so a scheme'd URL
 *  containing an '@' is already a link and never reaches here. */
function splitEmails(s: string): MdInline[] {
  const out: MdInline[] = [];
  let base = 0;
  let offset = 0;

  while (base + offset < s.length) {
    const found = s.indexOf('@', base + offset);
    if (found < 0) break;

    let maxRewind = found - (base + offset);
    let rewind = 0;
    let autoMailto = true;
    let isXmpp = false;
    let linkEnd = 0;
    let np = 0;
    let retry = true;
    let abandoned = false;

    while (retry) {
      retry = false;
      const at = base + offset + maxRewind;

      autoMailto = true;
      isXmpp = false;
      for (rewind = 0; rewind < maxRewind; rewind++) {
        const c = s[at - rewind - 1];
        if (isAlnum(c) || c === '.' || c === '+' || c === '-' || c === '_') continue;
        if (c === ':') {
          if (validateProtocol('mailto:', s, at, rewind, maxRewind)) {
            autoMailto = false;
            continue;
          }
          if (validateProtocol('xmpp:', s, at, rewind, maxRewind)) {
            autoMailto = false;
            isXmpp = true;
            continue;
          }
        }
        break;
      }
      if (rewind === 0) { offset += maxRewind + 1; abandoned = true; break; }

      np = 0;
      const limit = s.length - at;
      for (linkEnd = 1; linkEnd < limit; linkEnd++) {
        const c = s[at + linkEnd];
        if (isAlnum(c)) continue;
        if (c === '@') {
          // Another '@': start again from just past the first one.
          offset += maxRewind + 1;
          maxRewind = linkEnd - 1;
          retry = true;
          break;
        }
        if (c === '.' && linkEnd < limit - 1 && isAlnum(s[at + linkEnd + 1])) np++;
        else if (c === '/' && isXmpp) continue;
        else if (c !== '-' && c !== '_') break;
      }
    }
    if (abandoned) continue;

    const at = base + offset + maxRewind;
    const last = s[at + linkEnd - 1];
    if (linkEnd < 2 || np === 0 || (!isAlpha(last) && last !== '.')) {
      offset += maxRewind + linkEnd;
      continue;
    }

    linkEnd = autolinkDelim(s.slice(at), linkEnd);
    if (linkEnd === 0) { offset += maxRewind + 1; continue; }

    const start = at - rewind;
    if (start > base) out.push({ type: 'text', value: s.slice(base, start) });
    const text = s.slice(start, at + linkEnd);
    out.push(mkLink(autoMailto ? `mailto:${text}` : text, text));
    base = at + linkEnd;
    offset = 0;
  }

  if (base < s.length) out.push({ type: 'text', value: s.slice(base) });
  return out;
}

/** Rewrite every text node into a text/link sequence.
 *
 *  Recurses into containers but NEVER into a link, so links do not nest — the
 *  same guarantee CommonMark's bracket stack gives. Code spans and existing
 *  links are already their own node types by the time this runs, so the two
 *  contexts an autolink must not fire in are structurally excluded rather than
 *  re-derived. */
export function extendedAutolinks(nodes: MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      for (const piece of splitUrls(n.value)) {
        if (piece.type !== 'text') { out.push(piece); continue; }
        out.push(...splitEmails(piece.value));
      }
      continue;
    }
    // Belt and braces: the recursion list below is a closed enumeration that
    // already omits 'link', so this line is what a reader sees rather than what
    // enforces the rule. It is the guard that survives someone extending that
    // list, which is exactly how a no-nested-links rule gets lost.
    if (n.type === 'link') { out.push(n); continue; }
    if (n.type === 'emph' || n.type === 'strong' || n.type === 'strikethrough' || n.type === 'image') {
      n.children = extendedAutolinks(n.children);
    }
    out.push(n);
  }
  return out;
}
