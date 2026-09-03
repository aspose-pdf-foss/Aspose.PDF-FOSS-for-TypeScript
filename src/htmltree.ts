/** HTML5 tree construction (HTML Standard §13.2.6): the half that turns
 *  htmltoken.ts's token stream into a node tree.
 *
 *  A literal transcription, as the tokenizer is — one method per insertion
 *  mode, named as §13.2.6.4 names it. The 20 non-template modes are here;
 *  foreign content, <template> and fragment parsing are zch2.1.3.
 *
 *  Note 20, not the 22 zch2.1.2's design and plan both named. The HTML
 *  Standard has REMOVED "in select" and "in select in table" (the
 *  customizable-select change): §13.2.6.4 now runs .1 to .21, `select`
 *  content is parsed by "in body", and `select` has moved into the DEFAULT
 *  scope's terminator list. The vendored WPT corpus is written against the
 *  current spec and is what settled it — 17 of its cases fail against the
 *  older reading.
 *
 *  Invariant: NEVER throws. Every string is a valid HTML document — the spec
 *  mandates a recovery for every case by construction — which is markdown.ts's
 *  rule and the exact opposite of parseXml.
 *
 *  Invariant: a pure leaf. No Document, no PDF object, no `node:` import.
 *
 *  Invariant: `parseHtml` is NOT exported from index.ts. Without foreign
 *  content an inline <svg> parses into the HTML namespace and is silently
 *  wrong; the export ships with zch2.1.3. */

import { HtmlTokenizer, TokenizerState } from './htmltoken.js';
import type { HtmlToken } from './htmltoken.js';
import {
  bomEncoding, decodeHtmlBytes, encodingFromLabel, metaEncoding,
} from './htmlencoding.js';
import {
  createDocument, createElement, createFragment, createText, createComment, createDoctype,
  createProcessingInstruction, appendChild, insertBefore, removeChild,
} from './htmldom.js';
import type {
  HtmlChild, HtmlComment, HtmlDocument, HtmlElement, HtmlFragment, HtmlNamespace, HtmlNode,
  HtmlParent, HtmlProcessingInstruction,
} from './htmldom.js';
import { OpenElements, ActiveFormatting } from './htmlstack.js';
import {
  FOREIGN_ATTRS, FOREIGN_BREAKOUT, MATHML_ATTRS, SVG_ATTRS,
  adjustAttributes, adjustSvgTagName,
  isHtmlIntegrationPoint, isMathmlTextIntegrationPoint,
} from './htmlforeign.js';

/** §13.2.6.4's insertion modes, named as the spec names them. */
enum Mode {
  Initial,
  BeforeHtml,
  BeforeHead,
  InHead,
  InHeadNoscript,
  AfterHead,
  InBody,
  Text,
  InTable,
  InTableText,
  InCaption,
  InColumnGroup,
  InTableBody,
  InRow,
  InCell,
  InTemplate,
  AfterBody,
  InFrameset,
  AfterFrameset,
  AfterAfterBody,
  AfterAfterFrameset,
}

/** A fragment parse's context element, as §13.4's "context". The namespace
 *  matters: 67 of the corpus's 196 fragment contexts are SVG or MathML, and a
 *  bare name cannot say which. */
export interface FragmentContext {
  name: string;
  ns?: HtmlNamespace;
}

/** §13.2.4.2's "special" category. Note `dialog` is deliberately ABSENT — it
 *  is in the in-body block-element start-tag list but not in this one, which
 *  is the sort of asymmetry a from-memory list gets wrong. The MathML and SVG
 *  members are zch2.1.3's, since nothing here creates a foreign element. */
const SPECIAL = new Set([
  'address', 'applet', 'area', 'article', 'aside', 'base', 'basefont', 'bgsound',
  'blockquote', 'body', 'br', 'button', 'caption', 'center', 'col', 'colgroup', 'dd',
  'details', 'dir', 'div', 'dl', 'dt', 'embed', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
  'header', 'hgroup', 'hr', 'html', 'iframe', 'img', 'input', 'keygen', 'li', 'link',
  'listing', 'main', 'marquee', 'menu', 'meta', 'nav', 'noembed', 'noframes', 'noscript',
  'object', 'ol', 'p', 'param', 'plaintext', 'pre', 'script', 'search', 'section',
  'select', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'template', 'textarea',
  'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul', 'wbr', 'xmp',
]);

/** The foreign members of the special category, as `ns:name`. */
const SPECIAL_FOREIGN = new Set([
  'math:mi', 'math:mo', 'math:mn', 'math:ms', 'math:mtext', 'math:annotation-xml',
  'svg:foreignObject', 'svg:desc', 'svg:title',
]);

/** §13.2.4.2's special category, namespace-aware for the reason htmlstack.ts
 *  records about its scope terminators: an SVG `title` is special and so is an
 *  HTML `<title>`, but MathML `mi` is special while an HTML `<mi>` is not. A
 *  name-only test is wrong in BOTH directions, and what it breaks is the
 *  adoption agency's choice of furthest block — a mis-nested tree that still
 *  renders rather than anything that fails. */
function isSpecial(el: HtmlElement): boolean {
  return el.ns === 'html' ? SPECIAL.has(el.name) : SPECIAL_FOREIGN.has(`${el.ns}:${el.name}`);
}

/** The block-level start tags that close an open <p> in button scope. */
const BLOCK_TAGS = [
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir',
  'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'header', 'hgroup', 'main',
  'menu', 'nav', 'ol', 'p', 'search', 'section', 'summary', 'ul',
];

/** The end tags handled by the same rule. Not the same list as the start tags:
 *  it adds `button`, `listing`, `pre` and — since the customizable-select
 *  change — `select`, none of which has a matching start-tag entry there. */
const BLOCK_END_TAGS = [
  ...BLOCK_TAGS, 'button', 'listing', 'pre', 'select',
];

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

/** §13.2.6.4.7's implied end tags. The "thoroughly" variant excludes NOTHING
 *  but adds the table-section tags — one used for both is a subtle difference
 *  in what survives a </p>. */
const IMPLIED_END = [
  'dd', 'dt', 'li', 'optgroup', 'option', 'p', 'rb', 'rp', 'rt', 'rtc',
];
const IMPLIED_END_THOROUGH = [
  ...IMPLIED_END, 'caption', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
];

// ---- §13.2.6.4.1 quirks-mode doctype rules --------------------------------

const QUIRKS_PUBLIC_IDS = [
  '-//W3O//DTD W3 HTML Strict 3.0//EN//',
  '-/W3C/DTD HTML 4.0 Transitional/EN',
  'HTML',
].map((s) => s.toLowerCase());

const QUIRKS_SYSTEM_ID = 'http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd';

const QUIRKS_PUBLIC_PREFIXES = [
  '+//Silmaril//dtd html Pro v0r11 19970101//',
  '-//AS//DTD HTML 3.0 asWedit + extensions//',
  '-//AdvaSoft Ltd//DTD HTML 3.0 asWedit + extensions//',
  '-//IETF//DTD HTML 2.0 Level 1//',
  '-//IETF//DTD HTML 2.0 Level 2//',
  '-//IETF//DTD HTML 2.0 Strict Level 1//',
  '-//IETF//DTD HTML 2.0 Strict Level 2//',
  '-//IETF//DTD HTML 2.0 Strict//',
  '-//IETF//DTD HTML 2.0//',
  '-//IETF//DTD HTML 2.1E//',
  '-//IETF//DTD HTML 3.0//',
  '-//IETF//DTD HTML 3.2 Final//',
  '-//IETF//DTD HTML 3.2//',
  '-//IETF//DTD HTML 3//',
  '-//IETF//DTD HTML Level 0//',
  '-//IETF//DTD HTML Level 1//',
  '-//IETF//DTD HTML Level 2//',
  '-//IETF//DTD HTML Level 3//',
  '-//IETF//DTD HTML Strict Level 0//',
  '-//IETF//DTD HTML Strict Level 1//',
  '-//IETF//DTD HTML Strict Level 2//',
  '-//IETF//DTD HTML Strict Level 3//',
  '-//IETF//DTD HTML Strict//',
  '-//IETF//DTD HTML//',
  '-//Metrius//DTD Metrius Presentational//',
  '-//Microsoft//DTD Internet Explorer 2.0 HTML Strict//',
  '-//Microsoft//DTD Internet Explorer 2.0 HTML//',
  '-//Microsoft//DTD Internet Explorer 2.0 Tables//',
  '-//Microsoft//DTD Internet Explorer 3.0 HTML Strict//',
  '-//Microsoft//DTD Internet Explorer 3.0 HTML//',
  '-//Microsoft//DTD Internet Explorer 3.0 Tables//',
  '-//Netscape Comm. Corp.//DTD HTML//',
  '-//Netscape Comm. Corp.//DTD Strict HTML//',
  "-//O'Reilly and Associates//DTD HTML 2.0//",
  "-//O'Reilly and Associates//DTD HTML Extended 1.0//",
  "-//O'Reilly and Associates//DTD HTML Extended Relaxed 1.0//",
  '-//SQ//DTD HTML 2.0 HoTMetaL + extensions//',
  '-//SoftQuad Software//DTD HoTMetaL PRO 6.0::19990601::extensions to HTML 4.0//',
  '-//SoftQuad//DTD HoTMetaL PRO 4.0::19971010::extensions to HTML 4.0//',
  '-//Spyglass//DTD HTML 2.0 Extended//',
  '-//Sun Microsystems Corp.//DTD HotJava HTML//',
  '-//Sun Microsystems Corp.//DTD HotJava Strict HTML//',
  '-//W3C//DTD HTML 3 1995-03-24//',
  '-//W3C//DTD HTML 3.2 Draft//',
  '-//W3C//DTD HTML 3.2 Final//',
  '-//W3C//DTD HTML 3.2//',
  '-//W3C//DTD HTML 3.2S Draft//',
  '-//W3C//DTD HTML 4.0 Frameset//',
  '-//W3C//DTD HTML 4.0 Transitional//',
  '-//W3C//DTD HTML Experimental 19960712//',
  '-//W3C//DTD HTML Experimental 970421//',
  '-//W3C//DTD W3 HTML//',
  '-//W3O//DTD W3 HTML 3.0//',
  '-//WebTechs//DTD Mozilla HTML 2.0//',
  '-//WebTechs//DTD Mozilla HTML//',
].map((s) => s.toLowerCase());

