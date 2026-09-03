/** The WHATWG HTML tokenizer (HTML Standard §13.2.5), as a literal
 *  transcription: one branch per spec state, named as the spec names it.
 *
 *  Invariant: this module NEVER throws. Every string is a valid HTML document —
 *  the spec mandates a recovery for every parse error by construction, so there
 *  is no input for which refusing is the defined answer. This is markdown.ts's
 *  rule and the exact opposite of parseXml one directory away, which throws
 *  PdfParseError. Errors are reported values on `errors`, never control flow.
 *
 *  Invariant: a pure leaf. No Document, no PDF object, no node: import. It takes
 *  a string; character-encoding detection from bytes is zch2.8. */

import { resolveCharRef } from './htmlcharref.js';

export interface HtmlParseError {
  /** The spec's own kebab-case name, verbatim: 'eof-in-tag'. Never paraphrased
   *  — this is what makes a failing html5lib case name its own spec section. */
  code: string;
  line: number;
  col: number;
}

export type HtmlToken =
  | { kind: 'doctype'; name?: string; publicId?: string; systemId?: string; forceQuirks: boolean }
  | { kind: 'startTag'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'endTag'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'comment'; data: string }
  /** `<?target data?>`, added to the HTML syntax by whatwg/html#12118 (merged
   *  2026-06-25). Before that a `<?` opened a bogus comment; it still does for
   *  every target the spec refuses. */
  | { kind: 'pi'; target: string; data: string }
  | { kind: 'character'; data: string }
  | { kind: 'eof' };

export enum TokenizerState {
  Data,
  RCDATA,
  RAWTEXT,
  ScriptData,
  PLAINTEXT,
  TagOpen,
  EndTagOpen,
  TagName,
  BeforeAttributeName,
  AttributeName,
  AfterAttributeName,
  BeforeAttributeValue,
  AttributeValueDoubleQuoted,
  AttributeValueSingleQuoted,
  AttributeValueUnquoted,
  AfterAttributeValueQuoted,
  SelfClosingStartTag,
  BogusComment,
  ProcessingInstructionOpen,
  ProcessingInstructionTarget,
  AfterProcessingInstructionTarget,
  ProcessingInstructionData,
  ProcessingInstructionQuestionable,
  MarkupDeclarationOpen,
  CommentStart,
  CommentStartDash,
  Comment,
  CommentLessThanSign,
  CommentLessThanSignBang,
  CommentLessThanSignBangDash,
  CommentLessThanSignBangDashDash,
  CommentEndDash,
  CommentEnd,
  CommentEndBang,
  Doctype,
  BeforeDoctypeName,
  DoctypeName,
  AfterDoctypeName,
  AfterDoctypePublicKeyword,
  BeforeDoctypePublicIdentifier,
  DoctypePublicIdentifierDoubleQuoted,
  DoctypePublicIdentifierSingleQuoted,
  AfterDoctypePublicIdentifier,
  BetweenDoctypePublicAndSystemIdentifiers,
  AfterDoctypeSystemKeyword,
  BeforeDoctypeSystemIdentifier,
  DoctypeSystemIdentifierDoubleQuoted,
  DoctypeSystemIdentifierSingleQuoted,
  AfterDoctypeSystemIdentifier,
  BogusDoctype,
  CdataSection,
  CdataSectionBracket,
  CdataSectionEnd,
  RCDATALessThanSign,
  RCDATAEndTagOpen,
  RCDATAEndTagName,
  RAWTEXTLessThanSign,
  RAWTEXTEndTagOpen,
  RAWTEXTEndTagName,
  ScriptDataLessThanSign,
  ScriptDataEndTagOpen,
  ScriptDataEndTagName,
  ScriptDataEscapeStart,
  ScriptDataEscapeStartDash,
  ScriptDataEscaped,
  ScriptDataEscapedDash,
  ScriptDataEscapedDashDash,
  ScriptDataEscapedLessThanSign,
  ScriptDataEscapedEndTagOpen,
  ScriptDataEscapedEndTagName,
  ScriptDataDoubleEscapeStart,
  ScriptDataDoubleEscaped,
  ScriptDataDoubleEscapedDash,
  ScriptDataDoubleEscapedDashDash,
  ScriptDataDoubleEscapedLessThanSign,
  ScriptDataDoubleEscapeEnd,
}

/** §13.2.3.5 preprocessing: CRLF and a lone CR both become LF. Runs before
 *  tokenizing, and is where the line/col counter is seeded — so a tokenizer
 *  that skips it reports every position after the first CRLF one too far
 *  while emitting a perfect token stream. */
export function preprocess(src: string): string {
  return src.replace(/\r\n?/g, '\n');
}

const EOF = -1;
const REPLACEMENT = 0xfffd;

/** Tab, LF, FF, space — the spec's whitespace in the tokenizer. Note CR is
 *  absent: preprocessing has already removed every one of them. */
function isWs(cp: number): boolean {
  return cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x20;
}

function isUpperAlpha(cp: number): boolean { return cp >= 0x41 && cp <= 0x5a; }

function isAsciiDigit(cp: number): boolean { return cp >= 0x30 && cp <= 0x39; }

/** The two processing instruction targets the spec blocklists, so that a page
 *  cannot smuggle in an `xml-stylesheet` load. Anchored, because `xmlfoo` is a
 *  perfectly good target and a prefix test would refuse it. */
const DISALLOWED_PI_TARGET = /^(?:xml|xml-stylesheet)$/i;
function isAlpha(cp: number): boolean {
  return isUpperAlpha(cp) || (cp >= 0x61 && cp <= 0x7a);
}

function isSurrogate(cp: number): boolean { return cp >= 0xd800 && cp <= 0xdfff; }

function isNoncharacter(cp: number): boolean {
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  const low = cp & 0xffff;
  return low === 0xfffe || low === 0xffff;
}

function isControl(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
}

export interface TokenizerOptions {
  /** Whether the adjusted current node is a non-HTML element, which is what
   *  decides whether `<![CDATA[` opens a CDATA section (§13.2.5.42).
   *
   *  Invariant: a CALLBACK asked at the moment of the decision, never a flag
   *  kept in sync. The stack of open elements changes between tokens, so a
   *  cached answer stays right until a `<svg>` opens mid-stream — which is
   *  exactly the document this exists for. Pull matches the seam the tokenizer
   *  already is (`next`/`setState`).
   *
   *  Defaults to `() => false`, which is what holds zch2.1.1's 7,032 cases
   *  still: with no tree builder driving it, every `<![CDATA[` is a bogus
   *  comment plus `cdata-in-html-content`, exactly as before. */
  adjustedCurrentNodeIsForeign?: () => boolean;
}

export class HtmlTokenizer {
  readonly errors: HtmlParseError[] = [];

  private readonly src: string;
  private i = 0;
  /** Position of the code point about to be consumed. */
  private line = 1;
  private col = 1;
  /** Position of the code point just consumed; where an error is reported. */
  private lastLine = 1;
  private lastCol = 1;
  /** Source index of the code point just consumed, so an error can flush the
   *  input-stream errors that precede it. */
  private lastIndex = 0;
  /** Input-stream parse errors, found in one pass up front, in source order. */
  private readonly pending: { index: number; code: string; line: number; col: number }[] = [];
  private pendingAt = 0;
  private state: TokenizerState = TokenizerState.Data;
  private readonly queue: HtmlToken[] = [];
  private done = false;
  private lastStartTag = '';

  // Tag scratch space.
  private tagName = '';
  private tagIsEnd = false;
  private tagSelfClosing = false;
  private tagAttrs = new Map<string, string>();
  private attrName = '';
  private attrValue = '';
  /** Set when the name just finished duplicates one already on the tag. The
   *  value is then parsed and discarded, so the FIRST occurrence wins. */
  private attrDuplicate = false;
  private commentData = '';
  /** The characters buffered since '<' in a content-model end-tag scan. If the
   *  name turns out not to be the appropriate end tag they are emitted as
   *  characters — a non-matching end tag is not a tag at all. Also the word
   *  the two script-data double-escape transitions match against. */
  private tempBuffer = '';
  /** The processing instruction being built (§13.2.5.72-76). */
  private piTarget = '';
  private piData = '';

