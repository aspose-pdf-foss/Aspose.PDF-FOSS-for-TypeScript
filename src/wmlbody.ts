/** WordprocessingML `document.xml` to a neutral block model (`m2fp.3`),
 *  resolving every paragraph and run through `wmlstyles.ts` and numbering
 *  every list paragraph through `wmlnumbering.ts`. Pure: relationships reach it
 *  through `BodyContext.rel`, which `wmlread.ts` supplies.
 *
 *  **Invariant:** content controls, smart tags and custom XML are TRANSPARENT;
 *  tracked insertions and simple fields are descended AND recorded; deletions
 *  are dropped and recorded; bookmarks, proofing marks and a complex field's
 *  INSTRUCTION are dropped silently; a complex field's RESULT is kept and the
 *  field itself recorded once. Field
 *  state lives on the walker, not the paragraph: a TOC field's instruction
 *  spans paragraphs.
 *
 *  **Invariant (`m2fp.8`):** a HYPERLINK field — complex or simple — LINKS its
 *  result and is not recorded: its instruction is kept (joined across the
 *  `w:instrText` runs Word splits it into) and read once complete, at
 *  `separate`, `end` or the end of the body. `\l` alone is an anchor; with a
 *  target it is that target's fragment. A HYPERLINK naming no target is
 *  recorded like any other field. Where a `w:hyperlink` and a field both
 *  apply, the INNER one wins — which is why an element link carries the field
 *  depth it was entered at.
 *
 *  **Invariant (`m2fp.9`):** a `w:sym` keeps the code point Word stores
 *  (usually U+F0xx) in its OWN font and is recorded — no Unicode table for
 *  symbol fonts is vendored, and inventing one from memory is worse than
 *  carrying what the file says. A `w:ruby` keeps its BASE text only, never the
 *  annotation beside it. A row's `gridBefore`/`gridAfter` are MODELLED, since
 *  they shift its cells; every other row or cell property is reported once on
 *  the table, quiet only about widths and `cnfStyle`.
 *
 *  **Invariant (`m2fp.4`):** tracked changes and simple fields keep their m2fp.3
 *  treatment — the FINAL text is shown — but are recorded, and so are a section
 *  break inside a paragraph and every header/footer reference: the flow engine
 *  renders none of them, and a report that omits them lies about the document.
 *
 *  **Note, measured:** `w:del` and `w:delText` are BOTH dropped, and for
 *  deleted TEXT they are redundant — descending a `w:del` still yields no
 *  text. What only the `w:del` rule stops is a deleted TAB, BREAK or DRAWING,
 *  which is what its test deletes.
 *
 *  **Invariant:** anything else is recorded in `unsupported` by qualified name
 *  and its descendant `w:t` text is KEPT — visible content beats a silently
 *  dropped subtree (`svgdraw.ts`'s rule).
 *
 *  **Invariant:** a relationship that names nothing costs the link or the
 *  image's part, never the text or the image itself, and is recorded. */
import type { NsElement } from './xmlns.js';
import { nsAttr, nsChild, nsFind } from './xmlns.js';
import { parseWml, W, R, A, WP, wAttr, wChild, wChildren, wNum, onOff, hexColor, displayName, type Rgb } from './wmlns.js';
import {
  readParaLayer, readRunLayer, resolveParagraph, resolveRun,
  type ParaProps, type RunProps, type WmlStyles,
} from './wmlstyles.js';
import { ListCounter, levelOf, type WmlNumbering } from './wmlnumbering.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError } from './errors.js';
import { readSectionNotes, type WmlSectionNotes } from './wmlnotes.js';

export type WmlLink = { url: string } | { anchor: string };
/** A link an element (`w:hyperlink`, `w:fldSimple`) applies, and how many complex
 *  fields were open when it was entered — which says which of the two is inner. */
interface LinkScope { link: WmlLink; depth: number }
interface OpenField { state: 'instr' | 'result'; instr: string; decided: boolean; link?: WmlLink }
export interface WmlText { kind: 'text'; text: string; props: RunProps; link?: WmlLink; unmodelled: string[] }
/** A footnote or endnote reference (v9j3.3.2). `props` is the reference run's
 *  resolved style (a mark in bold text is bold); `mark` is a custom mark
 *  (`w:customMarkFollows`), the run's following text. */