const HTML401_PREFIXES = [
  '-//W3C//DTD HTML 4.01 Frameset//',
  '-//W3C//DTD HTML 4.01 Transitional//',
].map((s) => s.toLowerCase());

function isWhitespace(ch: string): boolean {
  return ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r' || ch === ' ';
}

/** Where a node goes: a parent plus an optional reference child to insert
 *  before. Foster parenting is the only thing that produces a `before`. */
interface InsertLocation {
  parent: HtmlParent;
  before?: HtmlNode;
}

class TreeBuilder {
  readonly document: HtmlDocument = createDocument();

  private mode: Mode = Mode.Initial;
  /** ONE variable, not a stack — the spec says so, and a stack behaves
   *  identically until a document nests the constructs that expose it. */
  private originalMode: Mode = Mode.Initial;
  /** The template insertion modes. A STACK where originalMode is one
   *  variable, and the difference is real: a template can nest inside a table
   *  cell inside another template, and each level has to remember what it was
   *  doing. template.dat#33 is the only vendored case that can tell them apart. */
  private readonly templateModes: Mode[] = [];
  private readonly open = new OpenElements();
  private readonly formatting = new ActiveFormatting();
  private readonly tokenizer: HtmlTokenizer;

  /** §13.4's "fragment context element", undefined for a document parse. */
  private fragmentContextElement: HtmlElement | undefined;
  private headElement: HtmlElement | undefined;
  private formElement: HtmlElement | undefined;
  private framesetOk = true;
  private fosterParenting = false;
  private stopped = false;
  /** A <pre>, <listing> or <textarea> start tag swallows one following LF.
   *  That is TREE construction's job — the tokenizer emits it normally. */
  private ignoreNextLf = false;

  /** Buffered characters for InTableText. */
  private pendingTableChars: string[] = [];
  private pendingTableCharsNonWhitespace = false;

  /** The encoding this parse is running under while its confidence is still
   *  TENTATIVE, and `undefined` once it is certain — which is what `parseHtml`
   *  always is, since a string has no encoding left to be wrong about. Only a
   *  tentative parse can have its encoding changed out from under it, so this
   *  being undefined is what keeps the string path byte-identical. */
  private tentativeEncoding: string | undefined;

  /** Set by the in-head `<meta>` rule when the document declares an encoding
   *  that contradicts the tentative one. `parseHtmlBytes` reads it and parses
   *  again; nothing else in this module consults it. */
  private encodingChangeTo: string | undefined;

  /** §13.2.3.3's requested encoding, or undefined if the parse ran to its end
   *  without one being asked for. */
  get requestedEncoding(): string | undefined { return this.encodingChangeTo; }

  constructor(src: string, context?: FragmentContext, tentativeEncoding?: string) {
    this.tentativeEncoding = tentativeEncoding;
    this.tokenizer = new HtmlTokenizer(src, {
      adjustedCurrentNodeIsForeign: () => {
        const node = this.adjustedCurrentNode();
        return node !== undefined && node.ns !== 'html';
      },
    });
    if (context !== undefined) this.setUpFragment(context);
  }

  /** §13.4 steps 2 through 12. The context element is NEVER pushed onto the
   *  stack — the synthetic `html` root is the whole stack — which is why the
   *  context's own end tag closes nothing. */
  private setUpFragment(context: FragmentContext): void {
    this.fragmentContextElement =
      createElement(context.name, undefined, context.ns ?? 'html');
    const root = createElement('html');
    appendChild(this.document, root);
    this.open.push(root);

    if (context.ns === undefined) {
      switch (context.name) {
        case 'title': case 'textarea':
          this.tokenizer.setState(TokenizerState.RCDATA); break;
        case 'style': case 'xmp': case 'iframe': case 'noembed': case 'noframes':
          this.tokenizer.setState(TokenizerState.RAWTEXT); break;
        case 'script':
          this.tokenizer.setState(TokenizerState.ScriptData); break;
        case 'plaintext':
          this.tokenizer.setState(TokenizerState.PLAINTEXT); break;
        // `noscript` is deliberately absent: it takes RAWTEXT only when
        // scripting is ENABLED, and ours is off.
        default: break;
      }
      if (context.name === 'template') this.templateModes.push(Mode.InTemplate);
    }

    this.resetInsertionMode();

    // Unreachable from the corpus: a .dat context element is synthesized with
    // no ancestors, so this always finds nothing. Implemented because §13.4
    // says so and a caller passing a real element would need it.
    for (let n: HtmlNode | null = this.fragmentContextElement; n !== null; n = n.parent) {
      if (n.kind === 'element' && n.ns === 'html' && n.name === 'form') {
        this.formElement = n;
        break;
      }
    }
  }

  parseFragment(): HtmlFragment {
    this.parse();
    const root = this.open.items[0] ?? this.document.children[0];
    const frag = createFragment();
    if (root !== undefined && (root.kind === 'element' || root.kind === 'document')) {
      for (const child of [...root.children]) appendChild(frag, child as HtmlChild);
    }
    return frag;
  }

  /** §13.2.3.3. A parse whose confidence is certain — every `parseHtml` call,
   *  and the second pass of a `parseHtmlBytes` one — ignores the declaration
   *  outright, which is what keeps the string path byte-identical.
   *
   *  Where a browser would abort the navigation and start over, we record what
   *  was asked for and stop; `parseHtmlBytes` decodes again and reparses. The
   *  two are equivalent because the first parse's output is discarded either
   *  way. */
  private changeEncoding(attrs: Map<string, string>): void {
    if (this.tentativeEncoding === undefined) return;
    const found = metaEncoding(attrs);
    if (found === undefined) return;
    // Step 3: a declaration naming the encoding already in force does not
    // merely change nothing, it SETTLES the question — so a later, different
    // meta cannot restart a parse this one has already vouched for.
    if (found === this.tentativeEncoding) { this.tentativeEncoding = undefined; return; }
    this.encodingChangeTo = found;
    this.stopped = true;
  }

  parse(): HtmlDocument {
    for (;;) {
      const token = this.tokenizer.next();
      if (this.ignoreNextLf) {
        this.ignoreNextLf = false;
        if (token.kind === 'character' && token.data === '\n') continue;
      }
      this.dispatch(token);
      if (token.kind === 'eof' || this.stopped) return this.document;
    }
  }

  // ---- dispatch -----------------------------------------------------------

  /** §13.2.6's branch, which runs BEFORE the insertion-mode switch: HTML rules
   *  apply at the top of the document, in an HTML element, at an integration
   *  point, and at EOF — otherwise the foreign rules do. */
  private dispatch(t: HtmlToken): void {
    if (this.useHtmlRules(t)) this.dispatchHtml(t);
    else this.foreign(t);
  }

  private useHtmlRules(t: HtmlToken): boolean {
    const node = this.adjustedCurrentNode();
    if (node === undefined) return true;
    if (node.ns === 'html') return true;
    if (t.kind === 'eof') return true;
    if (isMathmlTextIntegrationPoint(node)) {
      if (t.kind === 'character') return true;
      if (t.kind === 'startTag' && t.name !== 'mglyph' && t.name !== 'malignmark') return true;
    }
    if (node.ns === 'math' && node.name === 'annotation-xml'
      && t.kind === 'startTag' && t.name === 'svg') return true;
    if (isHtmlIntegrationPoint(node) && (t.kind === 'startTag' || t.kind === 'character')) {
      return true;
    }
    return false;
  }

  private dispatchHtml(t: HtmlToken): void {
    switch (this.mode) {
      case Mode.Initial: this.initial(t); break;
      case Mode.BeforeHtml: this.beforeHtml(t); break;
      case Mode.BeforeHead: this.beforeHead(t); break;
      case Mode.InHead: this.inHead(t); break;
      case Mode.InHeadNoscript: this.inHeadNoscript(t); break;
      case Mode.AfterHead: this.afterHead(t); break;
      case Mode.InBody: this.inBody(t); break;
      case Mode.Text: this.text(t); break;
      case Mode.InTable: this.inTable(t); break;
      case Mode.InTableText: this.inTableText(t); break;
      case Mode.InCaption: this.inCaption(t); break;
      case Mode.InColumnGroup: this.inColumnGroup(t); break;
      case Mode.InTableBody: this.inTableBody(t); break;
      case Mode.InRow: this.inRow(t); break;
      case Mode.InCell: this.inCell(t); break;
      case Mode.InTemplate: this.inTemplate(t); break;
      case Mode.AfterBody: this.afterBody(t); break;
      case Mode.InFrameset: this.inFrameset(t); break;
      case Mode.AfterFrameset: this.afterFrameset(t); break;
      case Mode.AfterAfterBody: this.afterAfterBody(t); break;
      case Mode.AfterAfterFrameset: this.afterAfterFrameset(t); break;
      default: break;
    }
  }

