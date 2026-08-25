import type { MdBlock, MdDocument, MdInline } from './mdast.js';
import type { LinkRef } from './mdblock.js';
import {
  ASCII_PUNCT, decodeEntities, isPunctuation, isUnicodeWhitespace, normalizeLabel,
  scanHtmlTag, scanLinkDestination, scanLinkTitle,
} from './mdscan.js';
import { extendedAutolinks, strikeDelimiters } from './mdgfm.js';

/** The inline phase of the CommonMark parser: replace each leaf block's staged
 *  raw text with parsed inline nodes, in place.
 *
 *  Nodes are built into a doubly-linked list rather than an array, because
 *  emphasis and links wrap arbitrary ranges after the fact — with an array,
 *  every splice would invalidate the offsets the delimiter stack holds. */

/** Past this many nested brackets, stop pushing openers and let them be literal
 *  text. `[[[[[...` recurses otherwise; no spec case nests past ten. */
const MAX_BRACKET_DEPTH = 1000;

interface LNode {
  node: MdInline;
  prev: LNode | undefined;
  next: LNode | undefined;
}

class NodeList {
  head: LNode | undefined;
  tail: LNode | undefined;

  push(node: MdInline): LNode {
    const n: LNode = { node, prev: this.tail, next: undefined };
    if (this.tail === undefined) this.head = n;
    else this.tail.next = n;
    this.tail = n;
    return n;
  }

  /** Flatten [from, to), merging adjacent text nodes so a run does not arrive
   *  as one node per character.
   *
   *  `from` is explicit rather than defaulted: an empty range starts at
   *  `undefined`, and defaulting that to `head` silently returns the WHOLE
   *  list — which is how `[]()` came to render as `<a href="">[</a>`. */
  collect(from: LNode | undefined, to: LNode | undefined): MdInline[] {
    const out: MdInline[] = [];
    for (let n = from; n !== undefined && n !== to; n = n.next) {
      const last = out[out.length - 1];
      if (n.node.type === 'text' && last !== undefined && last.type === 'text') last.value += n.node.value;
      else out.push(n.node);
    }
    return out;
  }

  toArray(): MdInline[] { return this.collect(this.head, undefined); }

  /** Detach every node strictly between `a` and `b`, or everything after `a`
   *  when `b` is undefined. */
  extract(a: LNode, b: LNode | undefined): MdInline[] {
    const out = this.collect(a.next, b);
    a.next = b;
    if (b !== undefined) b.prev = a;
    else this.tail = a;
    return out;
  }

  /** Insert `node` immediately after `a`. */
  insertAfter(a: LNode, node: MdInline): LNode {
    const n: LNode = { node, prev: a, next: a.next };
    if (a.next !== undefined) a.next.prev = n;
    else this.tail = n;
    a.next = n;
    return n;
  }

  remove(n: LNode): void {
    if (n.prev !== undefined) n.prev.next = n.next; else this.head = n.next;
    if (n.next !== undefined) n.next.prev = n.prev; else this.tail = n.prev;
  }
}

const TICKS = /`+/y;
const ESCAPABLE = new Set(ASCII_PUNCT);
const TEXT_RUN = /[^\n`[\]\\!<&*_]+/y;
/** `~` is a delimiter only under GFM, so the run regex forks rather than
 *  breaking every ordinary text run on a tilde. */