export interface WmlNoteRef { kind: 'note'; note: 'footnote' | 'endnote'; id: string; props: RunProps; mark?: string }
export type WmlInline =
  | WmlText
  | WmlNoteRef
  | { kind: 'break'; type: 'line' | 'page' | 'column' }
  | { kind: 'tab' }
  | { kind: 'image'; part?: string; widthPt: number; heightPt: number; alt?: string };
export interface WmlParagraph {
  kind: 'paragraph';
  styleName?: string;
  heading?: number;
  props: ParaProps;
  list?: { numId: number; ilvl: number; ordinal: number; label: string; bullet: boolean };
  inlines: WmlInline[];
  unmodelled: string[];
  /** This paragraph ends a section: that section's note properties (v9j3.3.2). */
  sectionEnd?: WmlSectionNotes;
}
export interface WmlCell { span: number; vMerge?: 'restart' | 'continue'; shading?: Rgb; blocks: WmlBlock[] }
/** `gridBefore`/`gridAfter`: grid columns left empty before the first cell and
 *  after the last — they SHIFT the row's cells, so they are modelled (`m2fp.9`). */
export interface WmlRow { header: boolean; cells: WmlCell[]; gridBefore?: number; gridAfter?: number }
export interface WmlTable { kind: 'table'; gridPt: number[]; rows: WmlRow[]; unmodelled: string[] }
export type WmlBlock = WmlParagraph | WmlTable;
export interface WmlPage { widthPt: number; heightPt: number; margins: { top: number; right: number; bottom: number; left: number } }

export interface BodyRel { target: string; external: boolean; part?: string }
export interface BodyContext {
  styles: WmlStyles;
  numbering: WmlNumbering;
  limits: LoadLimits;
  /** A relationship of the main document part, by Id. */
  rel(id: string): BodyRel | undefined;
}
export interface BodyResult {
  blocks: WmlBlock[]; page?: WmlPage; unsupported: Map<string, number>;
  /** The body's final sectPr's note properties: the LAST section's (v9j3.3.2). */
  lastSection: WmlSectionNotes;
}

const EMU_PER_PT = 12700;
const TWIP = 20;

const DROPPED = new Set([
  'bookmarkStart', 'bookmarkEnd', 'proofErr', 'permStart', 'permEnd',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
  'commentRangeStart', 'commentRangeEnd', 'lastRenderedPageBreak', 'sectPr', 'sdtPr', 'sdtEndPr',
  'rPr', 'pPr', 'tblPr', 'tblGrid', 'trPr', 'tcPr', 'tblPrEx', 'softHyphen', 'instrText', 'delInstrText', 'delText',
  // Word's own number inside a note body: the engine draws the gutter mark (v9j3.3.2).
  'footnoteRef', 'endnoteRef',
]);
const TRANSPARENT = new Set(['smartTag', 'customXml']);
/** Kept to the rules above — `ins`/`moveTo`/`fldSimple` descended, `del`/`moveFrom`
 *  dropped — but RECORDED: the reader shows the final text of a tracked change and
 *  the result of a field, and `m2fp.5` reports that it did (`m2fp.4`). */
const RECORDED = new Set(['ins', 'del', 'moveTo', 'moveFrom', 'fldSimple']);
const DESCENDED_RECORDED = new Set(['ins', 'moveTo', 'fldSimple']);
const QUIET_TBL = new Set(['w:tblW', 'w:tblLook', 'w:tblLayout', 'w:tblCellMar', 'w:tblInd']);
/** Row and cell properties that are modelled, or carry no rendering of their own:
 *  widths (the grid decides them) and `cnfStyle`, which only caches which
 *  conditional table-style formats apply. Anything else is reported ONCE on the
 *  table (`m2fp.9`). */
const QUIET_TR = new Set(['tblHeader', 'gridBefore', 'gridAfter', 'wBefore', 'wAfter', 'cnfStyle']);
const QUIET_TC = new Set(['gridSpan', 'vMerge', 'shd', 'tcW', 'cnfStyle']);

/** The concatenated `w:t` text of every descendant. */
function textOf(el: NsElement): string {
  let s = '';
  for (const c of el.children) s += c.ns === W && c.local === 't' ? c.text : textOf(c);
  return s;
}