  // ---- §13.2.6.1 inserting nodes -----------------------------------------

  /** "The appropriate place for inserting a node". Foster parenting is the
   *  whole reason this is not simply "the current node": stray content in a
   *  table lands BEFORE the table, never inside it. Wrong, it still displays,
   *  which is why the rule needs its own fixture. */
  private insertionLocation(overrideTarget?: HtmlElement): InsertLocation {
    const target = overrideTarget ?? this.open.current;
    if (target === undefined) return { parent: this.document };

    const fosterable = target.ns === 'html'
      && (target.name === 'table' || target.name === 'tbody'
        || target.name === 'tfoot' || target.name === 'thead' || target.name === 'tr');
    if (!this.fosterParenting || !fosterable) return this.underTemplate(target);

    let last: HtmlElement | undefined;
    let lastIndex = -1;
    for (let i = this.open.items.length - 1; i >= 0; i--) {
      const el = this.open.items[i] as HtmlElement;
      if (el.ns === 'html' && (el.name === 'template' || el.name === 'table')) {
        last = el;
        lastIndex = i;
        break;
      }
    }
    if (last === undefined) {
      const root = this.open.items[0];
      return root === undefined ? { parent: this.document } : this.underTemplate(root);
    }
    if (last.name === 'template') return this.underTemplate(last);

    const parent = last.parent;
    // A fragment counts: the last table's parent is a template's content
    // whenever that table was opened inside a template.
    if (parent !== null && (parent.kind === 'element' || parent.kind === 'document'
      || parent.kind === 'fragment')) {
      return { parent, before: last };
    }
    const above = this.open.items[lastIndex - 1];
    return above === undefined ? { parent: this.document } : this.underTemplate(above);
  }

  /** The last clause of "the appropriate place for inserting a node": a
   *  template's children go in its CONTENT FRAGMENT. Its own children array
   *  stays empty for the life of the parse.
   *
   *  Factored out rather than run once at the end because the foster block has
   *  four exits and three of them can land on a template; writing it once at
   *  the end would need a reassignable target across those exits, and the
   *  "last's parent" exit legitimately yields a DOCUMENT, which is not an
   *  HtmlElement. */
  private underTemplate(el: HtmlElement): InsertLocation {
    if (el.ns === 'html' && el.name === 'template' && el.content !== undefined) {
      return { parent: el.content };
    }
    return { parent: el };
  }

  private insertNode(node: HtmlChild, at: InsertLocation): void {
    if (at.before !== undefined) insertBefore(at.parent, node, at.before);
    else appendChild(at.parent, node);
  }

  /** "Insert a character": append to the text node already at the insertion
   *  point when there is one, so a run of character tokens becomes one node. */
  private insertCharacter(data: string): void {
    const at = this.insertionLocation();
    const siblings = at.parent.children;
    let index = siblings.length;
    if (at.before !== undefined) {
      const found = siblings.indexOf(at.before);
      if (found >= 0) index = found;
    }
    const prev = siblings[index - 1];
    if (prev !== undefined && prev.kind === 'text') { prev.data += data; return; }
    this.insertNode(createText(data), at);
  }

  private insertCommentLike(t: CommentLike, at?: InsertLocation): void {
    this.insertNode(commentLikeNode(t), at ?? this.insertionLocation());
  }

  private createElementFor(
    name: string, attrs: Map<string, string>, ns: HtmlNamespace = 'html',
  ): HtmlElement {
    return createElement(name, new Map(attrs), ns);
  }

  private insertElement(
    name: string, attrs: Map<string, string>, ns: HtmlNamespace = 'html',
  ): HtmlElement {
    const el = this.createElementFor(name, attrs, ns);
    this.insertNode(el, this.insertionLocation());
    this.open.push(el);
    return el;
  }

  private insertElementForToken(t: HtmlToken & { kind: 'startTag' }): HtmlElement {
    return this.insertElement(t.name, t.attrs);
  }

  /** §13.2.6.4.7's "if the parser's fragment context element is a select
   *  element" guard on the `input` and `select` start tags. Unreachable for a
   *  document parse, since a select context can only come from §13.4. */
  private fragmentContextIsSelect(): boolean {
    const ctx = this.fragmentContextElement;
    return ctx !== undefined && ctx.ns === 'html' && ctx.name === 'select';
  }

  private hasTemplateOpen(): boolean {
    return this.open.items.some((e) => e.ns === 'html' && e.name === 'template');
  }

  /** §13.2.4.2. The fragment CONTEXT element when the stack of open elements
   *  holds exactly ONE element, and the current node otherwise.
   *
   *  This returned the current node from zch2.1.3.1 until fragments existed,
   *  named correctly on purpose so this issue would not have to find its call
   *  sites. The difference is the whole foreign-fragment group: with the
   *  alias, `<nobr>X` in an `svg path` context is inserted by "in body" as an
   *  HTML element instead of being parsed as foreign content. */
  private adjustedCurrentNode(): HtmlElement | undefined {
    if (this.fragmentContextElement !== undefined && this.open.items.length === 1) {
      return this.fragmentContextElement;
    }
    return this.open.current;
  }

  // ---- §13.2.4.3 reconstruction ------------------------------------------

  /** "Reconstruct the active formatting elements". Miss it and formatting
   *  silently stops at the boundary where it should re-open. */
  private reconstructFormatting(): void {
    const items = this.formatting.items;
    if (items.length === 0) return;
    const last = items[items.length - 1];
    if (last === null || last === undefined) return;
    if (this.open.contains(last)) return;

    let i = items.length - 1;
    for (;;) {
      if (i === 0) break;
      i--;
      const entry = items[i];
      if (entry === null || entry === undefined || this.open.contains(entry)) { i++; break; }
    }
    for (; i < items.length; i++) {
      const entry = items[i] as HtmlElement;
      const fresh = this.insertElement(entry.name, entry.attrs);
      items[i] = fresh;
    }
  }

  // ---- implied end tags ---------------------------------------------------

  private generateImpliedEndTags(except?: string): void {
    for (;;) {
      const cur = this.open.current;
      if (cur === undefined) return;
      if (cur.ns !== 'html') return;
      if (cur.name === except) return;
      if (!IMPLIED_END.includes(cur.name)) return;
      this.open.pop();
    }
  }

  /** Deliberately unreached today: `</template>` is the spec's ONLY call site
   *  for the thorough variant, and templates are zch2.1.3. It ships anyway
   *  because the pair is what makes the distinction legible — measured, using
   *  the thorough list for both reddens 83 vendored cases. */
  private generateImpliedEndTagsThoroughly(): void {
    for (;;) {
      const cur = this.open.current;
      if (cur === undefined) return;
      if (cur.ns !== 'html' || !IMPLIED_END_THOROUGH.includes(cur.name)) return;
      this.open.pop();
    }
  }

  private closeP(): void {
    this.generateImpliedEndTags('p');
    this.open.popUntilName('p');
  }

  // ---- §13.2.6.2 reset the insertion mode --------------------------------

  private resetInsertionMode(): void {
    for (let i = this.open.items.length - 1; i >= 0; i--) {
      let node = this.open.items[i] as HtmlElement;
      const last = i === 0;
      // Fragment case: at the BOTTOM of the stack the algorithm reasons about
      // the context element, not the synthetic html root.
      if (last && this.fragmentContextElement !== undefined) {
        node = this.fragmentContextElement;
      }
      // Note there is NO `select` branch: the current spec's reset algorithm
      // has none, because "in select" is not an insertion mode any more.
      switch (node.name) {
        case 'td':
        case 'th':
          if (!last) { this.mode = Mode.InCell; return; }
          break;
        case 'tr': this.mode = Mode.InRow; return;
        case 'tbody':
        case 'thead':
        case 'tfoot': this.mode = Mode.InTableBody; return;
        case 'caption': this.mode = Mode.InCaption; return;
        case 'colgroup': this.mode = Mode.InColumnGroup; return;
        case 'table': this.mode = Mode.InTable; return;
        case 'template': {
          const mode = this.templateModes[this.templateModes.length - 1];
          if (mode !== undefined) { this.mode = mode; return; }
          break;
        }
        case 'head':
          if (!last) { this.mode = Mode.InHead; return; }
          break;
        case 'body': this.mode = Mode.InBody; return;
        case 'frameset': this.mode = Mode.InFrameset; return;
        case 'html':
          this.mode = this.headElement === undefined ? Mode.BeforeHead : Mode.AfterHead;
          return;
        default: break;
      }
      if (last) { this.mode = Mode.InBody; return; }
    }
    this.mode = Mode.InBody;
  }

  // ---- generic element parsing algorithms --------------------------------

  private genericRawText(t: HtmlToken & { kind: 'startTag' }): void {
    this.insertElementForToken(t);
    this.tokenizer.setState(TokenizerState.RAWTEXT);
    this.originalMode = this.mode;
    this.mode = Mode.Text;
  }

  private genericRcdata(t: HtmlToken & { kind: 'startTag' }): void {
    this.insertElementForToken(t);
    this.tokenizer.setState(TokenizerState.RCDATA);
    this.originalMode = this.mode;
    this.mode = Mode.Text;
  }

  // ---- §13.2.6.4.1 Initial -----------------------------------------------