const TEXT_RUN_GFM = /[^\n`[\]\\!<&*_~]+/y;
const AUTOLINK = /^<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*>/;
const EMAIL_AUTOLINK = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const INITIAL_SPACE = /[ \t]*/y;
const LINK_LABEL = /^\[(?:[^\\[\]]|\\.){0,1000}\]/;

interface Bracket {
  node: LNode;
  /** Offset just past the opening bracket, for a shortcut reference label. */
  index: number;
  image: boolean;
  active: boolean;
  /** Whether another bracket opened after this one. */
  bracketAfter: boolean;
  prev: Bracket | undefined;
  prevDelimiter: Delim | undefined;
}

interface Delim {
  cc: '*' | '_' | '~';
  numdelims: number;
  /** The run's original length, which the rule of 3 is stated in terms of. */
  origdelims: number;
  node: LNode;
  prev: Delim | undefined;
  next: Delim | undefined;
  canOpen: boolean;
  canClose: boolean;
}

/** The code point before offset `i`, treating the start of the subject as a
 *  newline. Steps back over a surrogate pair, so astral punctuation classifies
 *  correctly rather than as a lone surrogate. */
function cpBefore(s: string, i: number): number {
  if (i <= 0) return 0x0a;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.codePointAt(i - 2)!;
  }
  return lo;
}

class InlineParser {
  subject: string;
  pos = 0;
  list = new NodeList();
  refs: Map<string, LinkRef>;
  /** Top of the delimiter stack. */
  delimiters: Delim | undefined;
  /** Top of the bracket stack. */
  brackets: Bracket | undefined;
  bracketDepth = 0;
  gfm: boolean;

  constructor(subject: string, refs: Map<string, LinkRef>, gfm = false) {
    this.subject = subject;
    this.refs = refs;
    this.gfm = gfm;
  }

  peek(): string | undefined { return this.subject[this.pos]; }

  match(re: RegExp): string | undefined {
    re.lastIndex = this.pos;
    const m = re.exec(this.subject);
    if (m === null || m.index !== this.pos) return undefined;
    this.pos = re.lastIndex;
    return m[0];
  }

  text(value: string): LNode { return this.list.push({ type: 'text', value }); }

  parse(): MdInline[] {
    for (;;) {
      const c = this.peek();
      if (c === undefined) break;
      let ok = false;
      switch (c) {
        case '\n': ok = this.parseNewline(); break;
        case '\\': ok = this.parseBackslash(); break;
        case '`': ok = this.parseBackticks(); break;
        case '<': ok = this.parseAutolink() || this.parseRawHtml(); break;
        case '&': ok = this.parseEntity(); break;
        case '*':
        case '_': ok = this.handleDelim(c); break;
        case '~': ok = this.gfm ? this.handleDelim(c) : false; break;
        case '[': ok = this.parseOpenBracket(); break;
        case '!': ok = this.parseBang(); break;
        case ']': ok = this.parseCloseBracket(); break;
        default: ok = false; break;
      }
      if (!ok) this.parseString();
    }
    this.processEmphasis(undefined);
    return this.list.toArray();
  }

  /** Measure a run of `*` or `_` and decide whether it can open or close.
   *  Leaves `pos` where it found it. */
  scanDelims(cc: string): { numdelims: number; canOpen: boolean; canClose: boolean } | undefined {
    const start = this.pos;
    let n = 0;
    while (this.subject[this.pos] === cc) { n++; this.pos++; }
    if (n === 0) { this.pos = start; return undefined; }

    const before = cpBefore(this.subject, start);
    const after = this.subject.codePointAt(this.pos) ?? 0x0a;
    this.pos = start;

    const afterWs = isUnicodeWhitespace(after);
    const afterPunct = isPunctuation(after);
    const beforeWs = isUnicodeWhitespace(before);
    const beforePunct = isPunctuation(before);

    const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);

    // `_` is stricter than `*`, which is what keeps snake_case_words intact.
    const canOpen = cc === '_' ? leftFlanking && (!rightFlanking || beforePunct) : leftFlanking;
    const canClose = cc === '_' ? rightFlanking && (!leftFlanking || afterPunct) : rightFlanking;
    return { numdelims: n, canOpen, canClose };
  }

  handleDelim(cc: string): boolean {
    const res = this.scanDelims(cc);
    if (res === undefined) return false;
    const start = this.pos;
    this.pos += res.numdelims;
    const node = this.text(this.subject.slice(start, this.pos));
    // A tilde run of three or more is literal text, never a delimiter.
    const eligible = cc === '~' ? strikeDelimiters(res.numdelims) : true;
    if (eligible && (res.canOpen || res.canClose)) {
      const d: Delim = {
        cc: cc as '*' | '_' | '~',
        numdelims: res.numdelims,
        origdelims: res.numdelims,
        node,
        prev: this.delimiters,
        next: undefined,
        canOpen: res.canOpen,
        canClose: res.canClose,
      };
      if (d.prev !== undefined) d.prev.next = d;
      this.delimiters = d;
    }
    return true;
  }

  // ---- links and images --------------------------------------------------

  addBracket(node: LNode, index: number, image: boolean): void {
    if (this.brackets !== undefined) this.brackets.bracketAfter = true;
    if (this.bracketDepth >= MAX_BRACKET_DEPTH) return;
    this.bracketDepth++;
    this.brackets = {
      node, index, image, active: true, bracketAfter: false,
      prev: this.brackets, prevDelimiter: this.delimiters,
    };
  }

  removeBracket(): void {
    if (this.brackets === undefined) return;
    this.bracketDepth--;
    this.brackets = this.brackets.prev;
  }

  parseOpenBracket(): boolean {
    const start = this.pos;
    this.pos++;
    this.addBracket(this.text('['), start + 1, false);
    return true;
  }

  parseBang(): boolean {
    const start = this.pos;
    this.pos++;
    if (this.subject[this.pos] === '[') {
      this.pos++;
      this.addBracket(this.text('!['), start + 2, true);
    } else {
      this.text('!');
    }
    return true;
  }

  /** Spaces and tabs, then at most one newline, then spaces and tabs. */
  spnl(): void {
    const m = /^[ \t]*(?:\n[ \t]*)?/.exec(this.subject.slice(this.pos));
    if (m !== null) this.pos += m[0].length;
  }

  /** A bracketed label at `pos`; its length, or 0. */
  parseLinkLabel(): number {
    const m = LINK_LABEL.exec(this.subject.slice(this.pos));
    if (m === null || m[0].length > 1001) return 0;
    this.pos += m[0].length;
    return m[0].length;
  }

  parseCloseBracket(): boolean {
    this.pos++;
    const afterBracket = this.pos;

    const opener = this.brackets;
    if (opener === undefined) { this.text(']'); return true; }
    if (!opener.active) { this.text(']'); this.removeBracket(); return true; }

    const isImage = opener.image;
    const savepos = this.pos;
    let dest: string | undefined;
    let title = '';
    let matched = false;

    // Inline link: ](dest "title")
    if (this.subject[this.pos] === '(') {
      this.pos++;
      this.spnl();
      const d = scanLinkDestination(this.subject, this.pos);
      if (d !== undefined) {
        this.pos = d.end;
        const beforeSpnl = this.pos;
        this.spnl();
        // A title needs whitespace before it; without any, only ')' may follow.
        if (this.pos > beforeSpnl) {
          const t = scanLinkTitle(this.subject, this.pos);
          if (t !== undefined) { title = t.title; this.pos = t.end; }
        }
        this.spnl();
        if (this.subject[this.pos] === ')') { this.pos++; dest = d.dest; matched = true; }
      }
      if (!matched) { this.pos = savepos; title = ''; }
    }

    // Reference link: full, collapsed, or shortcut.
    if (!matched) {
      const beforeLabel = this.pos;
      const n = this.parseLinkLabel();
      let reflabel: string | undefined;
      if (n > 2) reflabel = this.subject.slice(beforeLabel + 1, beforeLabel + n - 1);
      else if (!opener.bracketAfter) reflabel = this.subject.slice(opener.index, afterBracket - 1);
      if (n === 0) this.pos = savepos;

      if (reflabel !== undefined) {
        const ref = this.refs.get(normalizeLabel(reflabel));
        if (ref !== undefined) { dest = ref.destination; title = ref.title; matched = true; }
      }
    }

    if (!matched) {
      this.removeBracket();
      this.pos = afterBracket;
      this.text(']');
      return true;
    }

    // Emphasis inside the brackets resolves against the bracket's own bottom,
    // so a delimiter outside cannot pair with one inside.
    this.processEmphasis(opener.prevDelimiter);
    const children = this.list.extract(opener.node, undefined);
    this.list.push(isImage
      ? { type: 'image', destination: dest ?? '', title, children }
      : { type: 'link', destination: dest ?? '', title, children });
    this.list.remove(opener.node);
    this.removeBracket();

    // Links do not nest: every earlier link opener is now dead.
    if (!isImage) {
      for (let b = this.brackets; b !== undefined; b = b.prev) {
        if (!b.image) b.active = false;
      }
    }
    return true;
  }

  removeDelimiter(d: Delim): void {
    if (d.prev !== undefined) d.prev.next = d.next;
    if (d.next === undefined) this.delimiters = d.prev;
    else d.next.prev = d.prev;
  }

  removeDelimitersBetween(a: Delim, b: Delim): void {
    if (a.next !== b) { a.next = b; b.prev = a; }
  }

  /** The spec's process_emphasis.
   *
   *  `openersBottom` records how far back a failed search reached, so no later
   *  closer of the same shape re-scans the same openers. It is part of the
   *  published algorithm and is kept for that reason.
   *
   *  Measured honestly, it is NOT load-bearing in this implementation: removing
   *  it leaves all 652 spec cases passing and changes no timing on seven
   *  adversarial inputs (cmark's own "openers and closers multiple of 3",
   *  openers-without-closers, closers-without-openers, long delimiter runs).
   *  The reason appears to be that a failed closer which cannot also open is
   *  removed outright below, and a successful match discards every delimiter
   *  between its two ends, so the stack never grows the long failing chain the
   *  guard is meant to bound. Do not read the green suite as proof it works —
   *  it is retained because the spec specifies it, not because a test pins it. */
  processEmphasis(stackBottom: Delim | undefined): void {
    const openersBottom = new Map<string, Delim | undefined>();
    const key = (d: Delim): string => `${d.cc}${d.origdelims % 3}${d.canOpen ? 1 : 0}`;

    let closer = this.delimiters;
    while (closer !== undefined && closer.prev !== stackBottom) closer = closer.prev;

    while (closer !== undefined) {
      if (!closer.canClose) { closer = closer.next; continue; }
      if (closer.cc === '~') { closer = this.strikethrough(closer, stackBottom); continue; }

      const k = key(closer);
      const bottom = openersBottom.has(k) ? openersBottom.get(k) : stackBottom;
      let opener = closer.prev;
      let found = false;
      while (opener !== undefined && opener !== stackBottom && opener !== bottom) {
        // The rule of 3: when either run can both open and close, the two
        // lengths may not sum to a multiple of 3 unless both are multiples.
        const oddMatch = (closer.canOpen || opener.canClose)
          && closer.origdelims % 3 !== 0
          && (opener.origdelims + closer.origdelims) % 3 === 0;
        if (opener.cc === closer.cc && opener.canOpen && !oddMatch) { found = true; break; }
        opener = opener.prev;
      }
      const oldCloser = closer;

      if (!found) {
        openersBottom.set(k, oldCloser.prev);
        closer = closer.next;
        if (!oldCloser.canOpen) this.removeDelimiter(oldCloser);
        continue;
      }

      const op = opener!;
      const use = closer.numdelims >= 2 && op.numdelims >= 2 ? 2 : 1;
      const openerNode = op.node;
      const closerNode = closer.node;

      op.numdelims -= use;
      closer.numdelims -= use;
      (openerNode.node as { value: string }).value =
        (openerNode.node as { value: string }).value.slice(0, -use);
      (closerNode.node as { value: string }).value =
        (closerNode.node as { value: string }).value.slice(0, -use);

      const children = this.list.extract(openerNode, closerNode);
      this.list.insertAfter(openerNode, use === 1
        ? { type: 'emph', children }
        : { type: 'strong', children });

      this.removeDelimitersBetween(op, closer);

      if (op.numdelims === 0) { this.list.remove(openerNode); this.removeDelimiter(op); }
      if (closer.numdelims === 0) {
        const next = closer.next;
        this.list.remove(closerNode);
        this.removeDelimiter(closer);
        closer = next;
      }
    }

    while (this.delimiters !== undefined && this.delimiters !== stackBottom) {
      this.removeDelimiter(this.delimiters);
    }
  }

  /** cmark-gfm's strikethrough `insert`: the nearest '~' opener wins the search
   *  regardless of length, and the pair only wraps when the two runs are the
   *  SAME length. Either way every delimiter between the two ends dies, which is
   *  why a failed match cannot be retried against an opener further back. */
  strikethrough(closer: Delim, stackBottom: Delim | undefined): Delim | undefined {
    const next = closer.next;
    let opener = closer.prev;
    while (opener !== undefined && opener !== stackBottom && !(opener.cc === '~' && opener.canOpen)) {
      opener = opener.prev;
    }
    if (opener === undefined || opener === stackBottom) {
      if (!closer.canOpen) this.removeDelimiter(closer);
      return next;
    }
    if (opener.numdelims === closer.numdelims) {
      const children = this.list.extract(opener.node, closer.node);
      this.list.insertAfter(opener.node, { type: 'strikethrough', children });
      this.list.remove(opener.node);
      this.list.remove(closer.node);
    }
    this.removeDelimitersBetween(opener, closer);
    this.removeDelimiter(closer);
    this.removeDelimiter(opener);
    return next;
  }

  parseString(): void {
    const run = this.match(this.gfm ? TEXT_RUN_GFM : TEXT_RUN);
    if (run !== undefined) { this.text(run); return; }
    // A special character no rule claimed is ordinary text.
    this.text(this.subject[this.pos]);
    this.pos++;
  }

  parseNewline(): boolean {
    this.pos++;
    const last = this.list.tail;
    if (last !== undefined && last.node.type === 'text' && last.node.value.endsWith(' ')) {
      const hard = last.node.value.endsWith('  ');
      last.node.value = last.node.value.replace(/ +$/, '');
      this.list.push(hard ? { type: 'linebreak' } : { type: 'softbreak' });
    } else {
      this.list.push({ type: 'softbreak' });
    }
    // The next line's leading whitespace is not content.
    this.match(INITIAL_SPACE);
    return true;
  }

  parseBackslash(): boolean {
    this.pos++;
    const c = this.peek();
    if (c === '\n') { this.pos++; this.list.push({ type: 'linebreak' }); return true; }
    if (c !== undefined && ESCAPABLE.has(c)) { this.text(c); this.pos++; return true; }
    this.text('\\');
    return true;
  }

  parseBackticks(): boolean {
    const start = this.pos;
    const ticks = this.match(TICKS);
    if (ticks === undefined) return false;
    const afterOpen = this.pos;
    for (;;) {
      const close = this.findTicks();
      if (close === undefined) break;
      if (close.length !== ticks.length) continue;
      let content = this.subject.slice(afterOpen, this.pos - ticks.length).replace(/\n/g, ' ');
      // One space is stripped from each end when both are spaces and the
      // content is not all spaces.
      if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      this.list.push({ type: 'code', value: content });
      return true;
    }
    // No closing run of the same length: the opener is literal text.
    this.pos = afterOpen;
    this.list.push({ type: 'text', value: ticks });
    void start;
    return true;
  }

  /** Advance to the next run of backticks and return it. */
  findTicks(): string | undefined {
    while (this.pos < this.subject.length) {
      if (this.subject[this.pos] === '`') return this.match(TICKS);
      this.pos++;
    }
    return undefined;
  }

  parseAutolink(): boolean {
    const rest = this.subject.slice(this.pos);
    const email = EMAIL_AUTOLINK.exec(rest);
    if (email !== null) {
      const addr = email[0].slice(1, -1);
      this.list.push({
        type: 'link', destination: `mailto:${addr}`, title: '',
        children: [{ type: 'text', value: addr }],
      });
      this.pos += email[0].length;
      return true;
    }
    const uri = AUTOLINK.exec(rest);
    if (uri !== null) {
      const dest = uri[0].slice(1, -1);
      this.list.push({
        type: 'link', destination: dest, title: '',
        children: [{ type: 'text', value: dest }],
      });
      this.pos += uri[0].length;
      return true;
    }
    return false;
  }

  parseRawHtml(): boolean {
    const end = scanHtmlTag(this.subject, this.pos);
    if (end < 0) return false;
    this.list.push({ type: 'html_inline', literal: this.subject.slice(this.pos, end) });
    this.pos = end;
    return true;
  }

  parseEntity(): boolean {
    // decodeEntities owns the grammar; ask it whether this '&' starts one by
    // giving it the shortest span that could contain a reference.
    const semi = this.subject.indexOf(';', this.pos + 1);
    if (semi < 0) return false;
    const raw = this.subject.slice(this.pos, semi + 1);
    const decoded = decodeEntities(raw);
    if (decoded === raw) return false;
    this.text(decoded);
    this.pos = semi + 1;
    return true;
  }
}