  // DOCTYPE scratch space. An identifier that was never opened stays
  // undefined, which is what distinguishes `<!DOCTYPE html>` from
  // `<!DOCTYPE html PUBLIC "">` — the suite spells the first null.
  private dtName: string | undefined;
  private dtPublicId: string | undefined;
  private dtSystemId: string | undefined;
  private dtForceQuirks = false;

  private readonly isForeign: () => boolean;

  constructor(src: string, options?: TokenizerOptions) {
    this.src = preprocess(src);
    this.isForeign = options?.adjustedCurrentNodeIsForeign ?? (() => false);
    this.scanInputStream();
  }

  setState(s: TokenizerState): void { this.state = s; }

  setLastStartTag(name: string): void { this.lastStartTag = name; }

  next(): HtmlToken {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) return queued;
      if (this.done) return { kind: 'eof' };
      this.step();
    }
  }

  // ---- cursor -------------------------------------------------------------

  /** Consume one code point, or EOF. Advances both positions; consuming EOF
   *  leaves the reported column one past the last code point, which is what
   *  every vendored `eof-in-*` expectation asserts. */
  private consume(): number {
    this.lastLine = this.line;
    this.lastCol = this.col;
    this.lastIndex = this.i;
    if (this.i >= this.src.length) return EOF;
    const cp = this.src.codePointAt(this.i) as number;
    this.i += cp > 0xffff ? 2 : 1;
    if (cp === 0x0a) { this.line++; this.col = 1; } else { this.col += cp > 0xffff ? 2 : 1; }
    return cp;
  }

  /** §13.2.3.5: a surrogate, a noncharacter, or a control that is neither
   *  ASCII whitespace nor NULL is a parse error IN ITS OWN RIGHT, separately
   *  from whatever the current state then makes of the character. The state
   *  machine never mentions these at all, which is why they are easy to miss
   *  entirely — 191 of the vendored cases assert one.
   *
   *  They belong to the INPUT STREAM, not to any state, so they are found in
   *  one pass up front and then interleaved by source index. That ordering is
   *  load-bearing rather than tidy: `<!` expects the control error BEFORE
   *  markup declaration open's incorrectly-opened-comment, and both are
   *  reported at the same column — the character has entered the stream even
   *  though that state only PEEKED at it. Reporting from `consume` instead put
   *  them the wrong way round, and made a reconsumed character report twice. */
  private scanInputStream(): void {
    let line = 1;
    let col = 1;
    for (let k = 0; k < this.src.length;) {
      const cp = this.src.codePointAt(k) as number;
      const width = cp > 0xffff ? 2 : 1;
      let code: string | undefined;
      if (isSurrogate(cp)) code = 'surrogate-in-input-stream';
      else if (isNoncharacter(cp)) code = 'noncharacter-in-input-stream';
      // NULL is excluded: every state that cares reports
      // unexpected-null-character itself.
      else if (cp !== 0x00 && isControl(cp) && !isWs(cp)) code = 'control-character-in-input-stream';
      if (code !== undefined) this.pending.push({ index: k, code, line, col });
      k += width;
      if (cp === 0x0a) { line++; col = 1; } else { col += width; }
    }
  }

  /** Emit every pending input-stream error at or before `index`. */
  private flushInputErrors(index: number): void {
    while (this.pendingAt < this.pending.length) {
      const e = this.pending[this.pendingAt];
      if (e === undefined || e.index > index) break;
      this.pendingAt++;
      this.errors.push({ code: e.code, line: e.line, col: e.col });
    }
  }

  /** Put the current code point back, so the next consume returns it again. */
  private reconsume(cp: number): void {
    if (cp === EOF) return;
    this.i -= cp > 0xffff ? 2 : 1;
    this.line = this.lastLine;
    this.col = this.lastCol;
  }

  /** Consume `n` code points known to be ASCII and newline-free — the fixed
   *  keywords the two peek sites match. Both counters advance by `n`. */
  private advance(n: number): void {
    this.i += n;
    this.col += n;
  }

  /** Whether the next `word.length` code points match `word` ASCII
   *  case-insensitively, without consuming them. */
  private peekAsciiCaseInsensitive(word: string): boolean {
    return this.src.slice(this.i, this.i + word.length).toUpperCase() === word;
  }

  /** Report at the code point just consumed — the convention every vendored
   *  expectation follows. The one peek-based site (markup declaration open)
   *  passes an explicit position instead. */
  private error(code: string, at?: { line: number; col: number; index: number }): void {
    this.flushInputErrors(at?.index ?? this.lastIndex);
    this.errors.push({ code, line: at?.line ?? this.lastLine, col: at?.col ?? this.lastCol });
  }

  private emit(t: HtmlToken): void {
    if (t.kind === 'startTag') this.lastStartTag = t.name;
    this.queue.push(t);
  }

  private emitEof(): void {
    this.flushInputErrors(this.src.length);
    this.done = true;
    this.queue.push({ kind: 'eof' });
  }

  private char(cp: number): void {
    this.emit({ kind: 'character', data: String.fromCodePoint(cp) });
  }

  /** §13.2.5.72 Character reference state, driven from the four states that
   *  reach it. The sub-machine returns offsets from the '&', which become
   *  columns here because the '&' has just been consumed — its position is
   *  exactly lastLine/lastCol.
   *
   *  `inAttribute` selects the historical rule that keeps `?a=1&copy=2` intact
   *  in an attribute while the same bytes in text give a copyright sign. */
  private characterReference(inAttribute: boolean): string {
    const ampLine = this.lastLine;
    const ampCol = this.lastCol;
    const start = this.i - 1;
    const r = resolveCharRef(this.src, start, inAttribute);
    for (const e of r.errors) {
      this.errors.push({ code: e.code, line: ampLine, col: ampCol + e.offset });
    }
    // Everything a reference can consume is on one line: a newline is neither
    // a name character nor a digit, so the column arithmetic above is total.
    this.col = ampCol + (r.end - start);
    this.i = r.end;
    return r.text;
  }

  private chars(s: string): void {
    for (const c of s) this.emit({ kind: 'character', data: c });
  }

  // ---- tag building -------------------------------------------------------

  private startTagToken(isEnd: boolean): void {
    this.tagName = '';
    this.tagIsEnd = isEnd;
    this.tagSelfClosing = false;
    this.tagAttrs = new Map();
    this.attrName = '';
    this.attrValue = '';
    this.attrDuplicate = false;
  }

  /** Begin a new attribute, committing whatever was pending. */
  private startAttr(): void {
    this.commitAttr();
    this.attrName = '';
    this.attrValue = '';
    this.attrDuplicate = false;
  }

  /** Leaving the attribute name state: the name is complete, so §13.2.5.33's
   *  duplicate check fires HERE rather than at emit. That is what puts the
   *  error at the character that ENDED the name — the '=' at col 11 in
   *  `<h a='b' a='d'>` — and it is why the first value wins: the duplicate's
   *  value is parsed and then discarded. */
  private finishAttrName(): void {
    this.attrDuplicate = this.tagAttrs.has(this.attrName);
    if (this.attrDuplicate) this.error('duplicate-attribute');
  }

  private commitAttr(): void {
    if (this.attrName === '') return;
    if (!this.attrDuplicate) this.tagAttrs.set(this.attrName, this.attrValue);
    this.attrName = '';
    this.attrValue = '';
    this.attrDuplicate = false;
  }

  private emitTag(): void {
    this.commitAttr();
    if (this.tagIsEnd) {
      // Both errors are reported at the '>' just consumed, and the token is
      // emitted anyway with the offending parts dropped.
      if (this.tagAttrs.size > 0) this.error('end-tag-with-attributes');
      if (this.tagSelfClosing) this.error('end-tag-with-trailing-solidus');
      this.emit({ kind: 'endTag', name: this.tagName, attrs: new Map(), selfClosing: false });
      return;
    }
    this.emit({
      kind: 'startTag',
      name: this.tagName,
      attrs: this.tagAttrs,
      selfClosing: this.tagSelfClosing,
    });
  }

  /** The appropriate end tag is the one matching the last START tag emitted —
   *  which is why `setLastStartTag` exists for a case that begins mid-stream. */
  private isAppropriateEndTag(): boolean {
    return this.tagName === this.lastStartTag;
  }

  private emitComment(): void {
    this.emit({ kind: 'comment', data: this.commentData });
    this.commentData = '';
  }

  // ---- states -------------------------------------------------------------

  private step(): void {
    switch (this.state) {
      case TokenizerState.PLAINTEXT: return this.plaintextState();
      case TokenizerState.TagOpen: return this.tagOpenState();
      case TokenizerState.EndTagOpen: return this.endTagOpenState();
      case TokenizerState.TagName: return this.tagNameState();
      case TokenizerState.BeforeAttributeName: return this.beforeAttributeNameState();
      case TokenizerState.AttributeName: return this.attributeNameState();
      case TokenizerState.AfterAttributeName: return this.afterAttributeNameState();
      case TokenizerState.BeforeAttributeValue: return this.beforeAttributeValueState();
      case TokenizerState.AttributeValueDoubleQuoted: return this.attributeValueQuotedState(0x22);
      case TokenizerState.AttributeValueSingleQuoted: return this.attributeValueQuotedState(0x27);
      case TokenizerState.AttributeValueUnquoted: return this.attributeValueUnquotedState();
      case TokenizerState.AfterAttributeValueQuoted: return this.afterAttributeValueQuotedState();
      case TokenizerState.SelfClosingStartTag: return this.selfClosingStartTagState();
      case TokenizerState.BogusComment: return this.bogusCommentState();
      case TokenizerState.ProcessingInstructionOpen:
        return this.processingInstructionOpenState();
      case TokenizerState.ProcessingInstructionTarget:
        return this.processingInstructionTargetState();
      case TokenizerState.AfterProcessingInstructionTarget:
        return this.afterProcessingInstructionTargetState();
      case TokenizerState.ProcessingInstructionData:
        return this.processingInstructionDataState();
      case TokenizerState.ProcessingInstructionQuestionable:
        return this.processingInstructionQuestionableState();
      case TokenizerState.MarkupDeclarationOpen: return this.markupDeclarationOpenState();
      case TokenizerState.CommentStart: return this.commentStartState();
      case TokenizerState.CommentStartDash: return this.commentStartDashState();
      case TokenizerState.Comment: return this.commentState();
      case TokenizerState.CommentLessThanSign: return this.commentLessThanSignState();
      case TokenizerState.CommentLessThanSignBang: return this.commentLessThanSignBangState();
      case TokenizerState.CommentLessThanSignBangDash: return this.commentLessThanSignBangDashState();
      case TokenizerState.CommentLessThanSignBangDashDash: return this.commentLessThanSignBangDashDashState();
      case TokenizerState.CommentEndDash: return this.commentEndDashState();
      case TokenizerState.CommentEnd: return this.commentEndState();
      case TokenizerState.CommentEndBang: return this.commentEndBangState();
      case TokenizerState.Doctype: return this.doctypeState();
      case TokenizerState.BeforeDoctypeName: return this.beforeDoctypeNameState();
      case TokenizerState.DoctypeName: return this.doctypeNameState();
      case TokenizerState.AfterDoctypeName: return this.afterDoctypeNameState();
      case TokenizerState.AfterDoctypePublicKeyword: return this.afterDoctypePublicKeywordState();
      case TokenizerState.BeforeDoctypePublicIdentifier: return this.beforeDoctypePublicIdentifierState();
      case TokenizerState.DoctypePublicIdentifierDoubleQuoted: return this.doctypePublicIdentifierState(0x22);
      case TokenizerState.DoctypePublicIdentifierSingleQuoted: return this.doctypePublicIdentifierState(0x27);
      case TokenizerState.AfterDoctypePublicIdentifier: return this.afterDoctypePublicIdentifierState();
      case TokenizerState.BetweenDoctypePublicAndSystemIdentifiers: return this.betweenDoctypeIdentifiersState();
      case TokenizerState.AfterDoctypeSystemKeyword: return this.afterDoctypeSystemKeywordState();
      case TokenizerState.BeforeDoctypeSystemIdentifier: return this.beforeDoctypeSystemIdentifierState();
      case TokenizerState.DoctypeSystemIdentifierDoubleQuoted: return this.doctypeSystemIdentifierState(0x22);
      case TokenizerState.DoctypeSystemIdentifierSingleQuoted: return this.doctypeSystemIdentifierState(0x27);
      case TokenizerState.AfterDoctypeSystemIdentifier: return this.afterDoctypeSystemIdentifierState();
      case TokenizerState.BogusDoctype: return this.bogusDoctypeState();
      case TokenizerState.CdataSection: return this.cdataSectionState();
      case TokenizerState.CdataSectionBracket: return this.cdataSectionBracketState();
      case TokenizerState.CdataSectionEnd: return this.cdataSectionEndState();
      case TokenizerState.RCDATA: return this.rcdataState();
      case TokenizerState.RAWTEXT: return this.rawtextState();
      case TokenizerState.ScriptData: return this.scriptDataState();
      case TokenizerState.RCDATALessThanSign:
        return this.contentLessThanSignState(TokenizerState.RCDATA, TokenizerState.RCDATAEndTagOpen);
      case TokenizerState.RAWTEXTLessThanSign:
        return this.contentLessThanSignState(TokenizerState.RAWTEXT, TokenizerState.RAWTEXTEndTagOpen);
      case TokenizerState.RCDATAEndTagOpen:
        return this.contentEndTagOpenState(TokenizerState.RCDATA, TokenizerState.RCDATAEndTagName);
      case TokenizerState.RAWTEXTEndTagOpen:
        return this.contentEndTagOpenState(TokenizerState.RAWTEXT, TokenizerState.RAWTEXTEndTagName);
      case TokenizerState.ScriptDataEndTagOpen:
        return this.contentEndTagOpenState(TokenizerState.ScriptData, TokenizerState.ScriptDataEndTagName);
      case TokenizerState.ScriptDataEscapedEndTagOpen:
        return this.contentEndTagOpenState(TokenizerState.ScriptDataEscaped, TokenizerState.ScriptDataEscapedEndTagName);
      case TokenizerState.RCDATAEndTagName:
        return this.contentEndTagNameState(TokenizerState.RCDATA);
      case TokenizerState.RAWTEXTEndTagName:
        return this.contentEndTagNameState(TokenizerState.RAWTEXT);
      case TokenizerState.ScriptDataEndTagName:
        return this.contentEndTagNameState(TokenizerState.ScriptData);
      case TokenizerState.ScriptDataEscapedEndTagName:
        return this.contentEndTagNameState(TokenizerState.ScriptDataEscaped);
      case TokenizerState.ScriptDataLessThanSign: return this.scriptDataLessThanSignState();
      case TokenizerState.ScriptDataEscapeStart: return this.scriptDataEscapeStartState();
      case TokenizerState.ScriptDataEscapeStartDash: return this.scriptDataEscapeStartDashState();
      case TokenizerState.ScriptDataEscaped: return this.scriptDataEscapedState();
      case TokenizerState.ScriptDataEscapedDash: return this.scriptDataEscapedDashState();
      case TokenizerState.ScriptDataEscapedDashDash: return this.scriptDataEscapedDashDashState();
      case TokenizerState.ScriptDataEscapedLessThanSign: return this.scriptDataEscapedLessThanSignState();
      case TokenizerState.ScriptDataDoubleEscapeStart:
        return this.doubleEscapeTransitionState(TokenizerState.ScriptDataDoubleEscaped, TokenizerState.ScriptDataEscaped);
      case TokenizerState.ScriptDataDoubleEscapeEnd:
        return this.doubleEscapeTransitionState(TokenizerState.ScriptDataEscaped, TokenizerState.ScriptDataDoubleEscaped);
      case TokenizerState.ScriptDataDoubleEscaped: return this.scriptDataDoubleEscapedState();
      case TokenizerState.ScriptDataDoubleEscapedDash: return this.scriptDataDoubleEscapedDashState();
      case TokenizerState.ScriptDataDoubleEscapedDashDash: return this.scriptDataDoubleEscapedDashDashState();
      case TokenizerState.ScriptDataDoubleEscapedLessThanSign: return this.scriptDataDoubleEscapedLessThanSignState();
      default: return this.dataState();
    }
  }

  /** §13.2.5.1 Data state. `&` is wired by the character-reference task. */
  private dataState(): void {
    const cp = this.consume();
    if (cp === EOF) return this.emitEof();
    if (cp === 0x3c) { this.state = TokenizerState.TagOpen; return; }
    if (cp === 0x26) return this.chars(this.characterReference(false));
    // NUL is per-state, not global: Data passes it through, the alternate
    // content models replace it with U+FFFD.
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(cp); }
    return this.char(cp);
  }

  /** §13.2.5.7 PLAINTEXT state. There is no way out of it. */
  private plaintextState(): void {
    const cp = this.consume();
    if (cp === EOF) return this.emitEof();
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(REPLACEMENT); }
    return this.char(cp);
  }

  /** §13.2.5.6 Tag open state. */
  private tagOpenState(): void {
    const cp = this.consume();
    if (cp === 0x21) { this.state = TokenizerState.MarkupDeclarationOpen; return; }
    if (cp === 0x2f) { this.state = TokenizerState.EndTagOpen; return; }
    if (isAlpha(cp)) {
      this.startTagToken(false);
      this.reconsume(cp);
      this.state = TokenizerState.TagName;
      return;
    }
    if (cp === 0x3f) {
      // No parse error any more: since whatwg/html#12118 a `?` opens a
      // processing instruction rather than reporting
      // unexpected-question-mark-instead-of-tag-name and falling into a bogus
      // comment. The `?` itself is consumed here and re-supplied by every
      // fallback below, because a refused PI still shows it in its comment.
      this.piTarget = '';
      this.state = TokenizerState.ProcessingInstructionOpen;
      return;
    }
    if (cp === EOF) {
      this.error('eof-before-tag-name');
      this.char(0x3c);
      return this.emitEof();
    }
    this.error('invalid-first-character-of-tag-name');
    this.char(0x3c);
    this.reconsume(cp);
    this.state = TokenizerState.Data;
  }

  /** §13.2.5.7 End tag open state. Note `</>` emits NO token at all — not an
   *  end tag, not characters. */
  private endTagOpenState(): void {
    const cp = this.consume();
    if (isAlpha(cp)) {
      this.startTagToken(true);
      this.reconsume(cp);
      this.state = TokenizerState.TagName;
      return;
    }
    if (cp === 0x3e) {
      this.error('missing-end-tag-name');
      this.state = TokenizerState.Data;
      return;
    }
    if (cp === EOF) {
      this.error('eof-before-tag-name');
      this.chars('</');
      return this.emitEof();
    }
    this.error('invalid-first-character-of-tag-name');
    this.commentData = '';
    this.reconsume(cp);
    this.state = TokenizerState.BogusComment;
  }

  /** §13.2.5.8 Tag name state. */
  private tagNameState(): void {
    const cp = this.consume();
    if (isWs(cp)) { this.state = TokenizerState.BeforeAttributeName; return; }
    if (cp === 0x2f) { this.state = TokenizerState.SelfClosingStartTag; return; }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitTag(); }
    if (isUpperAlpha(cp)) { this.tagName += String.fromCodePoint(cp + 0x20); return; }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.tagName += String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === EOF) { this.error('eof-in-tag'); return this.emitEof(); }
    this.tagName += String.fromCodePoint(cp);
  }

  /** §13.2.5.32 Before attribute name state. */
  private beforeAttributeNameState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x2f || cp === 0x3e || cp === EOF) {
      this.reconsume(cp);
      this.state = TokenizerState.AfterAttributeName;
      return;
    }
    if (cp === 0x3d) {
      this.error('unexpected-equals-sign-before-attribute-name');
      this.startAttr();
      this.attrName = '=';
      this.state = TokenizerState.AttributeName;
      return;
    }
    this.startAttr();
    this.reconsume(cp);
    this.state = TokenizerState.AttributeName;
  }

  /** §13.2.5.33 Attribute name state. */
  private attributeNameState(): void {
    const cp = this.consume();
    if (isWs(cp) || cp === 0x2f || cp === 0x3e || cp === EOF) {
      this.finishAttrName();
      this.reconsume(cp);
      this.state = TokenizerState.AfterAttributeName;
      return;
    }
    if (cp === 0x3d) {
      this.finishAttrName();
      this.state = TokenizerState.BeforeAttributeValue;
      return;
    }
    if (isUpperAlpha(cp)) { this.attrName += String.fromCodePoint(cp + 0x20); return; }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.attrName += String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === 0x22 || cp === 0x27 || cp === 0x3c) {
      this.error('unexpected-character-in-attribute-name');
      this.attrName += String.fromCodePoint(cp);
      return;
    }
    this.attrName += String.fromCodePoint(cp);
  }

  /** §13.2.5.34 After attribute name state. */
  private afterAttributeNameState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x2f) { this.state = TokenizerState.SelfClosingStartTag; return; }
    if (cp === 0x3d) { this.state = TokenizerState.BeforeAttributeValue; return; }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitTag(); }
    if (cp === EOF) { this.error('eof-in-tag'); return this.emitEof(); }
    this.startAttr();
    this.reconsume(cp);
    this.state = TokenizerState.AttributeName;
  }

  /** §13.2.5.35 Before attribute value state. */
  private beforeAttributeValueState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x22) { this.state = TokenizerState.AttributeValueDoubleQuoted; return; }
    if (cp === 0x27) { this.state = TokenizerState.AttributeValueSingleQuoted; return; }
    if (cp === 0x3e) {
      this.error('missing-attribute-value');
      this.state = TokenizerState.Data;
      return this.emitTag();
    }
    this.reconsume(cp);
    this.state = TokenizerState.AttributeValueUnquoted;
  }

  /** §13.2.5.36 and §13.2.5.37, which differ only in the closing quote. `&` is
   *  wired by the character-reference task. */
  private attributeValueQuotedState(quote: number): void {
    const cp = this.consume();
    if (cp === quote) { this.state = TokenizerState.AfterAttributeValueQuoted; return; }
    if (cp === 0x26) { this.attrValue += this.characterReference(true); return; }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.attrValue += String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === EOF) { this.error('eof-in-tag'); return this.emitEof(); }
    this.attrValue += String.fromCodePoint(cp);
  }

  /** §13.2.5.38 Attribute value (unquoted) state. */
  private attributeValueUnquotedState(): void {
    const cp = this.consume();
    if (isWs(cp)) { this.state = TokenizerState.BeforeAttributeName; return; }
    if (cp === 0x26) { this.attrValue += this.characterReference(true); return; }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitTag(); }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.attrValue += String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === 0x22 || cp === 0x27 || cp === 0x3c || cp === 0x3d || cp === 0x60) {
      this.error('unexpected-character-in-unquoted-attribute-value');
      this.attrValue += String.fromCodePoint(cp);
      return;
    }
    if (cp === EOF) { this.error('eof-in-tag'); return this.emitEof(); }
    this.attrValue += String.fromCodePoint(cp);
  }

  /** §13.2.5.39 After attribute value (quoted) state. */
  private afterAttributeValueQuotedState(): void {
    const cp = this.consume();
    if (isWs(cp)) { this.state = TokenizerState.BeforeAttributeName; return; }
    if (cp === 0x2f) { this.state = TokenizerState.SelfClosingStartTag; return; }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitTag(); }
    if (cp === EOF) { this.error('eof-in-tag'); return this.emitEof(); }
    this.error('missing-whitespace-between-attributes');
    this.reconsume(cp);
    this.state = TokenizerState.BeforeAttributeName;
  }

  /** §13.2.5.40 Self-closing start tag state. */
  private selfClosingStartTagState(): void {
    const cp = this.consume();
    if (cp === 0x3e) {
      this.tagSelfClosing = true;
      this.state = TokenizerState.Data;
      return this.emitTag();
    }
    if (cp === EOF) { this.error('eof-in-tag'); return this.emitEof(); }
    this.error('unexpected-solidus-in-tag');
    this.reconsume(cp);
    this.state = TokenizerState.BeforeAttributeName;
  }

  /** §13.2.5.41 Bogus comment state. */
  private bogusCommentState(): void {
    const cp = this.consume();
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitComment(); }
    if (cp === EOF) { this.emitComment(); return this.emitEof(); }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.commentData += String.fromCodePoint(REPLACEMENT);
      return;
    }
    this.commentData += String.fromCodePoint(cp);
  }

  /** §13.2.5.72 Processing instruction open state.
   *
   *  A target may START with an ASCII alpha or U+005F, which is WIDER than the
   *  tag-name rule the rest of it mirrors. */
  private processingInstructionOpenState(): void {
    const cp = this.consume();
    if (isAlpha(cp) || cp === 0x5f) {
      this.reconsume(cp);
      this.state = TokenizerState.ProcessingInstructionTarget;
      return;
    }
    if (cp === EOF) { this.error('eof-in-processing-instruction'); return this.emitEof(); }
    this.error('invalid-first-character-of-processing-instruction-target');
    this.fallBackToComment(cp);
  }

  /** §13.2.5.73 Processing instruction target state. */
  private processingInstructionTargetState(): void {
    const cp = this.consume();
    if (cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x20
      || cp === 0x3f || cp === 0x3e) {
      // `xml` and `xml-stylesheet` are blocklisted so a page cannot smuggle in
      // a stylesheet load. A PREFIX test would wrongly refuse `xmlfoo`.
      if (DISALLOWED_PI_TARGET.test(this.piTarget)) {
        this.error('disallowed-processing-instruction-target');
        this.fallBackToComment(cp);
        return;
      }
      this.piData = '';
      this.reconsume(cp);
      this.state = TokenizerState.AfterProcessingInstructionTarget;
      return;
    }
    if (isAlpha(cp) || isAsciiDigit(cp) || cp === 0x2d || cp === 0x5f) {
      this.piTarget += String.fromCodePoint(cp);
      return;
    }
    if (cp === EOF) { this.error('eof-in-processing-instruction'); return this.emitEof(); }
    this.error('invalid-processing-instruction-target');
    this.fallBackToComment(cp);
  }

  /** §13.2.5.74 After processing instruction target state. */
  private afterProcessingInstructionTargetState(): void {
    const cp = this.consume();
    if (cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x20) return;
    this.reconsume(cp);
    this.state = TokenizerState.ProcessingInstructionData;
  }

  /** §13.2.5.75 Processing instruction data state.
   *
   *  A bare `>` closes, which is the bogus-comment behaviour this replaced and
   *  is why `<?t a>b` leaves `b` as text rather than swallowing the document. */
  private processingInstructionDataState(): void {
    const cp = this.consume();
    if (cp === 0x3f) { this.state = TokenizerState.ProcessingInstructionQuestionable; return; }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitPi(); }
    if (cp === EOF) { this.error('eof-in-processing-instruction'); return this.emitEof(); }
    this.piData += String.fromCodePoint(cp);
  }

  /** §13.2.5.76 Processing instruction questionable state. Only `?>` closes,
   *  so a lone `?` is data — which is the whole reason this state exists. */
  private processingInstructionQuestionableState(): void {
    const cp = this.consume();
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitPi(); }
    if (cp === EOF) { this.error('eof-in-processing-instruction'); return this.emitEof(); }
    this.piData += '?';
    this.reconsume(cp);
    this.state = TokenizerState.ProcessingInstructionData;
  }

  /** A refused processing instruction becomes the bogus comment it used to be.
   *
   *  The comment KEEPS the leading `?` and everything the target consumed, so
   *  `<?xml version="1.0">` reads back as `<!-- ?xml version="1.0" -->`. Tag
   *  open swallowed that `?`, so it is re-supplied here rather than
   *  reconsumed. */
  private fallBackToComment(cp: number): void {
    this.commentData = `?${this.piTarget}`;
    this.piTarget = '';
    this.reconsume(cp);
    this.state = TokenizerState.BogusComment;
  }

  private emitPi(): void {
    this.emit({ kind: 'pi', target: this.piTarget, data: this.piData });
    this.piTarget = '';
    this.piData = '';
  }

  /** §13.2.5.42 Markup declaration open state — the one state that PEEKS, so
   *  it errors at the code point it did NOT consume. `<!DOC>` reports
   *  incorrectly-opened-comment at the `D`, not at the `!` before it. */
  private markupDeclarationOpenState(): void {
    const at = { line: this.line, col: this.col, index: this.i };
    if (this.src.startsWith('--', this.i)) {
      this.advance(2);
      this.commentData = '';
      this.state = TokenizerState.CommentStart;
      return;
    }
    if (this.peekAsciiCaseInsensitive('DOCTYPE')) {
      this.advance(7);
      this.state = TokenizerState.Doctype;
      return;
    }
    if (this.src.startsWith('[CDATA[', this.i)) {
      this.advance(7);
      // In FOREIGN content this really opens a CDATA section; outside it, it
      // is a bogus comment. The test goes here rather than at the error, so a
      // legal section reports nothing at all.
      if (this.isForeign()) {
        this.state = TokenizerState.CdataSection;
        return;
      }
      // Reported at the LAST character of the sequence it consumed (col 9 of
      // `<![CDATA[`), unlike incorrectly-opened-comment below, which consumes
      // nothing and reports at the character it only looked at.
      this.error('cdata-in-html-content', { line: at.line, col: at.col + 6, index: at.index + 6 });
      this.commentData = '[CDATA[';
      this.state = TokenizerState.BogusComment;
      return;
    }
    this.error('incorrectly-opened-comment', at);
    this.commentData = '';
    this.state = TokenizerState.BogusComment;
  }

  // ---- comments -----------------------------------------------------------

  /** §13.2.5.43 Comment start state. */
  private commentStartState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.state = TokenizerState.CommentStartDash; return; }
    if (cp === 0x3e) {
      this.error('abrupt-closing-of-empty-comment');
      this.state = TokenizerState.Data;
      return this.emitComment();
    }
    this.reconsume(cp);
    this.state = TokenizerState.Comment;
  }

  /** §13.2.5.44 Comment start dash state. */
  private commentStartDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.state = TokenizerState.CommentEnd; return; }
    if (cp === 0x3e) {
      this.error('abrupt-closing-of-empty-comment');
      this.state = TokenizerState.Data;
      return this.emitComment();
    }
    if (cp === EOF) { this.error('eof-in-comment'); this.emitComment(); return this.emitEof(); }
    this.commentData += '-';
    this.reconsume(cp);
    this.state = TokenizerState.Comment;
  }

  /** §13.2.5.45 Comment state. */
  private commentState(): void {
    const cp = this.consume();
    if (cp === 0x3c) {
      this.commentData += '<';
      this.state = TokenizerState.CommentLessThanSign;
      return;
    }
    if (cp === 0x2d) { this.state = TokenizerState.CommentEndDash; return; }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.commentData += String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === EOF) { this.error('eof-in-comment'); this.emitComment(); return this.emitEof(); }
    this.commentData += String.fromCodePoint(cp);
  }

  /** §13.2.5.46 Comment less-than sign state. */
  private commentLessThanSignState(): void {
    const cp = this.consume();
    if (cp === 0x21) {
      this.commentData += '!';
      this.state = TokenizerState.CommentLessThanSignBang;
      return;
    }
    if (cp === 0x3c) { this.commentData += '<'; return; }
    this.reconsume(cp);
    this.state = TokenizerState.Comment;
  }

  /** §13.2.5.47 Comment less-than sign bang state. */
  private commentLessThanSignBangState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.state = TokenizerState.CommentLessThanSignBangDash; return; }
    this.reconsume(cp);
    this.state = TokenizerState.Comment;
  }

  /** §13.2.5.48 Comment less-than sign bang dash state. */
  private commentLessThanSignBangDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.state = TokenizerState.CommentLessThanSignBangDashDash; return; }
    this.reconsume(cp);
    this.state = TokenizerState.CommentEndDash;
  }

  /** §13.2.5.49 Comment less-than sign bang dash dash state. */
  private commentLessThanSignBangDashDashState(): void {
    const cp = this.consume();
    if (cp !== 0x3e && cp !== EOF) this.error('nested-comment');
    this.reconsume(cp);
    this.state = TokenizerState.CommentEnd;
  }

  /** §13.2.5.50 Comment end dash state. */
  private commentEndDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.state = TokenizerState.CommentEnd; return; }
    if (cp === EOF) { this.error('eof-in-comment'); this.emitComment(); return this.emitEof(); }
    this.commentData += '-';
    this.reconsume(cp);
    this.state = TokenizerState.Comment;
  }

  /** §13.2.5.51 Comment end state. */
  private commentEndState(): void {
    const cp = this.consume();
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitComment(); }
    if (cp === 0x21) { this.state = TokenizerState.CommentEndBang; return; }
    if (cp === 0x2d) { this.commentData += '-'; return; }
    if (cp === EOF) { this.error('eof-in-comment'); this.emitComment(); return this.emitEof(); }
    this.commentData += '--';
    this.reconsume(cp);
    this.state = TokenizerState.Comment;
  }

  /** §13.2.5.52 Comment end bang state. */
  private commentEndBangState(): void {
    const cp = this.consume();
    if (cp === 0x2d) {
      this.commentData += '--!';
      this.state = TokenizerState.CommentEndDash;
      return;
    }
    if (cp === 0x3e) {
      this.error('incorrectly-closed-comment');
      this.state = TokenizerState.Data;
      return this.emitComment();
    }
    if (cp === EOF) { this.error('eof-in-comment'); this.emitComment(); return this.emitEof(); }
    this.commentData += '--!';
    this.reconsume(cp);
    this.state = TokenizerState.Comment;
  }

  // ---- DOCTYPE ------------------------------------------------------------

  private startDoctype(): void {
    this.dtName = undefined;
    this.dtPublicId = undefined;
    this.dtSystemId = undefined;
    this.dtForceQuirks = false;
  }

  private emitDoctype(): void {
    this.emit({
      kind: 'doctype',
      name: this.dtName,
      publicId: this.dtPublicId,
      systemId: this.dtSystemId,
      forceQuirks: this.dtForceQuirks,
    });
  }

  /** Every DOCTYPE state's EOF branch is the same three steps. */
  private doctypeEof(): void {
    this.error('eof-in-doctype');
    this.dtForceQuirks = true;
    this.emitDoctype();
    this.emitEof();
  }

  /** §13.2.5.53 DOCTYPE state. */
  private doctypeState(): void {
    const cp = this.consume();
    if (isWs(cp)) { this.state = TokenizerState.BeforeDoctypeName; return; }
    if (cp === 0x3e) {
      this.reconsume(cp);
      this.state = TokenizerState.BeforeDoctypeName;
      return;
    }
    if (cp === EOF) { this.startDoctype(); return this.doctypeEof(); }
    this.error('missing-whitespace-before-doctype-name');
    this.reconsume(cp);
    this.state = TokenizerState.BeforeDoctypeName;
  }

  /** §13.2.5.54 Before DOCTYPE name state. */
  private beforeDoctypeNameState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.startDoctype();
      this.dtName = String.fromCodePoint(REPLACEMENT);
      this.state = TokenizerState.DoctypeName;
      return;
    }
    if (cp === 0x3e) {
      this.error('missing-doctype-name');
      this.startDoctype();
      this.dtForceQuirks = true;
      this.state = TokenizerState.Data;
      return this.emitDoctype();
    }
    if (cp === EOF) { this.startDoctype(); return this.doctypeEof(); }
    this.startDoctype();
    this.dtName = String.fromCodePoint(isUpperAlpha(cp) ? cp + 0x20 : cp);
    this.state = TokenizerState.DoctypeName;
  }

  /** §13.2.5.55 DOCTYPE name state. The NAME is lowercased; the public and
   *  system identifiers below are not. */
  private doctypeNameState(): void {
    const cp = this.consume();
    if (isWs(cp)) { this.state = TokenizerState.AfterDoctypeName; return; }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitDoctype(); }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.dtName = (this.dtName ?? '') + String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === EOF) return this.doctypeEof();
    this.dtName = (this.dtName ?? '') + String.fromCodePoint(isUpperAlpha(cp) ? cp + 0x20 : cp);
  }

  /** §13.2.5.56 After DOCTYPE name state — a peek site, like markup
   *  declaration open: it looks ahead six characters for PUBLIC or SYSTEM. */
  private afterDoctypeNameState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitDoctype(); }
    if (cp === EOF) return this.doctypeEof();
    this.reconsume(cp);
    if (this.peekAsciiCaseInsensitive('PUBLIC')) {
      this.advance(6);
      this.state = TokenizerState.AfterDoctypePublicKeyword;
      return;
    }
    if (this.peekAsciiCaseInsensitive('SYSTEM')) {
      this.advance(6);
      this.state = TokenizerState.AfterDoctypeSystemKeyword;
      return;
    }
    // `reconsume` rewinds the cursor but leaves lastLine/lastCol on `cp`, so
    // the error still reports at the character that failed both peeks.
    this.error('invalid-character-sequence-after-doctype-name');
    this.dtForceQuirks = true;
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.57 After DOCTYPE public keyword state. */
  private afterDoctypePublicKeywordState(): void {
    const cp = this.consume();
    if (isWs(cp)) { this.state = TokenizerState.BeforeDoctypePublicIdentifier; return; }
    if (cp === 0x22 || cp === 0x27) {
      this.error('missing-whitespace-after-doctype-public-keyword');
      this.dtPublicId = '';
      this.state = cp === 0x22
        ? TokenizerState.DoctypePublicIdentifierDoubleQuoted
        : TokenizerState.DoctypePublicIdentifierSingleQuoted;
      return;
    }
    if (cp === 0x3e) {
      this.error('missing-doctype-public-identifier');
      this.dtForceQuirks = true;
      this.state = TokenizerState.Data;
      return this.emitDoctype();
    }
    if (cp === EOF) return this.doctypeEof();
    this.error('missing-quote-before-doctype-public-identifier');
    this.dtForceQuirks = true;
    this.reconsume(cp);
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.58 Before DOCTYPE public identifier state. */
  private beforeDoctypePublicIdentifierState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x22 || cp === 0x27) {
      this.dtPublicId = '';
      this.state = cp === 0x22
        ? TokenizerState.DoctypePublicIdentifierDoubleQuoted
        : TokenizerState.DoctypePublicIdentifierSingleQuoted;
      return;
    }
    if (cp === 0x3e) {
      this.error('missing-doctype-public-identifier');
      this.dtForceQuirks = true;
      this.state = TokenizerState.Data;
      return this.emitDoctype();
    }
    if (cp === EOF) return this.doctypeEof();
    this.error('missing-quote-before-doctype-public-identifier');
    this.dtForceQuirks = true;
    this.reconsume(cp);
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.59 and §13.2.5.60, which differ only in the closing quote. */
  private doctypePublicIdentifierState(quote: number): void {
    const cp = this.consume();
    if (cp === quote) { this.state = TokenizerState.AfterDoctypePublicIdentifier; return; }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.dtPublicId = (this.dtPublicId ?? '') + String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === 0x3e) {
      this.error('abrupt-doctype-public-identifier');
      this.dtForceQuirks = true;
      this.state = TokenizerState.Data;
      return this.emitDoctype();
    }
    if (cp === EOF) return this.doctypeEof();
    this.dtPublicId = (this.dtPublicId ?? '') + String.fromCodePoint(cp);
  }

  /** §13.2.5.61 After DOCTYPE public identifier state. */
  private afterDoctypePublicIdentifierState(): void {
    const cp = this.consume();
    if (isWs(cp)) {
      this.state = TokenizerState.BetweenDoctypePublicAndSystemIdentifiers;
      return;
    }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitDoctype(); }
    if (cp === 0x22 || cp === 0x27) {
      this.error('missing-whitespace-between-doctype-public-and-system-identifiers');
      this.dtSystemId = '';
      this.state = cp === 0x22
        ? TokenizerState.DoctypeSystemIdentifierDoubleQuoted
        : TokenizerState.DoctypeSystemIdentifierSingleQuoted;
      return;
    }
    if (cp === EOF) return this.doctypeEof();
    this.error('missing-quote-before-doctype-system-identifier');
    this.dtForceQuirks = true;
    this.reconsume(cp);
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.62 Between DOCTYPE public and system identifiers state. */
  private betweenDoctypeIdentifiersState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitDoctype(); }
    if (cp === 0x22 || cp === 0x27) {
      this.dtSystemId = '';
      this.state = cp === 0x22
        ? TokenizerState.DoctypeSystemIdentifierDoubleQuoted
        : TokenizerState.DoctypeSystemIdentifierSingleQuoted;
      return;
    }
    if (cp === EOF) return this.doctypeEof();
    this.error('missing-quote-before-doctype-system-identifier');
    this.dtForceQuirks = true;
    this.reconsume(cp);
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.63 After DOCTYPE system keyword state. */
  private afterDoctypeSystemKeywordState(): void {
    const cp = this.consume();
    if (isWs(cp)) { this.state = TokenizerState.BeforeDoctypeSystemIdentifier; return; }
    if (cp === 0x22 || cp === 0x27) {
      this.error('missing-whitespace-after-doctype-system-keyword');
      this.dtSystemId = '';
      this.state = cp === 0x22
        ? TokenizerState.DoctypeSystemIdentifierDoubleQuoted
        : TokenizerState.DoctypeSystemIdentifierSingleQuoted;
      return;
    }
    if (cp === 0x3e) {
      this.error('missing-doctype-system-identifier');
      this.dtForceQuirks = true;
      this.state = TokenizerState.Data;
      return this.emitDoctype();
    }
    if (cp === EOF) return this.doctypeEof();
    this.error('missing-quote-before-doctype-system-identifier');
    this.dtForceQuirks = true;
    this.reconsume(cp);
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.64 Before DOCTYPE system identifier state. */
  private beforeDoctypeSystemIdentifierState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x22 || cp === 0x27) {
      this.dtSystemId = '';
      this.state = cp === 0x22
        ? TokenizerState.DoctypeSystemIdentifierDoubleQuoted
        : TokenizerState.DoctypeSystemIdentifierSingleQuoted;
      return;
    }
    if (cp === 0x3e) {
      this.error('missing-doctype-system-identifier');
      this.dtForceQuirks = true;
      this.state = TokenizerState.Data;
      return this.emitDoctype();
    }
    if (cp === EOF) return this.doctypeEof();
    this.error('missing-quote-before-doctype-system-identifier');
    this.dtForceQuirks = true;
    this.reconsume(cp);
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.65 and §13.2.5.66, which differ only in the closing quote. */
  private doctypeSystemIdentifierState(quote: number): void {
    const cp = this.consume();
    if (cp === quote) { this.state = TokenizerState.AfterDoctypeSystemIdentifier; return; }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.dtSystemId = (this.dtSystemId ?? '') + String.fromCodePoint(REPLACEMENT);
      return;
    }
    if (cp === 0x3e) {
      this.error('abrupt-doctype-system-identifier');
      this.dtForceQuirks = true;
      this.state = TokenizerState.Data;
      return this.emitDoctype();
    }
    if (cp === EOF) return this.doctypeEof();
    this.dtSystemId = (this.dtSystemId ?? '') + String.fromCodePoint(cp);
  }

  /** §13.2.5.67 After DOCTYPE system identifier state. Note this is the ONE
   *  bogus-DOCTYPE route that does NOT set force-quirks. */
  private afterDoctypeSystemIdentifierState(): void {
    const cp = this.consume();
    if (isWs(cp)) return;
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitDoctype(); }
    if (cp === EOF) return this.doctypeEof();
    this.error('unexpected-character-after-doctype-system-identifier');
    this.reconsume(cp);
    this.state = TokenizerState.BogusDoctype;
  }

  /** §13.2.5.68 Bogus DOCTYPE state. Note the EOF branch does NOT set
   *  force-quirks and emits no error — unlike every other DOCTYPE state. */
  private bogusDoctypeState(): void {
    const cp = this.consume();
    if (cp === 0x3e) { this.state = TokenizerState.Data; return this.emitDoctype(); }
    if (cp === 0x00) { this.error('unexpected-null-character'); return; }
    if (cp === EOF) { this.emitDoctype(); return this.emitEof(); }
  }

  // ---- CDATA --------------------------------------------------------------

  /** §13.2.5.69 CDATA section state. Reachable only from foreign content and
   *  from the suite's own `CDATA section state` initial state. */
  private cdataSectionState(): void {
    const cp = this.consume();
    if (cp === 0x5d) { this.state = TokenizerState.CdataSectionBracket; return; }
    if (cp === EOF) { this.error('eof-in-cdata'); return this.emitEof(); }
    this.char(cp);
  }

  /** §13.2.5.70 CDATA section bracket state. */
  private cdataSectionBracketState(): void {
    const cp = this.consume();
    if (cp === 0x5d) { this.state = TokenizerState.CdataSectionEnd; return; }
    this.char(0x5d);
    this.reconsume(cp);
    this.state = TokenizerState.CdataSection;
  }

  /** §13.2.5.71 CDATA section end state. */
  private cdataSectionEndState(): void {
    const cp = this.consume();
    if (cp === 0x5d) { this.char(0x5d); return; }
    if (cp === 0x3e) { this.state = TokenizerState.Data; return; }
    this.chars(']]');
    this.reconsume(cp);
    this.state = TokenizerState.CdataSection;
  }

  // ---- alternate content models -------------------------------------------

  /** §13.2.5.2 RCDATA state. It is the ONLY alternate content model that
   *  resolves character references — RAWTEXT, script data and PLAINTEXT all
   *  leave `&amp;` as its five literal characters. One case label apart, and
   *  no rendering reveals the difference until a <title> shows the source. */
  private rcdataState(): void {
    const cp = this.consume();
    if (cp === 0x26) return this.chars(this.characterReference(false));
    if (cp === 0x3c) { this.state = TokenizerState.RCDATALessThanSign; return; }
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(REPLACEMENT); }
    if (cp === EOF) return this.emitEof();
    return this.char(cp);
  }

  /** §13.2.5.3 RAWTEXT state. */
  private rawtextState(): void {
    const cp = this.consume();
    if (cp === 0x3c) { this.state = TokenizerState.RAWTEXTLessThanSign; return; }
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(REPLACEMENT); }
    if (cp === EOF) return this.emitEof();
    return this.char(cp);
  }

  /** §13.2.5.4 Script data state. */
  private scriptDataState(): void {
    const cp = this.consume();
    if (cp === 0x3c) { this.state = TokenizerState.ScriptDataLessThanSign; return; }
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(REPLACEMENT); }
    if (cp === EOF) return this.emitEof();
    return this.char(cp);
  }

  /** §13.2.5.9 and §13.2.5.12, which differ only in the state they fall back
   *  to. Parameterised for the reason `attributeValueQuotedState` already is:
   *  the two sections are identical but for one constant. */
  private contentLessThanSignState(back: TokenizerState, endTagOpen: TokenizerState): void {
    const cp = this.consume();
    if (cp === 0x2f) { this.tempBuffer = ''; this.state = endTagOpen; return; }
    this.char(0x3c);
    this.reconsume(cp);
    this.state = back;
  }

  /** §13.2.5.10, §13.2.5.13, §13.2.5.16 and §13.2.5.24 — one shape, four
   *  sections. */
  private contentEndTagOpenState(back: TokenizerState, endTagName: TokenizerState): void {
    const cp = this.consume();
    if (isAlpha(cp)) {
      this.startTagToken(true);
      this.reconsume(cp);
      this.state = endTagName;
      return;
    }
    this.chars('</');
    this.reconsume(cp);
    this.state = back;
  }

  /** §13.2.5.11, §13.2.5.14, §13.2.5.17 and §13.2.5.25 — one shape, four
   *  sections.
   *
   *  The appropriate-end-tag test is against the last start tag EMITTED, and a
   *  non-matching end tag is not a tag at all: the buffered `</name` is emitted
   *  as CHARACTERS and the content model resumes. That is what keeps a
   *  `</div>` inside a <textarea> visible. */
  private contentEndTagNameState(back: TokenizerState): void {
    const cp = this.consume();
    if (isWs(cp) && this.isAppropriateEndTag()) {
      this.state = TokenizerState.BeforeAttributeName;
      return;
    }
    if (cp === 0x2f && this.isAppropriateEndTag()) {
      this.state = TokenizerState.SelfClosingStartTag;
      return;
    }
    if (cp === 0x3e && this.isAppropriateEndTag()) {
      this.state = TokenizerState.Data;
      return this.emitTag();
    }
    if (isAlpha(cp)) {
      this.tagName += String.fromCodePoint(isUpperAlpha(cp) ? cp + 0x20 : cp);
      this.tempBuffer += String.fromCodePoint(cp);
      return;
    }
    this.chars('</');
    this.chars(this.tempBuffer);
    this.reconsume(cp);
    this.state = back;
  }

  /** §13.2.5.15 Script data less-than sign state — unlike RCDATA's and
   *  RAWTEXT's, it also opens the HTML-comment-like escape. */
  private scriptDataLessThanSignState(): void {
    const cp = this.consume();
    if (cp === 0x2f) {
      this.tempBuffer = '';
      this.state = TokenizerState.ScriptDataEndTagOpen;
      return;
    }
    if (cp === 0x21) {
      this.chars('<!');
      this.state = TokenizerState.ScriptDataEscapeStart;
      return;
    }
    this.char(0x3c);
    this.reconsume(cp);
    this.state = TokenizerState.ScriptData;
  }

  /** §13.2.5.18 Script data escape start state. */
  private scriptDataEscapeStartState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.char(0x2d); this.state = TokenizerState.ScriptDataEscapeStartDash; return; }
    this.reconsume(cp);
    this.state = TokenizerState.ScriptData;
  }

  /** §13.2.5.19 Script data escape start dash state. */
  private scriptDataEscapeStartDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.char(0x2d); this.state = TokenizerState.ScriptDataEscapedDashDash; return; }
    this.reconsume(cp);
    this.state = TokenizerState.ScriptData;
  }

  /** §13.2.5.20 Script data escaped state. */
  private scriptDataEscapedState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.char(0x2d); this.state = TokenizerState.ScriptDataEscapedDash; return; }
    if (cp === 0x3c) { this.state = TokenizerState.ScriptDataEscapedLessThanSign; return; }
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(REPLACEMENT); }
    if (cp === EOF) { this.error('eof-in-script-html-comment-like-text'); return this.emitEof(); }
    return this.char(cp);
  }

  /** §13.2.5.21 Script data escaped dash state. */
  private scriptDataEscapedDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.char(0x2d); this.state = TokenizerState.ScriptDataEscapedDashDash; return; }
    if (cp === 0x3c) { this.state = TokenizerState.ScriptDataEscapedLessThanSign; return; }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.state = TokenizerState.ScriptDataEscaped;
      return this.char(REPLACEMENT);
    }
    if (cp === EOF) { this.error('eof-in-script-html-comment-like-text'); return this.emitEof(); }
    this.state = TokenizerState.ScriptDataEscaped;
    return this.char(cp);
  }

  /** §13.2.5.22 Script data escaped dash dash state. */
  private scriptDataEscapedDashDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) return this.char(0x2d);
    if (cp === 0x3c) { this.state = TokenizerState.ScriptDataEscapedLessThanSign; return; }
    if (cp === 0x3e) { this.state = TokenizerState.ScriptData; return this.char(0x3e); }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.state = TokenizerState.ScriptDataEscaped;
      return this.char(REPLACEMENT);
    }
    if (cp === EOF) { this.error('eof-in-script-html-comment-like-text'); return this.emitEof(); }
    this.state = TokenizerState.ScriptDataEscaped;
    return this.char(cp);
  }

  /** §13.2.5.23 Script data escaped less-than sign state. */
  private scriptDataEscapedLessThanSignState(): void {
    const cp = this.consume();
    if (cp === 0x2f) {
      this.tempBuffer = '';
      this.state = TokenizerState.ScriptDataEscapedEndTagOpen;
      return;
    }
    if (isAlpha(cp)) {
      this.tempBuffer = '';
      this.char(0x3c);
      this.reconsume(cp);
      this.state = TokenizerState.ScriptDataDoubleEscapeStart;
      return;
    }
    this.char(0x3c);
    this.reconsume(cp);
    this.state = TokenizerState.ScriptDataEscaped;
  }

  /** §13.2.5.26 and §13.2.5.31, which differ only in which state the word
   *  "script" selects. Both emit every character they consume. */
  private doubleEscapeTransitionState(onScript: TokenizerState, otherwise: TokenizerState): void {
    const cp = this.consume();
    if (isWs(cp) || cp === 0x2f || cp === 0x3e) {
      this.state = this.tempBuffer === 'script' ? onScript : otherwise;
      return this.char(cp);
    }
    if (isAlpha(cp)) {
      this.tempBuffer += String.fromCodePoint(isUpperAlpha(cp) ? cp + 0x20 : cp);
      return this.char(cp);
    }
    this.reconsume(cp);
    this.state = otherwise;
  }

  /** §13.2.5.27 Script data double escaped state. */
  private scriptDataDoubleEscapedState(): void {
    const cp = this.consume();
    if (cp === 0x2d) { this.state = TokenizerState.ScriptDataDoubleEscapedDash; return this.char(0x2d); }
    if (cp === 0x3c) {
      this.state = TokenizerState.ScriptDataDoubleEscapedLessThanSign;
      return this.char(0x3c);
    }
    if (cp === 0x00) { this.error('unexpected-null-character'); return this.char(REPLACEMENT); }
    if (cp === EOF) { this.error('eof-in-script-html-comment-like-text'); return this.emitEof(); }
    return this.char(cp);
  }

  /** §13.2.5.28 Script data double escaped dash state. */
  private scriptDataDoubleEscapedDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) {
      this.state = TokenizerState.ScriptDataDoubleEscapedDashDash;
      return this.char(0x2d);
    }
    if (cp === 0x3c) {
      this.state = TokenizerState.ScriptDataDoubleEscapedLessThanSign;
      return this.char(0x3c);
    }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.state = TokenizerState.ScriptDataDoubleEscaped;
      return this.char(REPLACEMENT);
    }
    if (cp === EOF) { this.error('eof-in-script-html-comment-like-text'); return this.emitEof(); }
    this.state = TokenizerState.ScriptDataDoubleEscaped;
    return this.char(cp);
  }

  /** §13.2.5.29 Script data double escaped dash dash state. */
  private scriptDataDoubleEscapedDashDashState(): void {
    const cp = this.consume();
    if (cp === 0x2d) return this.char(0x2d);
    if (cp === 0x3c) {
      this.state = TokenizerState.ScriptDataDoubleEscapedLessThanSign;
      return this.char(0x3c);
    }
    if (cp === 0x3e) { this.state = TokenizerState.ScriptData; return this.char(0x3e); }
    if (cp === 0x00) {
      this.error('unexpected-null-character');
      this.state = TokenizerState.ScriptDataDoubleEscaped;
      return this.char(REPLACEMENT);
    }
    if (cp === EOF) { this.error('eof-in-script-html-comment-like-text'); return this.emitEof(); }
    this.state = TokenizerState.ScriptDataDoubleEscaped;
    return this.char(cp);
  }

  /** §13.2.5.30 Script data double escaped less-than sign state. */
  private scriptDataDoubleEscapedLessThanSignState(): void {
    const cp = this.consume();
    if (cp === 0x2f) {
      this.tempBuffer = '';
      this.state = TokenizerState.ScriptDataDoubleEscapeEnd;
      return this.char(0x2f);
    }
    this.reconsume(cp);
    this.state = TokenizerState.ScriptDataDoubleEscaped;
  }
}