  private initial(t: HtmlToken): void {
    if (t.kind === 'character') {
      if (isWhitespace(t.data)) return;
    } else if (isCommentLike(t)) {
      appendChild(this.document, commentLikeNode(t));
      return;
    } else if (t.kind === 'doctype') {
      const name = t.name ?? '';
      const publicId = t.publicId ?? '';
      const systemId = t.systemId ?? '';
      appendChild(this.document, createDoctype(name, publicId, systemId));
      this.document.quirks = quirksFor(t.forceQuirks, name, t.publicId, t.systemId);
      this.mode = Mode.BeforeHtml;
      return;
    }
    this.document.quirks = true;
    this.mode = Mode.BeforeHtml;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.2 BeforeHtml --------------------------------------------

  private beforeHtml(t: HtmlToken): void {
    if (t.kind === 'doctype') return;
    if (isCommentLike(t)) { appendChild(this.document, commentLikeNode(t)); return; }
    if (t.kind === 'character' && isWhitespace(t.data)) return;
    if (t.kind === 'startTag' && t.name === 'html') {
      const el = this.createElementFor('html', t.attrs);
      appendChild(this.document, el);
      this.open.push(el);
      this.mode = Mode.BeforeHead;
      return;
    }
    if (t.kind === 'endTag' && !['head', 'body', 'html', 'br'].includes(t.name)) return;
    const el = createElement('html');
    appendChild(this.document, el);
    this.open.push(el);
    this.mode = Mode.BeforeHead;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.3 BeforeHead --------------------------------------------

  private beforeHead(t: HtmlToken): void {
    if (t.kind === 'character' && isWhitespace(t.data)) return;
    if (isCommentLike(t)) { this.insertCommentLike(t); return; }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag' && t.name === 'html') { this.inBody(t); return; }
    if (t.kind === 'startTag' && t.name === 'head') {
      this.headElement = this.insertElementForToken(t);
      this.mode = Mode.InHead;
      return;
    }
    if (t.kind === 'endTag' && !['head', 'body', 'html', 'br'].includes(t.name)) return;
    this.headElement = this.insertElement('head', new Map());
    this.mode = Mode.InHead;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.4 InHead -------------------------------------------------

  private inHead(t: HtmlToken): void {
    if (t.kind === 'character' && isWhitespace(t.data)) { this.insertCharacter(t.data); return; }
    if (isCommentLike(t)) { this.insertCommentLike(t); return; }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag') {
      switch (t.name) {
        case 'html': this.inBody(t); return;
        case 'base': case 'basefont': case 'bgsound': case 'link': case 'meta':
          this.insertElementForToken(t);
          this.open.pop();
          // §13.2.3.3's "change the encoding". Every other insertion mode
          // that admits a <meta> redirects here — "in body" included, which
          // the spec spells out — so this one site covers them all.
          if (t.name === 'meta') this.changeEncoding(t.attrs);
          return;
        case 'title': this.genericRcdata(t); return;
        case 'noframes': case 'style': this.genericRawText(t); return;
        // The scripting flag is off, so <noscript> in head takes the parsed
        // branch rather than the RAWTEXT one.
        case 'noscript':
          this.insertElementForToken(t);
          this.mode = Mode.InHeadNoscript;
          return;
        case 'script':
          this.insertElementForToken(t);
          this.tokenizer.setState(TokenizerState.ScriptData);
          this.originalMode = this.mode;
          this.mode = Mode.Text;
          return;
        // The COLLAPSED form. The spec's other eleven steps are declarative
        // shadow DOM, gated on "allow declarative shadow roots", which is
        // false for anything that is not a browser — and its own first
        // sub-step then says "insert an HTML element for the token and
        // return", which is exactly this.
        case 'template': {
          this.formatting.pushMarker();
          this.framesetOk = false;
          this.mode = Mode.InTemplate;
          this.templateModes.push(Mode.InTemplate);
          const el = this.insertElementForToken(t);
          el.content = createFragment();
          return;
        }
        case 'head': return;
        default: break;
      }
    }
    if (t.kind === 'endTag') {
      if (t.name === 'head') { this.open.pop(); this.mode = Mode.AfterHead; return; }
      // Collapsed likewise: the spec's insertion-target unwind is null unless
      // something reads a template's `for` attribute, and nothing does.
      if (t.name === 'template') {
        if (!this.hasTemplateOpen()) return;
        this.generateImpliedEndTagsThoroughly();
        this.open.popUntilName('template');
        this.formatting.clearToLastMarker();
        this.templateModes.pop();
        this.resetInsertionMode();
        return;
      }
      if (!['body', 'html', 'br'].includes(t.name)) return;
    }
    this.open.pop();
    this.mode = Mode.AfterHead;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.5 InHeadNoscript ----------------------------------------

  private inHeadNoscript(t: HtmlToken): void {
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag' && t.name === 'html') { this.inBody(t); return; }
    if (t.kind === 'endTag' && t.name === 'noscript') {
      this.open.pop();
      this.mode = Mode.InHead;
      return;
    }
    if ((t.kind === 'character' && isWhitespace(t.data)) || isCommentLike(t)) {
      this.inHead(t);
      return;
    }
    if (t.kind === 'startTag'
      && ['basefont', 'bgsound', 'link', 'meta', 'noframes', 'style'].includes(t.name)) {
      this.inHead(t);
      return;
    }
    if (t.kind === 'startTag' && (t.name === 'head' || t.name === 'noscript')) return;
    if (t.kind === 'endTag' && t.name !== 'br') return;
    this.open.pop();
    this.mode = Mode.InHead;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.6 AfterHead ---------------------------------------------

  private afterHead(t: HtmlToken): void {
    if (t.kind === 'character' && isWhitespace(t.data)) { this.insertCharacter(t.data); return; }
    if (isCommentLike(t)) { this.insertCommentLike(t); return; }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag') {
      switch (t.name) {
        case 'html': this.inBody(t); return;
        case 'body':
          this.insertElementForToken(t);
          this.framesetOk = false;
          this.mode = Mode.InBody;
          return;
        case 'frameset':
          this.insertElementForToken(t);
          this.mode = Mode.InFrameset;
          return;
        case 'base': case 'basefont': case 'bgsound': case 'link': case 'meta':
        case 'noframes': case 'script': case 'style': case 'template': case 'title': {
          const head = this.headElement;
          if (head !== undefined) this.open.push(head);
          this.inHead(t);
          if (head !== undefined) this.open.remove(head);
          return;
        }
        case 'head': return;
        default: break;
      }
    }
    if (t.kind === 'endTag') {
      if (t.name === 'template') { this.inHead(t); return; }
      if (!['body', 'html', 'br'].includes(t.name)) return;
    }
    this.insertElement('body', new Map());
    this.mode = Mode.InBody;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.7 InBody -------------------------------------------------

  private inBody(t: HtmlToken): void {
    switch (t.kind) {
      case 'character':
        if (t.data === '\u0000') return;
        this.reconstructFormatting();
        this.insertCharacter(t.data);
        if (!isWhitespace(t.data)) this.framesetOk = false;
        return;
      case 'comment': case 'pi': this.insertCommentLike(t); return;
      case 'doctype': return;
      // The ONE place outside "in template" that consults the template mode
      // stack, and the whole reason an unclosed <template> still gets a
      // <body>: "in template" redirects nearly every start tag to "in body",
      // so by EOF the insertion mode is usually InBody rather than
      // InTemplate, and without this clause the EOF stops parsing where the
      // template unwind should have run.
      case 'eof':
        if (this.templateModes.length > 0) { this.inTemplate(t); return; }
        this.stopped = true;
        return;
      case 'startTag': this.inBodyStartTag(t); return;
      case 'endTag': this.inBodyEndTag(t); return;
      default: return;
    }
  }

  private inBodyStartTag(t: HtmlToken & { kind: 'startTag' }): void {
    const name = t.name;
    switch (name) {
      case 'html': {
        if (this.hasTemplateOpen()) return;
        const top = this.open.items[0];
        if (top !== undefined) {
          for (const [k, v] of t.attrs) if (!top.attrs.has(k)) top.attrs.set(k, v);
        }
        return;
      }
      case 'base': case 'basefont': case 'bgsound': case 'link': case 'meta':
      case 'noframes': case 'script': case 'style': case 'template': case 'title':
        this.inHead(t);
        return;
      case 'body': {
        const body = this.open.items[1];
        if (this.open.items.length === 1 || body === undefined || body.name !== 'body') return;
        if (this.hasTemplateOpen()) return;
        this.framesetOk = false;
        for (const [k, v] of t.attrs) if (!body.attrs.has(k)) body.attrs.set(k, v);
        return;
      }
      case 'frameset': {
        const body = this.open.items[1];
        if (this.open.items.length === 1 || body === undefined || body.name !== 'body') return;
        if (!this.framesetOk) return;
        removeChild(body);
        while (this.open.items.length > 1) this.open.pop();
        this.insertElementForToken(t);
        this.mode = Mode.InFrameset;
        return;
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        if (this.open.hasInScope('p', 'button')) this.closeP();
        const cur = this.open.current;
        if (cur !== undefined && HEADINGS.includes(cur.name)) this.open.pop();
        this.insertElementForToken(t);
        return;
      }
      case 'pre': case 'listing':
        if (this.open.hasInScope('p', 'button')) this.closeP();
        this.insertElementForToken(t);
        this.ignoreNextLf = true;
        this.framesetOk = false;
        return;
      case 'form': {
        if (this.formElement !== undefined) return;
        if (this.open.hasInScope('p', 'button')) this.closeP();
        this.formElement = this.insertElementForToken(t);
        return;
      }
      case 'li': {
        this.framesetOk = false;
        for (let i = this.open.items.length - 1; i >= 0; i--) {
          const node = this.open.items[i] as HtmlElement;
          if (node.ns === 'html' && node.name === 'li') {
            this.generateImpliedEndTags('li');
            this.open.popUntilName('li');
            break;
          }
          if (isSpecial(node)
            && node.name !== 'address' && node.name !== 'div' && node.name !== 'p') break;
        }
        if (this.open.hasInScope('p', 'button')) this.closeP();
        this.insertElementForToken(t);
        return;
      }
      case 'dd': case 'dt': {
        this.framesetOk = false;
        for (let i = this.open.items.length - 1; i >= 0; i--) {
          const node = this.open.items[i] as HtmlElement;
          if (node.ns === 'html' && (node.name === 'dd' || node.name === 'dt')) {
            this.generateImpliedEndTags(node.name);
            this.open.popUntilName(node.name);
            break;
          }
          if (isSpecial(node)
            && node.name !== 'address' && node.name !== 'div' && node.name !== 'p') break;
        }
        if (this.open.hasInScope('p', 'button')) this.closeP();
        this.insertElementForToken(t);
        return;
      }
      case 'plaintext':
        if (this.open.hasInScope('p', 'button')) this.closeP();
        this.insertElementForToken(t);
        this.tokenizer.setState(TokenizerState.PLAINTEXT);
        return;
      case 'button': {
        if (this.open.hasInScope('button')) {
          this.generateImpliedEndTags();
          this.open.popUntilName('button');
        }
        this.reconstructFormatting();
        this.insertElementForToken(t);
        this.framesetOk = false;
        return;
      }
      case 'a': {
        const existing = this.formatting.lastBetweenMarkerAndEnd('a');
        if (existing !== undefined) {
          this.adoptionAgency('a');
          this.formatting.remove(existing);
          this.open.remove(existing);
        }
        this.reconstructFormatting();
        this.formatting.push(this.insertElementForToken(t));
        return;
      }
      case 'b': case 'big': case 'code': case 'em': case 'font': case 'i': case 's':
      case 'small': case 'strike': case 'strong': case 'tt': case 'u':
        this.reconstructFormatting();
        this.formatting.push(this.insertElementForToken(t));
        return;
      case 'nobr': {
        this.reconstructFormatting();
        if (this.open.hasInScope('nobr')) {
          this.adoptionAgency('nobr');
          this.reconstructFormatting();
        }
        this.formatting.push(this.insertElementForToken(t));
        return;
      }
      case 'applet': case 'marquee': case 'object':
        this.reconstructFormatting();
        this.insertElementForToken(t);
        this.formatting.pushMarker();
        this.framesetOk = false;
        return;
      case 'table':
        if (!this.document.quirks && this.open.hasInScope('p', 'button')) this.closeP();
        this.insertElementForToken(t);
        this.framesetOk = false;
        this.mode = Mode.InTable;
        return;
      case 'area': case 'br': case 'embed': case 'img': case 'keygen': case 'wbr':
        this.reconstructFormatting();
        this.insertElementForToken(t);
        this.open.pop();
        this.framesetOk = false;
        return;
      case 'input': {
        if (this.fragmentContextIsSelect()) return;
        if (this.open.hasInScope('select')) this.open.popUntilName('select');
        this.reconstructFormatting();
        this.insertElementForToken(t);
        this.open.pop();
        const type = t.attrs.get('type');
        if (type === undefined || type.toLowerCase() !== 'hidden') this.framesetOk = false;
        return;
      }
      case 'param': case 'source': case 'track':
        this.insertElementForToken(t);
        this.open.pop();
        return;
      case 'hr':
        if (this.open.hasInScope('p', 'button')) this.closeP();
        if (this.open.hasInScope('select')) this.generateImpliedEndTags();
        this.insertElementForToken(t);
        this.open.pop();
        this.framesetOk = false;
        return;
      case 'image':
        this.inBodyStartTag({ ...t, name: 'img' });
        return;
      case 'textarea':
        this.insertElementForToken(t);
        this.ignoreNextLf = true;
        this.tokenizer.setState(TokenizerState.RCDATA);
        this.originalMode = this.mode;
        this.framesetOk = false;
        this.mode = Mode.Text;
        return;
      case 'xmp':
        if (this.open.hasInScope('p', 'button')) this.closeP();
        this.reconstructFormatting();
        this.framesetOk = false;
        this.genericRawText(t);
        return;
      case 'iframe':
        this.framesetOk = false;
        this.genericRawText(t);
        return;
      // The scripting flag is off, so <noscript> here is an ordinary element.
      case 'noembed':
        this.genericRawText(t);
        return;
      // A nested <select> CLOSES the open one and inserts nothing — the token
      // is ignored AND the stack is popped through the select, which reads
      // like a contradiction and is what the spec says.
      case 'select': {
        if (this.fragmentContextIsSelect()) return;
        if (this.open.hasInScope('select')) { this.open.popUntilName('select'); return; }
        this.reconstructFormatting();
        this.insertElementForToken(t);
        this.framesetOk = false;
        return;
      }
      case 'option': {
        if (this.open.hasInScope('select')) this.generateImpliedEndTags('optgroup');
        else if (this.open.current?.name === 'option') this.open.pop();
        this.reconstructFormatting();
        this.insertElementForToken(t);
        return;
      }
      case 'optgroup': {
        if (this.open.hasInScope('select')) this.generateImpliedEndTags();
        else if (this.open.current?.name === 'option') this.open.pop();
        this.reconstructFormatting();
        this.insertElementForToken(t);
        return;
      }
      case 'rb': case 'rtc':
        if (this.open.hasInScope('ruby')) this.generateImpliedEndTags();
        this.insertElementForToken(t);
        return;
      case 'rp': case 'rt':
        if (this.open.hasInScope('ruby')) this.generateImpliedEndTags('rtc');
        this.insertElementForToken(t);
        return;
      case 'math': {
        this.reconstructFormatting();
        this.insertForeign(t, 'math', MATHML_ATTRS);
        return;
      }
      case 'svg': {
        this.reconstructFormatting();
        this.insertForeign(t, 'svg', SVG_ATTRS);
        return;
      }
      case 'caption': case 'col': case 'colgroup': case 'frame': case 'head':
      case 'tbody': case 'td': case 'tfoot': case 'th': case 'thead': case 'tr':
        return;
      default: break;
    }
    if (BLOCK_TAGS.includes(name)) {
      if (this.open.hasInScope('p', 'button')) this.closeP();
      this.insertElementForToken(t);
      return;
    }
    this.reconstructFormatting();
    this.insertElementForToken(t);
  }

  private inBodyEndTag(t: HtmlToken & { kind: 'endTag' }): void {
    const name = t.name;
    switch (name) {
      case 'template': this.inHead(t); return;
      case 'body':
        if (!this.open.hasInScope('body')) return;
        this.mode = Mode.AfterBody;
        return;
      case 'html':
        if (!this.open.hasInScope('body')) return;
        this.mode = Mode.AfterBody;
        this.dispatch(t);
        return;
      case 'form': {
        const form = this.formElement;
        this.formElement = undefined;
        if (form === undefined || !this.open.hasElementInScope(form)) return;
        this.generateImpliedEndTags();
        this.open.remove(form);
        return;
      }
      case 'p':
        if (!this.open.hasInScope('p', 'button')) this.insertElement('p', new Map());
        this.closeP();
        return;
      case 'li':
        if (!this.open.hasInScope('li', 'listItem')) return;
        this.generateImpliedEndTags('li');
        this.open.popUntilName('li');
        return;
      case 'dd': case 'dt':
        if (!this.open.hasInScope(name)) return;
        this.generateImpliedEndTags(name);
        this.open.popUntilName(name);
        return;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        if (!this.open.hasOneOfInScope(HEADINGS)) return;
        this.generateImpliedEndTags();
        this.open.popUntilOneOf(HEADINGS);
        return;
      case 'a': case 'b': case 'big': case 'code': case 'em': case 'font': case 'i':
      case 'nobr': case 's': case 'small': case 'strike': case 'strong': case 'tt':
      case 'u':
        this.adoptionAgency(name);
        return;
      case 'applet': case 'marquee': case 'object':
        if (!this.open.hasInScope(name)) return;
        this.generateImpliedEndTags();
        this.open.popUntilName(name);
        this.formatting.clearToLastMarker();
        return;
      case 'br':
        this.inBodyStartTag({ kind: 'startTag', name: 'br', attrs: new Map(), selfClosing: false });
        return;
      default: break;
    }
    if (BLOCK_END_TAGS.includes(name)) {
      if (!this.open.hasInScope(name)) return;
      this.generateImpliedEndTags();
      this.open.popUntilName(name);
      return;
    }
    this.anyOtherEndTag(name);
  }

  /** §13.2.6.4.7's "any other end tag": walk the stack from the top and pop
   *  THROUGH the matching node. A naive pop-until-match differs only on
   *  mis-nested input, which is exactly the input this algorithm exists for. */
  private anyOtherEndTag(name: string): void {
    for (let i = this.open.items.length - 1; i >= 0; i--) {
      const node = this.open.items[i] as HtmlElement;
      if (node.ns === 'html' && node.name === name) {
        this.generateImpliedEndTags(name);
        this.open.popUntilElement(node);
        return;
      }
      if (isSpecial(node)) return;
    }
  }

  // ---- §13.2.6.4.7 the adoption agency algorithm -------------------------

  /** Wrong, the tree is merely mis-nested and still renders — which is why
   *  the algorithm has a name rather than being "handle misnested tags". */
  private adoptionAgency(subject: string): void {
    const cur = this.open.current;
    if (cur !== undefined && cur.ns === 'html' && cur.name === subject
      && !this.formatting.contains(cur)) {
      this.open.pop();
      return;
    }

    for (let outer = 0; outer < 8; outer++) {
      const formattingElement = this.formatting.lastBetweenMarkerAndEnd(subject);
      if (formattingElement === undefined) { this.anyOtherEndTag(subject); return; }
      if (!this.open.contains(formattingElement)) {
        this.formatting.remove(formattingElement);
        return;
      }
      if (!this.open.hasElementInScope(formattingElement)) return;

      const feIndex = this.open.indexOf(formattingElement);
      let furthestBlock: HtmlElement | undefined;
      for (let i = feIndex + 1; i < this.open.items.length; i++) {
        const el = this.open.items[i] as HtmlElement;
        if (isSpecial(el)) { furthestBlock = el; break; }
      }
      if (furthestBlock === undefined) {
        this.open.popUntilElement(formattingElement);
        this.formatting.remove(formattingElement);
        return;
      }

      const commonAncestor = this.open.items[feIndex - 1];
      let bookmark = this.formatting.indexOf(formattingElement);
      let node: HtmlElement | undefined;
      let lastNode = furthestBlock;
      let nodeIndex = this.open.indexOf(furthestBlock);

      for (let inner = 1; ; inner++) {
        nodeIndex--;
        node = this.open.items[nodeIndex];
        if (node === undefined || node === formattingElement) break;
        if (inner > 3 && this.formatting.contains(node)) this.formatting.remove(node);
        if (!this.formatting.contains(node)) {
          this.open.items.splice(nodeIndex, 1);
          continue;
        }
        const fresh = this.createElementFor(node.name, node.attrs);
        this.formatting.replace(node, fresh);
        this.open.items[nodeIndex] = fresh;
        node = fresh;
        if (lastNode === furthestBlock) bookmark = this.formatting.indexOf(node) + 1;
        appendChild(node, lastNode);
        lastNode = node;
      }

      this.insertNode(lastNode, this.insertionLocation(commonAncestor));

      const newElement = this.createElementFor(formattingElement.name, formattingElement.attrs);
      for (const child of [...furthestBlock.children]) {
        appendChild(newElement, child as HtmlChild);
      }
      appendChild(furthestBlock, newElement);

      const oldIndex = this.formatting.indexOf(formattingElement);
      this.formatting.remove(formattingElement);
      if (oldIndex >= 0 && oldIndex < bookmark) bookmark--;
      this.formatting.insertAt(bookmark, newElement);

      this.open.remove(formattingElement);
      const fbIndex = this.open.indexOf(furthestBlock);
      this.open.items.splice(fbIndex + 1, 0, newElement);
    }
  }

  // ---- §13.2.6.4.16 InTemplate --------------------------------------------

  /** Switch to `mode`, making it the current template insertion mode, and
   *  reprocess. Five start-tag groups do exactly this and nothing else. */
  private switchTemplateMode(mode: Mode, t: HtmlToken): void {
    this.templateModes.pop();
    this.templateModes.push(mode);
    this.mode = mode;
    this.dispatch(t);
  }

  private inTemplate(t: HtmlToken): void {
    if (t.kind === 'character' || isCommentLike(t) || t.kind === 'doctype') {
      this.inBody(t);
      return;
    }
    if (t.kind === 'eof') {
      if (!this.hasTemplateOpen()) {
        this.stopped = true;
        return;
      }
      this.open.popUntilName('template');
      this.formatting.clearToLastMarker();
      this.templateModes.pop();
      this.resetInsertionMode();
      this.dispatch(t);
      return;
    }
    if (t.kind === 'startTag') {
      switch (t.name) {
        case 'base': case 'basefont': case 'bgsound': case 'link': case 'meta':
        case 'noframes': case 'script': case 'style': case 'template': case 'title':
          this.inHead(t);
          return;
        case 'caption': case 'colgroup': case 'tbody': case 'tfoot': case 'thead':
          this.switchTemplateMode(Mode.InTable, t);
          return;
        case 'col': this.switchTemplateMode(Mode.InColumnGroup, t); return;
        case 'tr': this.switchTemplateMode(Mode.InTableBody, t); return;
        case 'td': case 'th': this.switchTemplateMode(Mode.InRow, t); return;
        default: this.switchTemplateMode(Mode.InBody, t); return;
      }
    }
    if (t.kind === 'endTag') {
      if (t.name === 'template') this.inHead(t);
      return;
    }
  }

  // ---- §13.2.6.5 the rules for parsing tokens in foreign content ----------

  /** Insert a foreign element for a start tag: adjust its own namespace's
   *  attributes, then the foreign ones, then insert in that namespace. A
   *  self-closing tag pops immediately — this is the ONE place in the parser
   *  where that flag changes a tree, since `<svg/>` is an empty element while
   *  `<svg>` swallows the rest of the document. */
  private insertForeign(
    t: HtmlToken & { kind: 'startTag' },
    ns: HtmlNamespace,
    table: ReadonlyMap<string, string>,
    name = t.name,
  ): HtmlElement {
    const attrs = adjustAttributes(adjustAttributes(t.attrs, table), FOREIGN_ATTRS);
    const el = this.insertElement(name, attrs, ns);
    if (t.selfClosing) this.open.pop();
    return el;
  }

  private foreign(t: HtmlToken): void {
    switch (t.kind) {
      // NOT ignored, unlike "in body": a NUL in foreign content becomes
      // U+FFFD. One `case` label apart, and no rendering reveals it.
      case 'character':
        if (t.data === '\u0000') { this.insertCharacter('\uFFFD'); return; }
        this.insertCharacter(t.data);
        if (!isWhitespace(t.data)) this.framesetOk = false;
        return;
      case 'comment': case 'pi': this.insertCommentLike(t); return;
      case 'doctype': return;
      case 'eof': this.stopped = true; return;
      case 'startTag': this.foreignStartTag(t); return;
      case 'endTag': this.foreignEndTag(t); return;
      default: return;
    }
  }

  private foreignStartTag(t: HtmlToken & { kind: 'startTag' }): void {
    const breaksOut = FOREIGN_BREAKOUT.has(t.name)
      || (t.name === 'font'
        && (t.attrs.has('color') || t.attrs.has('face') || t.attrs.has('size')));
    if (breaksOut) { this.breakOut(t); return; }

    const node = this.adjustedCurrentNode();
    const ns: HtmlNamespace = node?.ns ?? 'html';
    if (ns === 'math') { this.insertForeign(t, 'math', MATHML_ATTRS); return; }
    if (ns === 'svg') {
      this.insertForeign(t, 'svg', SVG_ATTRS, adjustSvgTagName(t.name));
      return;
    }
    this.insertForeign(t, ns, new Map());
  }

  /** Pop until the current node can take HTML content again, then reprocess
   *  in the current insertion mode. */
  private breakOut(t: HtmlToken): void {
    for (;;) {
      const cur = this.open.current;
      if (cur === undefined) break;
      if (cur.ns === 'html') break;
      if (isMathmlTextIntegrationPoint(cur) || isHtmlIntegrationPoint(cur)) break;
      this.open.pop();
    }
    this.dispatchHtml(t);
  }

  private foreignEndTag(t: HtmlToken & { kind: 'endTag' }): void {
    if (t.name === 'br' || t.name === 'p') { this.breakOut(t); return; }
    // The walk compares LOWERCASED names, because a foreign element carries
    // its ADJUSTED spelling (`foreignObject`) while the token carries whatever
    // the author typed.
    //
    // The step order is the spec's and is not the obvious one: "is this the
    // topmost element" is tested BEFORE the name match, so an end tag naming
    // the bottom of the stack returns rather than popping it.
    let i = this.open.items.length - 1;
    for (;;) {
      const node = this.open.items[i];
      if (node === undefined || i === 0) return;
      if (node.name.toLowerCase() === t.name) {
        this.open.popUntilElement(node);
        return;
      }
      i--;
      const next = this.open.items[i];
      if (next === undefined) return;
      if (next.ns === 'html') { this.dispatchHtml(t); return; }
    }
  }

  // ---- §13.2.6.4.8 Text ---------------------------------------------------

  private text(t: HtmlToken): void {
    if (t.kind === 'character') { this.insertCharacter(t.data); return; }
    if (t.kind === 'eof') {
      this.open.pop();
      this.mode = this.originalMode;
      this.dispatch(t);
      return;
    }
    if (t.kind === 'endTag') {
      this.open.pop();
      this.mode = this.originalMode;
    }
  }

  // ---- §13.2.6.4.9 InTable ------------------------------------------------

  private clearStackToTableContext(): void {
    for (;;) {
      const cur = this.open.current;
      if (cur === undefined) return;
      if (cur.name === 'table' || cur.name === 'template' || cur.name === 'html') return;
      this.open.pop();
    }
  }

  private clearStackToTableBodyContext(): void {
    for (;;) {
      const cur = this.open.current;
      if (cur === undefined) return;
      if (['tbody', 'tfoot', 'thead', 'template', 'html'].includes(cur.name)) return;
      this.open.pop();
    }
  }

  private clearStackToTableRowContext(): void {
    for (;;) {
      const cur = this.open.current;
      if (cur === undefined) return;
      if (cur.name === 'tr' || cur.name === 'template' || cur.name === 'html') return;
      this.open.pop();
    }
  }

  private inTable(t: HtmlToken): void {
    const cur = this.open.current;
    if (t.kind === 'character' && cur !== undefined
      && ['table', 'tbody', 'template', 'tfoot', 'thead', 'tr'].includes(cur.name)) {
      this.pendingTableChars = [];
      this.pendingTableCharsNonWhitespace = false;
      this.originalMode = this.mode;
      this.mode = Mode.InTableText;
      this.dispatch(t);
      return;
    }
    if (isCommentLike(t)) { this.insertCommentLike(t); return; }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag') {
      switch (t.name) {
        case 'caption':
          this.clearStackToTableContext();
          this.formatting.pushMarker();
          this.insertElementForToken(t);
          this.mode = Mode.InCaption;
          return;
        case 'colgroup':
          this.clearStackToTableContext();
          this.insertElementForToken(t);
          this.mode = Mode.InColumnGroup;
          return;
        case 'col':
          this.clearStackToTableContext();
          this.insertElement('colgroup', new Map());
          this.mode = Mode.InColumnGroup;
          this.dispatch(t);
          return;
        case 'tbody': case 'tfoot': case 'thead':
          this.clearStackToTableContext();
          this.insertElementForToken(t);
          this.mode = Mode.InTableBody;
          return;
        case 'td': case 'th': case 'tr':
          this.clearStackToTableContext();
          this.insertElement('tbody', new Map());
          this.mode = Mode.InTableBody;
          this.dispatch(t);
          return;
        case 'table':
          if (!this.open.hasInScope('table', 'table')) return;
          this.open.popUntilName('table');
          this.resetInsertionMode();
          this.dispatch(t);
          return;
        case 'style': case 'script': case 'template':
          this.inHead(t);
          return;
        case 'input': {
          const type = t.attrs.get('type');
          if (type !== undefined && type.toLowerCase() === 'hidden') {
            this.insertElementForToken(t);
            this.open.pop();
            return;
          }
          break;
        }
        case 'form': {
          if (this.formElement !== undefined) return;
          this.formElement = this.insertElementForToken(t);
          this.open.pop();
          return;
        }
        default: break;
      }
    }
    if (t.kind === 'endTag') {
      if (t.name === 'table') {
        if (!this.open.hasInScope('table', 'table')) return;
        this.open.popUntilName('table');
        this.resetInsertionMode();
        return;
      }
      if (t.name === 'template') { this.inHead(t); return; }
      if (['body', 'caption', 'col', 'colgroup', 'html', 'tbody', 'td', 'tfoot', 'th',
        'thead', 'tr'].includes(t.name)) return;
    }
    if (t.kind === 'eof') { this.inBody(t); return; }
    // Anything else: foster parenting, on purpose. Stray content in a table
    // lands BEFORE the table, never inside it.
    this.fosterParenting = true;
    this.inBody(t);
    this.fosterParenting = false;
  }

  // ---- §13.2.6.4.10 InTableText ------------------------------------------

  private inTableText(t: HtmlToken): void {
    if (t.kind === 'character') {
      if (t.data === '\u0000') return;
      this.pendingTableChars.push(t.data);
      if (!isWhitespace(t.data)) this.pendingTableCharsNonWhitespace = true;
      return;
    }
    const pending = this.pendingTableChars;
    this.pendingTableChars = [];
    const nonWs = this.pendingTableCharsNonWhitespace;
    this.pendingTableCharsNonWhitespace = false;
    this.mode = this.originalMode;
    if (nonWs) {
      for (const ch of pending) {
        this.fosterParenting = true;
        this.inBody({ kind: 'character', data: ch });
        this.fosterParenting = false;
      }
    } else {
      for (const ch of pending) this.insertCharacter(ch);
    }
    this.dispatch(t);
  }

  // ---- §13.2.6.4.11 InCaption --------------------------------------------

  private inCaption(t: HtmlToken): void {
    if (t.kind === 'endTag' && t.name === 'caption') {
      if (!this.open.hasInScope('caption', 'table')) return;
      this.generateImpliedEndTags();
      this.open.popUntilName('caption');
      this.formatting.clearToLastMarker();
      this.mode = Mode.InTable;
      return;
    }
    const isTableStart = t.kind === 'startTag'
      && ['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']
        .includes(t.name);
    if (isTableStart || (t.kind === 'endTag' && t.name === 'table')) {
      if (!this.open.hasInScope('caption', 'table')) return;
      this.generateImpliedEndTags();
      this.open.popUntilName('caption');
      this.formatting.clearToLastMarker();
      this.mode = Mode.InTable;
      this.dispatch(t);
      return;
    }
    if (t.kind === 'endTag' && ['body', 'col', 'colgroup', 'html', 'tbody', 'td', 'tfoot',
      'th', 'thead', 'tr'].includes(t.name)) return;
    this.inBody(t);
  }

  // ---- §13.2.6.4.12 InColumnGroup ----------------------------------------

  private inColumnGroup(t: HtmlToken): void {
    if (t.kind === 'character' && isWhitespace(t.data)) { this.insertCharacter(t.data); return; }
    if (isCommentLike(t)) { this.insertCommentLike(t); return; }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag') {
      if (t.name === 'html') { this.inBody(t); return; }
      if (t.name === 'col') { this.insertElementForToken(t); this.open.pop(); return; }
      if (t.name === 'template') { this.inHead(t); return; }
    }
    if (t.kind === 'endTag') {
      if (t.name === 'colgroup') {
        const cur = this.open.current;
        if (cur === undefined || cur.name !== 'colgroup') return;
        this.open.pop();
        this.mode = Mode.InTable;
        return;
      }
      if (t.name === 'col') return;
      if (t.name === 'template') { this.inHead(t); return; }
    }
    if (t.kind === 'eof') { this.inBody(t); return; }
    const cur = this.open.current;
    if (cur === undefined || cur.name !== 'colgroup') return;
    this.open.pop();
    this.mode = Mode.InTable;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.13 InTableBody ------------------------------------------

  private inTableBody(t: HtmlToken): void {
    if (t.kind === 'startTag') {
      if (t.name === 'tr') {
        this.clearStackToTableBodyContext();
        this.insertElementForToken(t);
        this.mode = Mode.InRow;
        return;
      }
      if (t.name === 'th' || t.name === 'td') {
        this.clearStackToTableBodyContext();
        this.insertElement('tr', new Map());
        this.mode = Mode.InRow;
        this.dispatch(t);
        return;
      }
      if (['caption', 'col', 'colgroup', 'tbody', 'tfoot', 'thead'].includes(t.name)) {
        if (!this.open.hasOneOfInScope(['tbody', 'thead', 'tfoot'], 'table')) return;
        this.clearStackToTableBodyContext();
        this.open.pop();
        this.mode = Mode.InTable;
        this.dispatch(t);
        return;
      }
    }
    if (t.kind === 'endTag') {
      if (['tbody', 'tfoot', 'thead'].includes(t.name)) {
        if (!this.open.hasInScope(t.name, 'table')) return;
        this.clearStackToTableBodyContext();
        this.open.pop();
        this.mode = Mode.InTable;
        return;
      }
      if (t.name === 'table') {
        if (!this.open.hasOneOfInScope(['tbody', 'thead', 'tfoot'], 'table')) return;
        this.clearStackToTableBodyContext();
        this.open.pop();
        this.mode = Mode.InTable;
        this.dispatch(t);
        return;
      }
      if (['body', 'caption', 'col', 'colgroup', 'html', 'td', 'th', 'tr'].includes(t.name)) {
        return;
      }
    }
    this.inTable(t);
  }

  // ---- §13.2.6.4.14 InRow -------------------------------------------------

  private inRow(t: HtmlToken): void {
    if (t.kind === 'startTag') {
      if (t.name === 'th' || t.name === 'td') {
        this.clearStackToTableRowContext();
        this.insertElementForToken(t);
        this.mode = Mode.InCell;
        this.formatting.pushMarker();
        return;
      }
      if (['caption', 'col', 'colgroup', 'tbody', 'tfoot', 'thead', 'tr'].includes(t.name)) {
        if (!this.open.hasInScope('tr', 'table')) return;
        this.clearStackToTableRowContext();
        this.open.pop();
        this.mode = Mode.InTableBody;
        this.dispatch(t);
        return;
      }
    }
    if (t.kind === 'endTag') {
      if (t.name === 'tr') {
        if (!this.open.hasInScope('tr', 'table')) return;
        this.clearStackToTableRowContext();
        this.open.pop();
        this.mode = Mode.InTableBody;
        return;
      }
      if (t.name === 'table') {
        if (!this.open.hasInScope('tr', 'table')) return;
        this.clearStackToTableRowContext();
        this.open.pop();
        this.mode = Mode.InTableBody;
        this.dispatch(t);
        return;
      }
      if (['tbody', 'tfoot', 'thead'].includes(t.name)) {
        if (!this.open.hasInScope(t.name, 'table')) return;
        if (!this.open.hasInScope('tr', 'table')) return;
        this.clearStackToTableRowContext();
        this.open.pop();
        this.mode = Mode.InTableBody;
        this.dispatch(t);
        return;
      }
      if (['body', 'caption', 'col', 'colgroup', 'html', 'td', 'th'].includes(t.name)) return;
    }
    this.inTable(t);
  }

  // ---- §13.2.6.4.15 InCell ------------------------------------------------

  private closeCell(): void {
    this.generateImpliedEndTags();
    this.open.popUntilOneOf(['td', 'th']);
    this.formatting.clearToLastMarker();
    this.mode = Mode.InRow;
  }

  private inCell(t: HtmlToken): void {
    if (t.kind === 'endTag' && (t.name === 'td' || t.name === 'th')) {
      if (!this.open.hasInScope(t.name, 'table')) return;
      this.generateImpliedEndTags();
      this.open.popUntilName(t.name);
      this.formatting.clearToLastMarker();
      this.mode = Mode.InRow;
      return;
    }
    if (t.kind === 'startTag'
      && ['caption', 'col', 'colgroup', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']
        .includes(t.name)) {
      if (!this.open.hasOneOfInScope(['td', 'th'], 'table')) return;
      this.closeCell();
      this.dispatch(t);
      return;
    }
    if (t.kind === 'endTag') {
      if (['body', 'caption', 'col', 'colgroup', 'html'].includes(t.name)) return;
      if (['table', 'tbody', 'tfoot', 'thead', 'tr'].includes(t.name)) {
        if (!this.open.hasInScope(t.name, 'table')) return;
        this.closeCell();
        this.dispatch(t);
        return;
      }
    }
    this.inBody(t);
  }

  // ---- §13.2.6.4.18 AfterBody --------------------------------------------

  private afterBody(t: HtmlToken): void {
    if (t.kind === 'character' && isWhitespace(t.data)) { this.inBody(t); return; }
    if (isCommentLike(t)) {
      const html = this.open.items[0];
      this.insertCommentLike(t, { parent: html ?? this.document });
      return;
    }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag' && t.name === 'html') { this.inBody(t); return; }
    if (t.kind === 'endTag' && t.name === 'html') {
      // Fragment case: IGNORE, staying in "after body". Switching would send
      // the comment that follows to the Document, which a fragment never
      // serializes — tests_innerHTML_1.dat#78 asserts it lands on the root.
      if (this.fragmentContextElement !== undefined) return;
      this.mode = Mode.AfterAfterBody;
      return;
    }
    if (t.kind === 'eof') { this.stopped = true; return; }
    this.mode = Mode.InBody;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.19 InFrameset -------------------------------------------

  private inFrameset(t: HtmlToken): void {
    if (t.kind === 'character' && isWhitespace(t.data)) { this.insertCharacter(t.data); return; }
    if (isCommentLike(t)) { this.insertCommentLike(t); return; }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag') {
      switch (t.name) {
        case 'html': this.inBody(t); return;
        case 'frameset': this.insertElementForToken(t); return;
        case 'frame': this.insertElementForToken(t); this.open.pop(); return;
        case 'noframes': this.inHead(t); return;
        default: return;
      }
    }
    if (t.kind === 'endTag' && t.name === 'frameset') {
      if (this.open.current?.name === 'html') return;
      this.open.pop();
      // Fragment case: never leave "in frameset", because there is no outer
      // document for "after frameset" to be after.
      if (this.fragmentContextElement === undefined
        && this.open.current?.name !== 'frameset') {
        this.mode = Mode.AfterFrameset;
      }
      return;
    }
    if (t.kind === 'eof') { this.stopped = true; return; }
  }

  // ---- §13.2.6.4.20 AfterFrameset ----------------------------------------

  private afterFrameset(t: HtmlToken): void {
    if (t.kind === 'character' && isWhitespace(t.data)) { this.insertCharacter(t.data); return; }
    if (isCommentLike(t)) { this.insertCommentLike(t); return; }
    if (t.kind === 'doctype') return;
    if (t.kind === 'startTag') {
      if (t.name === 'html') { this.inBody(t); return; }
      if (t.name === 'noframes') { this.inHead(t); return; }
      return;
    }
    if (t.kind === 'endTag' && t.name === 'html') { this.mode = Mode.AfterAfterFrameset; return; }
    if (t.kind === 'eof') { this.stopped = true; return; }
  }

  // ---- §13.2.6.4.21 AfterAfterBody ---------------------------------------

  private afterAfterBody(t: HtmlToken): void {
    if (isCommentLike(t)) { appendChild(this.document, commentLikeNode(t)); return; }
    if (t.kind === 'doctype') { this.inBody(t); return; }
    if (t.kind === 'character' && isWhitespace(t.data)) { this.inBody(t); return; }
    if (t.kind === 'startTag' && t.name === 'html') { this.inBody(t); return; }
    if (t.kind === 'eof') { this.stopped = true; return; }
    this.mode = Mode.InBody;
    this.dispatch(t);
  }

  // ---- §13.2.6.4.22 AfterAfterFrameset -----------------------------------

  private afterAfterFrameset(t: HtmlToken): void {
    if (isCommentLike(t)) { appendChild(this.document, commentLikeNode(t)); return; }
    if (t.kind === 'doctype') { this.inBody(t); return; }
    if (t.kind === 'character' && isWhitespace(t.data)) { this.inBody(t); return; }
    if (t.kind === 'startTag' && t.name === 'html') { this.inBody(t); return; }
    if (t.kind === 'eof') { this.stopped = true; return; }
    if (t.kind === 'startTag' && t.name === 'noframes') { this.inHead(t); return; }
  }
}

/** §13.2.6.4.1's quirks-mode rules. Only full quirks is observable here — it
 *  is what decides whether `<table>` closes an open `<p>`. */
function quirksFor(
  forceQuirks: boolean,
  name: string,
  publicId: string | undefined,
  systemId: string | undefined,
): boolean {
  if (forceQuirks) return true;
  if (name !== 'html') return true;
  const pub = (publicId ?? '').toLowerCase();
  const sys = (systemId ?? '').toLowerCase();
  if (publicId !== undefined && QUIRKS_PUBLIC_IDS.includes(pub)) return true;
  if (systemId !== undefined && sys === QUIRKS_SYSTEM_ID) return true;
  if (publicId !== undefined && QUIRKS_PUBLIC_PREFIXES.some((p) => pub.startsWith(p))) return true;
  if (systemId === undefined && publicId !== undefined
    && HTML401_PREFIXES.some((p) => pub.startsWith(p))) return true;
  return false;
}

/** A processing instruction goes wherever a comment goes (whatwg/html#12118),
 *  so all fourteen comment branches in tree construction test for both rather
 *  than the PI getting a parallel set of its own. */
type CommentLike = Extract<HtmlToken, { kind: 'comment' } | { kind: 'pi' }>;

function isCommentLike(t: HtmlToken): t is CommentLike {
  return t.kind === 'comment' || t.kind === 'pi';
}

function commentLikeNode(t: CommentLike): HtmlComment | HtmlProcessingInstruction {
  return t.kind === 'comment'
    ? createComment(t.data)
    : createProcessingInstruction(t.target, t.data);
}

export function parseHtml(src: string): HtmlDocument {
  return new TreeBuilder(src).parse();
}

/** How {@link parseHtmlBytes} should decode. */
export interface ParseHtmlBytesOptions {
  /** The encoding to decode with — an HTTP `Content-Type` charset, say, or
   *  anything else the caller knows from outside the document. Any Encoding
   *  Standard label (`windows-1251`, `cp1251`, `Shift_JIS`, …).
   *
   *  It outranks the document's own `<meta>`, which is what "the transport
   *  layer said so" means; only a byte order mark beats it. A label no
   *  encoding claims is IGNORED rather than refused, so a junk header cannot
   *  cost a caller the document. */
  encoding?: string;
}

/** Parse HTML that arrives as BYTES, working out the encoding the way HTML
 *  Standard §13.2.3 says to: a byte order mark, else the caller's `encoding`,
 *  else UTF-8 — and if the document's own `<meta>` then contradicts that
 *  guess, decode again and reparse.
 *
 *  Never throws, exactly as {@link parseHtml} does not.
 *
 *  There is deliberately NO PRESCAN. HTML's is an optimization for a
 *  STREAMING parser: it exists so a browser can start tokenizing a network
 *  response without waiting to see whether a `<meta>` is coming, and it gives
 *  up after 1024 bytes. We hold the whole buffer, so the `<meta>` rule in tree
 *  construction reaches the same answer for every document — and reaches it
 *  for a `<meta>` past that 1024-byte window, which a prescan misses. A
 *  divergence in mechanism that converges in result, and is more faithful to
 *  the document at the margin.
 *
 *  What lets the first pass find that `<meta>` at all: tag and attribute names
 *  are ASCII, and UTF-8's decoder is non-fatal, so a windows-1251 body decodes
 *  to U+FFFD noise around perfectly intact tag structure.
 *
 *  AT MOST ONE restart. The second pass runs with certain confidence, so the
 *  `<meta>` rule cannot fire again — that is a proof of termination rather
 *  than a limit imposed on it.
 *
 *  Not covered: a UTF-16 document with no BOM. §13.2.3.1 leaves detecting one
 *  implementation-defined, browsers use frequency heuristics, and we decline
 *  to guess. */
export function parseHtmlBytes(
  bytes: Uint8Array,
  options: ParseHtmlBytesOptions = {},
): HtmlDocument {
  const certain = bomEncoding(bytes)
    ?? (options.encoding === undefined ? undefined : encodingFromLabel(options.encoding));
  if (certain !== undefined) return new TreeBuilder(decodeHtmlBytes(bytes, certain)).parse();

  const first = new TreeBuilder(decodeHtmlBytes(bytes, 'utf-8'), undefined, 'utf-8');
  const doc = first.parse();
  const again = first.requestedEncoding;
  return again === undefined ? doc : new TreeBuilder(decodeHtmlBytes(bytes, again)).parse();
}

/** §13.4. Implemented and fully tested but NOT re-exported from index.ts:
 *  nothing in this epic can call it, since zch2.5's entry points take a PDF
 *  target rather than an HTML element and so have no context to pass. */
export function parseHtmlFragment(src: string, context: FragmentContext): HtmlFragment {
  return new TreeBuilder(src, context).parseFragment();
}