/** The switches of a HYPERLINK field that take an argument (ECMA-376 17.16.5.25),
 *  plus the three general switches (17.16.4) — so `\o "tip"` and
 *  `\* MERGEFORMAT` are never read as the target. */
const ARG_SWITCHES = new Set(['\\l', '\\o', '\\t', '\\*', '\\#', '\\@']);

/** A field instruction's tokens (17.16.1): a quoted argument unescapes `\"` and
 *  `\\`; outside quotes a token starting with a backslash is a switch. */
function fieldTokens(instr: string): { text: string; sw: boolean }[] {
  const out: { text: string; sw: boolean }[] = [];
  let i = 0;
  while (i < instr.length) {
    const ch = instr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let s = '';
      for (i++; i < instr.length && instr[i] !== '"'; i++) {
        if (instr[i] === '\\' && (instr[i + 1] === '"' || instr[i + 1] === '\\')) i++;
        s += instr[i];
      }
      i++;
      out.push({ text: s, sw: false });
      continue;
    }
    const start = i;
    while (i < instr.length && !/\s/.test(instr[i])) i++;
    const text = instr.slice(start, i);
    out.push({ text, sw: text.startsWith('\\') });
  }
  return out;
}

/** The link a `HYPERLINK` field instruction names, or `undefined` for any other
 *  field and for a HYPERLINK naming no target. A target with `\l` is the URL
 *  with that fragment, as Word follows it. */
function hyperlinkOf(instr: string): WmlLink | undefined {
  const [name, ...rest] = fieldTokens(instr);
  if (!name || name.sw || name.text.toUpperCase() !== 'HYPERLINK') return undefined;
  let target: string | undefined;
  let anchor: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t.sw) { target ??= t.text; continue; }
    const sw = t.text.toLowerCase();
    if (!ARG_SWITCHES.has(sw)) continue;
    const arg = rest[i + 1];
    if (!arg || arg.sw) continue;
    i++;
    if (sw === '\\l') anchor = arg.text;
  }
  if (target !== undefined && target !== '') return { url: anchor ? `${target}#${anchor}` : target };
  return anchor ? { anchor } : undefined;
}

class Walker {
  readonly unsupported = new Map<string, number>();
  private readonly counter: ListCounter;
  private blocks = 0;
  /** Open complex fields, innermost last: in their instruction or their result,
   *  with the instruction read so far and, once decided, the link it names. */
  private readonly fields: OpenField[] = [];

  constructor(private readonly ctx: BodyContext) {
    this.counter = new ListCounter(ctx.numbering, ctx.styles);
  }

  /** A field still open at the end of the body hid everything after its
   *  `begin` — say so, rather than losing the rest of the document silently. */
  finish(): void {
    if (this.fields.length === 0) return;
    for (const f of this.fields) this.decide(f);
    this.note('w:fldChar (unterminated)');
  }

  /** Read a field's instruction once it is complete: a HYPERLINK naming a
   *  target links its result and is modelled; every other field is recorded. */
  private decide(f: OpenField): void {
    if (f.decided) return;
    f.decided = true;
    const link = hyperlinkOf(f.instr);
    if (link) f.link = link;
    else this.note('w:fldChar');
  }