export function parseInlines(doc: MdDocument, refs: Map<string, LinkRef>, gfm = false): void {
  walk(doc, refs, gfm);
}

function walk(block: MdBlock, refs: Map<string, LinkRef>, gfm: boolean): void {
  switch (block.type) {
    case 'document':
    case 'block_quote':
    case 'item':
    case 'list':
      for (const c of block.children) walk(c, refs, gfm);
      return;
    case 'table':
      for (const row of block.children) walk(row, refs, gfm);
      return;
    case 'table_row':
      for (const cell of block.children) walk(cell, refs, gfm);
      return;
    case 'paragraph':
    case 'heading':
    case 'table_cell':
      block.children = parseLeaf(staged(block.children), refs, gfm);
      return;
    default:
      return;
  }
}

/** Parse one leaf's staged text, then run the GFM autolink post-pass over the
 *  result. The pass is deliberately last: it reads the finished node list, where
 *  code spans and links are already their own types. */
function parseLeaf(raw: string, refs: Map<string, LinkRef>, gfm: boolean): MdInline[] {
  if (raw === '') return [];
  const nodes = new InlineParser(raw.trim(), refs, gfm).parse();
  return gfm ? extendedAutolinks(nodes) : nodes;
}

/** The raw string the block phase staged, if any. */
function staged(children: MdInline[]): string {
  if (children.length === 1 && children[0].type === 'text') return children[0].value;
  return '';
}