  /** The link text drawn here carries: the INNERMOST of the element scope and
   *  the open HYPERLINK fields in their result. A field begun at or after the
   *  depth the element was entered at is inside it, and so wins. */
  private linkAt(scope: LinkScope | undefined): WmlLink | undefined {
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      if (scope && i < scope.depth) break;
      if (f.state === 'result' && f.link) return f.link;
    }
    return scope?.link;
  }

  /** A section's header and footer references: never rendered by the flow
   *  engine, so reported rather than silently lost (`m2fp.4`). */
  section(sectPr: NsElement | undefined): void {
    for (const c of sectPr?.children ?? []) {
      if (c.ns === W && (c.local === 'headerReference' || c.local === 'footerReference')) this.note(`w:${c.local}`);
    }
  }

  private note(name: string): void { this.unsupported.set(name, (this.unsupported.get(name) ?? 0) + 1); }
  private countBlock(): void { this.ctx.limits.enforce('maxContainerItems', ++this.blocks, 'document blocks'); }
  private skipping(): boolean { return this.fields.some((f) => f.state === 'instr'); }

  blocksOf(el: NsElement): WmlBlock[] {
    const out: WmlBlock[] = [];
    this.blockChildren(el, out);
    return out;
  }

  private blockChildren(el: NsElement, out: WmlBlock[]): void {
    for (const c of el.children) {
      if (c.ns === W && c.local === 'p') out.push(this.paragraph(c));
      else if (c.ns === W && c.local === 'tbl') out.push(this.table(c));
      else if (c.ns === W && c.local === 'sdt') { const sc = wChild(c, 'sdtContent'); if (sc) this.blockChildren(sc, out); }
      else if (c.ns === W && RECORDED.has(c.local)) {
        this.note(`w:${c.local}`);
        if (DESCENDED_RECORDED.has(c.local)) this.blockChildren(c, out);
      }
      else if (c.ns === W && TRANSPARENT.has(c.local)) this.blockChildren(c, out);
      else if (c.ns === W && DROPPED.has(c.local)) continue;
      else {
        this.note(displayName(c));
        // An open field's instruction hides this text as it hides a run's (m2fp.9).
        const t = textOf(c);
        if (t !== '' && !this.skipping()) out.push(this.plainParagraph(t));
      }
    }
  }

  private plainParagraph(text: string): WmlParagraph {
    this.countBlock();
    const rp = resolveParagraph(this.ctx.styles, undefined, readParaLayer(undefined));
    const rr = resolveRun(this.ctx.styles, rp.styleId, undefined, readRunLayer(undefined));
    return { kind: 'paragraph', props: rp.props, inlines: [{ kind: 'text', text, props: rr.props, unmodelled: rr.unmodelled }], unmodelled: rp.unmodelled };
  }

  private paragraph(p: NsElement): WmlParagraph {
    this.countBlock();
    const { styles, numbering } = this.ctx;
    const pPr = wChild(p, 'pPr');
    const sect = wChild(pPr, 'sectPr');
    if (sect) { this.note('w:sectPr'); this.section(sect); }
    const rp = resolveParagraph(styles, wAttr(wChild(pPr, 'pStyle'), 'val'), readParaLayer(pPr),
      (id, l) => levelOf(numbering, styles, id, l)?.ppr);
    const inlines: WmlInline[] = [];
    this.inlineChildren(p, inlines, rp.styleId, undefined);
    const para: WmlParagraph = { kind: 'paragraph', props: rp.props, inlines, unmodelled: [...rp.unmodelled] };
    if (sect) para.sectionEnd = readSectionNotes(sect);
    if (rp.styleName !== undefined) para.styleName = rp.styleName;
    if (rp.heading !== undefined) para.heading = rp.heading;
    if (rp.numId !== undefined) {
      const label = this.counter.next(rp.numId, rp.ilvl);
      if (!label) this.note('w:numPr (undefined list)');
      else {
        para.list = { numId: rp.numId, ilvl: rp.ilvl, ordinal: label.ordinal, label: label.label, bullet: label.bullet };
        if (label.unmodelledFormat) para.unmodelled.push(label.unmodelledFormat);
      }
    }
    return para;
  }

  private inlineChildren(el: NsElement, out: WmlInline[], pStyle: string | undefined, link: LinkScope | undefined): void {
    for (const c of el.children) {
      if (c.ns === W && c.local === 'r') this.run(c, out, pStyle, link);
      else if (c.ns === W && c.local === 'hyperlink') this.inlineChildren(c, out, pStyle, this.scope(this.linkOf(c)) ?? link);
      else if (c.ns === W && c.local === 'sdt') { const sc = wChild(c, 'sdtContent'); if (sc) this.inlineChildren(sc, out, pStyle, link); }
      else if (c.ns === W && c.local === 'fldSimple') {
        const fl = hyperlinkOf(wAttr(c, 'instr') ?? '');
        if (!fl) this.note('w:fldSimple');
        this.inlineChildren(c, out, pStyle, this.scope(fl) ?? link);
      }
      else if (c.ns === W && RECORDED.has(c.local)) {
        this.note(`w:${c.local}`);
        if (DESCENDED_RECORDED.has(c.local)) this.inlineChildren(c, out, pStyle, link);
      }
      else if (c.ns === W && TRANSPARENT.has(c.local)) this.inlineChildren(c, out, pStyle, link);
      else if (c.ns === W && DROPPED.has(c.local)) continue;
      else {
        this.note(displayName(c));
        if (textOf(c) !== '') this.inlineChildren(c, out, pStyle, link);
      }
    }
  }

  private scope(link: WmlLink | undefined): LinkScope | undefined {
    return link ? { link, depth: this.fields.length } : undefined;
  }

  private linkOf(h: NsElement): WmlLink | undefined {
    const rid = nsAttr(h, R, 'id');
    if (rid !== undefined) {
      const rel = this.ctx.rel(rid);
      if (rel) return { url: rel.target };
      this.note('w:hyperlink (unresolved r:id)');
      return undefined;
    }
    const anchor = wAttr(h, 'anchor');
    return anchor !== undefined ? { anchor } : undefined;
  }

  private run(r: NsElement, out: WmlInline[], pStyle: string | undefined, scope: LinkScope | undefined): void {
    const rPr = wChild(r, 'rPr');
    const rr = resolveRun(this.ctx.styles, pStyle, wAttr(wChild(rPr, 'rStyle'), 'val'), readRunLayer(rPr));
    let current: WmlText | undefined;
    const text = (s: string): void => {
      if (this.skipping() || s === '') return;
      if (current) { current.text += s; return; }
      current = { kind: 'text', text: s, props: rr.props, unmodelled: rr.unmodelled };
      const link = this.linkAt(scope);
      if (link) current.link = link;
      out.push(current);
    };
    const other = (i: WmlInline): void => { if (!this.skipping()) { out.push(i); current = undefined; } };
    // w:customMarkFollows (v9j3.3.2): the run's next w:t is the note's mark.
    let awaitingMark: WmlNoteRef | undefined;
    for (const c of r.children) {
      if (c.ns !== W) { this.note(displayName(c)); text(textOf(c)); continue; }
      switch (c.local) {
        case 't':
          if (awaitingMark) { if (!this.skipping()) awaitingMark.mark = c.text; awaitingMark = undefined; break; }
          text(c.text);
          break;
        case 'footnoteReference':
        case 'endnoteReference': {
          const id = wAttr(c, 'id');
          if (id === undefined || this.skipping()) break;
          const ref: WmlNoteRef = { kind: 'note', note: c.local === 'footnoteReference' ? 'footnote' : 'endnote', id, props: rr.props };
          other(ref);
          const cmf = wAttr(c, 'customMarkFollows');
          if (cmf === '1' || cmf === 'true' || cmf === 'on') awaitingMark = ref;
          break;
        }
        case 'tab': other({ kind: 'tab' }); break;
        case 'br': { const t = wAttr(c, 'type'); other({ kind: 'break', type: t === 'page' ? 'page' : t === 'column' ? 'column' : 'line' }); break; }
        case 'cr': other({ kind: 'break', type: 'line' }); break;
        case 'noBreakHyphen': text('‑'); break;
        case 'drawing': if (!this.skipping()) { this.drawing(c, out); current = undefined; } break;
        case 'sym': {
          // The glyph lives in a symbol font at a code Word stores (usually
          // U+F0xx); no Unicode table for those fonts is vendored, so it is
          // kept as stored, in its own font, and recorded (m2fp.9).
          this.note('w:sym');
          const code = /^[0-9A-Fa-f]{1,6}$/.test(wAttr(c, 'char') ?? '') ? parseInt(wAttr(c, 'char')!, 16) : undefined;
          if (code === undefined || code === 0 || code > 0x10ffff) break;
          const font = wAttr(c, 'font');
          const sym: WmlText = { kind: 'text', text: String.fromCodePoint(code), props: font ? { ...rr.props, font } : rr.props, unmodelled: rr.unmodelled };
          const link = this.linkAt(scope);
          if (link) sym.link = link;
          other(sym);
          break;
        }
        case 'ruby': {
          // The annotation (w:rt) is not drawn above its base; only the base
          // text is kept, so the two never run together (m2fp.9).
          this.note('w:ruby');
          const base = wChild(c, 'rubyBase');
          if (base) text(textOf(base));
          break;
        }
        case 'fldChar': this.fldChar(c); break;
        case 'instrText': {
          const top = this.fields[this.fields.length - 1];
          if (top?.state === 'instr') top.instr += c.text;
          break;
        }
        default:
          if (DROPPED.has(c.local)) break;
          this.note(`w:${c.local}`);
          text(textOf(c));
      }
    }
  }

  private fldChar(c: NsElement): void {
    const type = wAttr(c, 'fldCharType');
    const top = this.fields[this.fields.length - 1];
    if (type === 'begin') this.fields.push({ state: 'instr', instr: '', decided: false });
    else if (type === 'separate' && top) { top.state = 'result'; this.decide(top); }
    else if (type === 'end' && top) { this.decide(top); this.fields.pop(); }
  }

  private drawing(d: NsElement, out: WmlInline[]): void {
    const holder = d.children.find((c) => c.ns === WP && (c.local === 'inline' || c.local === 'anchor'));
    const blip = nsFind(holder, A, 'blip');
    if (!holder || !blip) { this.note('w:drawing (not a picture)'); return; }
    if (holder.local === 'anchor') this.note('w:drawing (anchor)');
    const ext = nsChild(holder, WP, 'extent');
    const emu = (v: string | undefined): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n / EMU_PER_PT : 0; };
    const img: Extract<WmlInline, { kind: 'image' }> = {
      kind: 'image', widthPt: emu(nsAttr(ext, '', 'cx')), heightPt: emu(nsAttr(ext, '', 'cy')),
    };
    const rid = nsAttr(blip, R, 'embed');
    const rel = rid === undefined ? undefined : this.ctx.rel(rid);
    if (rel?.part !== undefined && !rel.external) img.part = rel.part;
    else this.note('a:blip (unresolved image)');
    const alt = nsAttr(nsChild(holder, WP, 'docPr'), '', 'descr');
    if (alt) img.alt = alt;
    out.push(img);
  }

  private table(t: NsElement): WmlTable {
    this.countBlock();
    const unmodelled = (wChild(t, 'tblPr')?.children ?? [])
      .map((c) => (c.ns === W ? `w:${c.local}` : displayName(c))).filter((n) => !QUIET_TBL.has(n));
    const gridPt = wChildren(wChild(t, 'tblGrid'), 'gridCol').map((g) => (wNum(g, 'w') ?? 0) / TWIP);
    const rows: WmlRow[] = [];
    const inner = new Set<string>();
    const collectRows = (el: NsElement): void => {
      for (const c of el.children) {
        if (c.ns === W && c.local === 'tr') rows.push(this.row(c, inner));
        else if (c.ns === W && c.local === 'sdt') { const sc = wChild(c, 'sdtContent'); if (sc) collectRows(sc); }
        else if (c.ns === W && RECORDED.has(c.local)) {
          this.note(`w:${c.local}`);
          if (DESCENDED_RECORDED.has(c.local)) collectRows(c);
        }
        else if (c.ns === W && TRANSPARENT.has(c.local)) collectRows(c);
        else if (!(c.ns === W && DROPPED.has(c.local))) this.note(displayName(c));
      }
    };
    collectRows(t);
    for (const n of inner) if (!unmodelled.includes(n)) unmodelled.push(n);
    return { kind: 'table', gridPt, rows, unmodelled };
  }

  private row(tr: NsElement, unmodelled: Set<string>): WmlRow {
    const trPr = wChild(tr, 'trPr');
    const header = onOff(wChild(trPr, 'tblHeader')) === true;
    propNames(trPr, QUIET_TR, unmodelled);
    const cells: WmlCell[] = [];
    const collectCells = (el: NsElement): void => {
      for (const c of el.children) {
        if (c.ns === W && c.local === 'tc') cells.push(this.cell(c, unmodelled));
        else if (c.ns === W && c.local === 'sdt') { const sc = wChild(c, 'sdtContent'); if (sc) collectCells(sc); }
        else if (c.ns === W && RECORDED.has(c.local)) {
          this.note(`w:${c.local}`);
          if (DESCENDED_RECORDED.has(c.local)) collectCells(c);
        }
        else if (c.ns === W && TRANSPARENT.has(c.local)) collectCells(c);
        else if (!(c.ns === W && DROPPED.has(c.local))) this.note(displayName(c));
      }
    };
    collectCells(tr);
    const row: WmlRow = { header, cells };
    const before = gridCount(wChild(trPr, 'gridBefore')); if (before) row.gridBefore = before;
    const after = gridCount(wChild(trPr, 'gridAfter')); if (after) row.gridAfter = after;
    return row;
  }

  private cell(tc: NsElement, unmodelled: Set<string>): WmlCell {
    const tcPr = wChild(tc, 'tcPr');
    propNames(tcPr, QUIET_TC, unmodelled);
    const span = wNum(wChild(tcPr, 'gridSpan'));
    const cell: WmlCell = { span: span !== undefined && span >= 1 ? Math.floor(span) : 1, blocks: this.blocksOf(tc) };
    const vm = wChild(tcPr, 'vMerge');
    if (vm) cell.vMerge = wAttr(vm, 'val') === 'restart' ? 'restart' : 'continue';
    const shd = hexColor(wAttr(wChild(tcPr, 'shd'), 'fill'));
    if (shd) cell.shading = shd;
    return cell;
  }
}

/** The names of a property element's children that are not quiet. */
function propNames(pr: NsElement | undefined, quiet: ReadonlySet<string>, into: Set<string>): void {
  for (const c of pr?.children ?? []) if (!(c.ns === W && quiet.has(c.local))) into.add(c.ns === W ? `w:${c.local}` : displayName(c));
}

/** A positive whole number of grid columns, or undefined. */
function gridCount(el: NsElement | undefined): number | undefined {
  const n = wNum(el);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

function pageOf(sectPr: NsElement | undefined): WmlPage | undefined {
  const sz = wChild(sectPr, 'pgSz');
  const w = wNum(sz, 'w');
  const h = wNum(sz, 'h');
  if (w === undefined || h === undefined || w <= 0 || h <= 0) return undefined;
  const mar = wChild(sectPr, 'pgMar');
  const m = (k: string): number => (wNum(mar, k) ?? 0) / TWIP;
  return { widthPt: w / TWIP, heightPt: h / TWIP, margins: { top: m('top'), right: m('right'), bottom: m('bottom'), left: m('left') } };
}

export function parseBody(bytes: Uint8Array, ctx: BodyContext): BodyResult {
  const root = parseWml(bytes, ctx.limits);
  if (root.ns !== W || root.local !== 'document') throw new PdfParseError('document.xml: the root is not w:document');
  const body = wChild(root, 'body');
  const walker = new Walker(ctx);
  const blocks = body ? walker.blocksOf(body) : [];
  walker.finish();
  walker.section(wChild(body, 'sectPr'));
  const page = pageOf(wChild(body, 'sectPr'));
  const lastSection = readSectionNotes(wChild(body, 'sectPr'));
  return page ? { blocks, page, unsupported: walker.unsupported, lastSection } : { blocks, unsupported: walker.unsupported, lastSection };
}

/** footnotes.xml / endnotes.xml (v9j3.3.2): each note's blocks by `w:id`,
 *  through the SAME Walker the body uses — so a note's lists, tables, images
 *  and links resolve by the body's rules — with `ctx.rel` being THIS part's
 *  relationships. Separator entries (`w:type` separator, continuationSeparator,
 *  continuationNotice) are skipped: the engine draws its own rule. */
export function parseNotes(bytes: Uint8Array, ctx: BodyContext, kind: 'footnote' | 'endnote'): { notes: Map<string, WmlBlock[]>; unsupported: Map<string, number> } {
  const root = parseWml(bytes, ctx.limits);
  const plural = `${kind}s`;
  if (root.ns !== W || root.local !== plural) throw new PdfParseError(`${plural}.xml: the root is not w:${plural}`);
  const walker = new Walker(ctx);
  const notes = new Map<string, WmlBlock[]>();
  for (const n of wChildren(root, kind)) {
    const type = wAttr(n, 'type');
    if (type !== undefined && type !== 'normal') continue;
    const id = wAttr(n, 'id');
    if (id === undefined || notes.has(id)) continue;
    notes.set(id, walker.blocksOf(n));
  }
  walker.finish();
  return { notes, unsupported: walker.unsupported };
}
