import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  PdfObject, PdfDict, PdfRef, isDict, isRef, isName, isArray, isString, name,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { visitContent, assembleLines, runFromGlyph, scriptByGlyph, type GlyphEvent, type Run, type Rect } from './text.js';
import type { Annotation } from './annotation.js';
import { ElemOpts, createElement, kArray, allocContentMcid, tagAnnotation, markContentRegion } from './structwrite.js';
import {
  TableAttributes, ListAttributes, LayoutAttributes,
  readTable, writeTable, readList, writeList, readLayout, writeLayout,
} from './structattr.js';

/** The PDF 1.7 standard structure types (grouping, block-level, inline-level,
 *  and illustration). Used by IsStandardType and to terminate RoleMap chains. */
export const STANDARD_STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  // Grouping
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC',
  'TOCI', 'Index', 'NonStruct', 'Private',
  // Block-level
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody',
  'Table', 'TR', 'TH', 'TD', 'THead', 'TBody', 'TFoot',
  // Inline-level
  'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code', 'Link', 'Annot',
  'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP',
  // Illustration
  'Figure', 'Formula', 'Form',
]);

/** A marked-content reference owned by a structure element. */
export type ContentItem =
  | { kind: 'mcid'; page: Page | undefined; mcid: number }
  | { kind: 'objr'; page: Page | undefined; ref: PdfRef };

/** A run of text contributed directly by a structure element, with the page it sits on. */
export interface StructTextNode {
  kind: 'text'; text: string; page: Page;
  /** True when the run's font declares itself bold / italic (see `fontStyleOf`).
   *  Absent rather than false. One MCID may yield SEVERAL of these — see
   *  `styledRuns`. */
  bold?: boolean; italic?: boolean;
  /** Sub/superscript, absent rather than false. Unlike the emphasis flags this
   *  is NOT derivable from this run's own glyphs: it is measured against the
   *  LINE, so it comes from a per-page pass (`scriptByGlyph`) rather than from
   *  the font. `docmodel.ts` reads it without knowing the difference, since
   *  `docText` already spreads whatever style bag it is handed. */
  script?: 'sub' | 'super';
}

/** A structure element's direct kid: a child element or a run of its own text. */
export type StructNode = StructElement | StructTextNode;

/** A /K entry as `Nodes` sees it, before its text is resolved. */
interface TextItem { kind: 'text'; page: Page | undefined; mcid: number }
interface ElemItem { kind: 'elem'; el: StructElement }
type NodeItem = TextItem | ElemItem;

/** Normalize a struct element's /K into an array of entries. /K may be a single
 *  item (int / dict / ref), an array, or absent. */
function kids(doc: Document, dict: PdfDict): PdfObject[] {
  const k = dict.get('K'); // keep refs un-resolved so we can build child elems
  if (k === undefined) return [];
  const resolved = doc.resolve(k);
  if (isArray(resolved)) return resolved;
  return [k];
}

/** True when a resolved /K entry is itself a structure element (has /S). */
function isStructElem(doc: Document, o: PdfObject): boolean {
  const d = doc.resolve(o);
  return isDict(d) && d.has('S');
}

/** A node in the structure tree: a live handle over its real /StructElem dict. */
export class StructElement {
  constructor(
    private readonly doc: Document,
    /** The live structure-element dict. */
    readonly Dict: PdfDict,
    /** This element's indirect ref, when it has one. */
    readonly Ref: PdfRef | undefined,
    /** The owning structure tree root (for RoleMap resolution). */
    readonly Root: StructTreeRoot,
  ) {}

  /** The raw structure type (/S), e.g. 'P', 'H1', or a custom role name. */
  get Type(): string {
    const s = this.doc.resolve(this.Dict.get('S'));
    return isName(s) ? s.name : '';
  }

  /** The structure type resolved through the RoleMap chain to a standard type. */
  get StandardType(): string {
    return this.Root.ResolveRole(this.Type);
  }

  /** Whether StandardType is a known PDF 1.7 standard structure type. */
  get IsStandardType(): boolean {
    return STANDARD_STRUCTURE_TYPES.has(this.StandardType);
  }

  /** The parent element, or undefined when the parent is the tree root. */
  get Parent(): StructElement | undefined {
    const pRef = this.Dict.get('P');
    const p = this.doc.resolve(pRef);
    if (!isDict(p) || !p.has('S')) return undefined; // root or missing
    return new StructElement(this.doc, p, isRef(pRef) ? pRef : undefined, this.Root);
  }

  /** Child elements only (integers, MCR, and OBJR content items excluded). */
  get Children(): StructElement[] {
    const out: StructElement[] = [];
    for (const k of kids(this.doc, this.Dict)) {
      if (!isStructElem(this.doc, k)) continue;
      const d = this.doc.resolve(k) as PdfDict;
      out.push(new StructElement(this.doc, d, isRef(k) ? k : undefined, this.Root));
    }
    return out;
  }

  /** Title (/T). */
  get Title(): string | undefined { return textValue(this.doc, this.Dict.get('T')); }
  /** Alternate description (/Alt). */
  get Alt(): string | undefined { return textValue(this.doc, this.Dict.get('Alt')); }
  /** Replacement text (/ActualText). */
  get ActualText(): string | undefined { return textValue(this.doc, this.Dict.get('ActualText')); }
  /** Abbreviation expansion (/E). */
  get Expansion(): string | undefined { return textValue(this.doc, this.Dict.get('E')); }
  /** Element identifier (/ID). */
  get ID(): string | undefined { return textValue(this.doc, this.Dict.get('ID')); }
  /** This element's own language (/Lang), if set. */
  get Lang(): string | undefined { return textValue(this.doc, this.Dict.get('Lang')); }

  /** Language resolved up the ancestor chain, then the document default. */
  get EffectiveLang(): string | undefined {
    let node: StructElement | undefined = this;
    while (node) {
      const l = node.Lang;
      if (l !== undefined) return l;
      node = node.Parent;
    }
    return this.doc.Lang;
  }

  /** The page this element's content lives on (/Pg, inherited from ancestors). */
  get Page(): Page | undefined {
    let node: StructElement | undefined = this;
    while (node) {
      const pg = node.Dict.get('Pg');
      if (isRef(pg)) return this.doc.pageForRef(pg);
      node = node.Parent;
    }
    return undefined;
  }

  /** Raw attribute objects: /A (attribute dicts/streams) and /C (class names). */
  get Attributes(): { A: PdfObject[]; C: PdfObject[] } {
    const toArr = (v: PdfObject | undefined): PdfObject[] => {
      if (v === undefined) return [];
      const r = this.doc.resolve(v);
      return isArray(r) ? r : [v];
    };
    return { A: toArr(this.Dict.get('A')), C: toArr(this.Dict.get('C')) };
  }

  /** The marked-content references (/K integers, MCR dicts, OBJR dicts). */
  get ContentItems(): ContentItem[] {
    const out: ContentItem[] = [];
    const ownPage = this.Page;
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        out.push({ kind: 'mcid', page: ownPage, mcid: r });
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        const typeName = isName(type) ? type.name : '';
        if (typeName === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          if (typeof mcid === 'number') {
            const pg = r.get('Pg');
            out.push({ kind: 'mcid', page: isRef(pg) ? this.doc.pageForRef(pg) : ownPage, mcid });
          }
        } else if (typeName === 'OBJR') {
          const obj = r.get('Obj');
          if (isRef(obj)) {
            const pg = r.get('Pg');
            out.push({ kind: 'objr', page: isRef(pg) ? this.doc.pageForRef(pg) : ownPage, ref: obj });
          }
        }
      }
    }
    return out;
  }

  /** This element's direct kids in /K (reading) order: child elements and its
   *  own text runs, interleaved as authored. OBJR kids are skipped — they carry
   *  no text, matching `GetText`. Unlike `Children` + `ContentItems`, this
   *  preserves the order between the two, which a renderer needs. */
  get Nodes(): StructNode[] {
    const ownPage = this.Page;
    const items: NodeItem[] = [];
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        items.push({ kind: 'text', page: ownPage, mcid: r });
      } else if (isStructElem(this.doc, k)) {
        items.push({
          kind: 'elem',
          el: new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root),
        });
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        if (isName(type) && type.name === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          const pg = r.get('Pg');
          if (typeof mcid === 'number')
            items.push({ kind: 'text', page: isRef(pg) ? this.doc.pageForRef(pg) : ownPage, mcid });
        }
        // OBJR: no text contribution.
      }
    }

    const interleaved = this.interleave(items);
    if (interleaved) return interleaved;

    const out: StructNode[] = [];
    for (const it of items) {
      if (it.kind === 'elem') { out.push(it.el); continue; }
      if (!it.page) continue;
      // spacedText, not glyphsToText: an inline element's own run carries the
      // space that separates it from its neighbour — `(the docs )` inside a
      // /Link — and dropping it joins the words either side of the link.
      // One MCID may yield several nodes, one per style run.
      // Memoized per page, so asking per item costs nothing after the first.
      const idx = mcidIndex(this.doc, it.page);
      out.push(...styledRuns(idx.byMcid.get(it.mcid) ?? [], it.page, idx.script));
    }
    return out;
  }

  /** `Nodes` with each own-text run SPLIT around the child sequences nested
   *  inside it, or undefined when that cannot be done safely.
   *
   *  **Invariant:** a child element's marked content is commonly nested inside
   *  its parent's, so the parent's glyphs sit on BOTH sides of it in the content
   *  stream — a `/Link` in the middle of a paragraph is the everyday case.
   *  Grouping by MCID alone loses where the child sat, which emitted the whole
   *  paragraph and then appended the link, relocating it to the end of the
   *  sentence. The per-glyph content order recovers the split point.
   *
   *  Returns undefined — falling back to /K order — when any element child
   *  contributes no glyphs at all (a `/Figure` whose `/K` is an `/OBJR`, say).
   *  Such a child has no content position to sort by, and guessing one could
   *  reorder content rather than merely failing to split it. */
  private interleave(items: NodeItem[]): StructNode[] | undefined {
    const texts = items.filter((i): i is TextItem => i.kind === 'text');
    const elems = items.filter((i): i is ElemItem => i.kind === 'elem');
    if (!texts.length || !elems.length) return undefined;

    // Every own-text run must be on one page, and every child must sit on it.
    const page = texts[0].page;
    if (!page || texts.some((t) => t.page !== page)) return undefined;
    const idx = mcidIndex(this.doc, page);

    const starts: number[] = [];
    for (const e of elems) {
      const at = firstGlyphOrder(this.doc, e.el, page);
      if (at === undefined) return undefined;
      starts.push(at);
    }

    const out: StructNode[] = [];
    const emit = (glyphs: GlyphEvent[]): void => {
      out.push(...styledRuns(glyphs, page, idx.script));
    };

    // Walk own glyphs and children together in content order. Children keep
    // their /K order among themselves, which is the reading order the producer
    // declared; only the text is cut around them.
    const own: { g: GlyphEvent; at: number }[] = [];
    for (const t of texts) {
      const gs = idx.byMcid.get(t.mcid) ?? [];
      const os = idx.order.get(t.mcid) ?? [];
      gs.forEach((g, i) => own.push({ g, at: os[i] ?? 0 }));
    }
    own.sort((a, b) => a.at - b.at);

    let cursor = 0;
    elems.forEach((e, i) => {
      const at = starts[i];
      const before: GlyphEvent[] = [];
      while (cursor < own.length && own[cursor].at < at) before.push(own[cursor++].g);
      emit(before);
      out.push(e.el);
    });
    emit(own.slice(cursor).map((o) => o.g));
    return out;
  }

  /** This element's text and its descendants', in /K (reading) order. */
  GetText(skip?: (e: StructElement) => boolean): string {
    const parts: string[] = [];
    const ownPage = this.Page;
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        if (ownPage) parts.push(glyphsToText(mcidGlyphs(this.doc, ownPage).get(r) ?? []));
      } else if (isStructElem(this.doc, k)) {
        const child = new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root);
        if (skip?.(child)) continue;
        parts.push(child.GetText(skip));
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        if (isName(type) && type.name === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          const pg = r.get('Pg');
          const page = isRef(pg) ? this.doc.pageForRef(pg) : ownPage;
          if (typeof mcid === 'number' && page) {
            parts.push(glyphsToText(mcidGlyphs(this.doc, page).get(mcid) ?? []));
          }
        }
        // OBJR: no text contribution.
      }
    }
    return parts.filter((s) => s.length > 0).join('\n');
  }

  /** Union of the page-space quads of every glyph behind this element's marked
   *  content (recursing into descendant elements), or undefined when it
   *  contributes no glyphs. `page` defaults to this element's own /Pg page. */
  GetBBox(page?: Page): [number, number, number, number] | undefined {
    const glyphs: GlyphEvent[] = [];
    this.collectGlyphs(page ?? this.Page, glyphs);
    if (!glyphs.length) return undefined;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of glyphs) {
      x0 = Math.min(x0, g.quad[0]); y0 = Math.min(y0, g.quad[1]);
      x1 = Math.max(x1, g.quad[2]); y1 = Math.max(y1, g.quad[3]);
    }
    return [x0, y0, x1, y1];
  }

  private collectGlyphs(ownPage: Page | undefined, out: GlyphEvent[]): void {
    for (const k of kids(this.doc, this.Dict)) {
      const r = this.doc.resolve(k);
      if (typeof r === 'number') {
        if (ownPage) out.push(...(mcidGlyphs(this.doc, ownPage).get(r) ?? []));
      } else if (isStructElem(this.doc, k)) {
        const child = new StructElement(this.doc, r as PdfDict, isRef(k) ? k : undefined, this.Root);
        child.collectGlyphs(child.Page ?? ownPage, out);
      } else if (isDict(r)) {
        const type = this.doc.resolve(r.get('Type'));
        if (isName(type) && type.name === 'MCR') {
          const mcid = this.doc.resolve(r.get('MCID'));
          const pg = r.get('Pg');
          const page = isRef(pg) ? this.doc.pageForRef(pg) : ownPage;
          if (typeof mcid === 'number' && page) out.push(...(mcidGlyphs(this.doc, page).get(mcid) ?? []));
        }
        // OBJR: no glyph contribution.
      }
    }
  }

  /** Create a child structure element of `type` under this one; returns its handle. */
  Append(type: string, opts?: ElemOpts): StructElement {
    if (this.Ref === undefined) throw new Error('cannot append to an element with no ref');
    const k = kArray(this.doc, this.Dict);
    const { dict, ref: r } = createElement(this.doc, type, this.Ref, k, opts);
    return new StructElement(this.doc, dict, r, this.Root);
  }

  private setText(key: string, v: string | undefined): void {
    if (v === undefined) this.Dict.delete(key);
    else this.Dict.set(key, { kind: 'string', bytes: encodePdfText(v) });
    this.doc.markModified();
  }

  set Alt(v: string | undefined) { this.setText('Alt', v); }
  set ActualText(v: string | undefined) { this.setText('ActualText', v); }
  set Lang(v: string | undefined) { this.setText('Lang', v); }
  set Title(v: string | undefined) { this.setText('T', v); }
  set Expansion(v: string | undefined) { this.setText('E', v); }
  set ID(v: string | undefined) { this.setText('ID', v); }

  /** Allocate the next MCID for `page` against this element and wire the
   *  /ParentTree + /K. Returns the MCID — emit `/<Type> << /MCID n >> BDC … EMC`
   *  around the marked content yourself (escape hatch for hand-built content). */
  NextMcid(page: Page): number {
    return allocContentMcid(this.doc, this, page);
  }

  /** Tag existing page content under this element: allocate an MCID and wrap the
   *  top-level show/`Do` ops whose content falls in `region` in
   *  `/<Type> <</MCID n>> BDC … EMC`. Returns the MCID, or -1 when the region has
   *  no top-level content. */
  MarkContent(page: Page, region: Rect): number {
    return markContentRegion(this.doc, this, page, region);
  }

  /** Tag an annotation (e.g. a Link) under this element via /StructParent + OBJR.
   *  The annotation must already be added to its page. */
  AddAnnotation(annotation: Annotation): void {
    tagAnnotation(this.doc, this, annotation);
  }

  /** Interpreted /Table attributes (/A + /C merged), or undefined when none. */
  get TableAttributes(): TableAttributes | undefined {
    return readTable(this.doc, this.Root, this.Dict);
  }

  /** Merge table attributes into this element's /A (a field set to undefined
   *  deletes that key). */
  SetTableAttributes(attrs: Partial<TableAttributes>): void {
    writeTable(this.doc, this.Dict, attrs);
  }

  /** Interpreted /List attributes, or undefined when none. */
  get ListAttributes(): ListAttributes | undefined {
    return readList(this.doc, this.Root, this.Dict);
  }

  /** Merge list attributes into this element's /A. */
  SetListAttributes(attrs: Partial<ListAttributes>): void {
    writeList(this.doc, this.Dict, attrs);
  }

  /** Interpreted /Layout attributes, or undefined when none. */
  get LayoutAttributes(): LayoutAttributes | undefined {
    return readLayout(this.doc, this.Root, this.Dict);
  }

  /** Merge layout attributes into this element's /A. */
  SetLayoutAttributes(attrs: Partial<LayoutAttributes>): void {
    writeLayout(this.doc, this.Dict, attrs);
  }
}

/** The document's logical structure tree: a live handle over /StructTreeRoot. */
export class StructTreeRoot {
  /** Custom role -> mapped role name, from /RoleMap (values are name strings). */
  readonly RoleMap: Map<string, string>;
  /** Class name -> attribute object, from /ClassMap (raw, unresolved values). */
  readonly ClassMap: Map<string, PdfObject>;

  constructor(
    private readonly doc: Document,
    readonly Dict: PdfDict,
    readonly Ref: PdfRef | undefined,
  ) {
    this.RoleMap = new Map();
    const rm = doc.resolve(Dict.get('RoleMap'));
    if (isDict(rm)) {
      for (const [k, v] of rm) {
        const mapped = doc.resolve(v);
        if (isName(mapped)) this.RoleMap.set(k, mapped.name);
      }
    }
    this.ClassMap = new Map();
    const cm = doc.resolve(Dict.get('ClassMap'));
    if (isDict(cm)) for (const [k, v] of cm) this.ClassMap.set(k, v);
  }

  /** Follow the RoleMap chain from `role` to a standard structure type.
   *  Stops at the first standard type, at an unmapped name, or on a cycle. */
  ResolveRole(role: string): string {
    let cur = role;
    const seen = new Set<string>();
    while (!STANDARD_STRUCTURE_TYPES.has(cur) && this.RoleMap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.RoleMap.get(cur)!;
    }
    return cur;
  }

  /** The element for a page's marked content: ParentTree[structParentsKey] is
   *  an array indexed by MCID. */
  ElementFor(structParentsKey: number, mcid: number): StructElement | undefined {
    const pt = this.doc.resolve(this.Dict.get('ParentTree'));
    if (!isDict(pt)) return undefined;
    const v = this.doc.resolve(lookupNumberTree(this.doc, pt, structParentsKey));
    if (!isArray(v)) return undefined;
    const entryRef = v[mcid];
    const d = this.doc.resolve(entryRef);
    if (!isDict(d) || !d.has('S')) return undefined;
    return new StructElement(this.doc, d, isRef(entryRef) ? entryRef : undefined, this);
  }

  /** The element for an object (annotation / XObject) via its /StructParent key:
   *  ParentTree[structParentKey] is the element directly. */
  ElementForObject(structParentKey: number): StructElement | undefined {
    const pt = this.doc.resolve(this.Dict.get('ParentTree'));
    if (!isDict(pt)) return undefined;
    const entryRef = lookupNumberTree(this.doc, pt, structParentKey);
    const d = this.doc.resolve(entryRef);
    if (!isDict(d) || !d.has('S')) return undefined;
    return new StructElement(this.doc, d, isRef(entryRef) ? entryRef : undefined, this);
  }

  /** Top-level structure elements (the tree's /K). */
  get Children(): StructElement[] {
    const out: StructElement[] = [];
    for (const k of kids(this.doc, this.Dict)) {
      if (!isStructElem(this.doc, k)) continue;
      const d = this.doc.resolve(k) as PdfDict;
      out.push(new StructElement(this.doc, d, isRef(k) ? k : undefined, this));
    }
    return out;
  }

  /** The whole tree's text, in reading order. */
  GetText(): string {
    return this.Children.map((c) => c.GetText()).filter((s) => s.length > 0).join('\n');
  }

  /** Create a top-level structure element of `type` and return its handle. */
  Append(type: string, opts?: ElemOpts): StructElement {
    if (this.Ref === undefined) throw new Error('StructTreeRoot has no ref');
    const k = kArray(this.doc, this.Dict);
    const { dict, ref: r } = createElement(this.doc, type, this.Ref, k, opts);
    return new StructElement(this.doc, dict, r, this);
  }

  /** Map a custom structure type `custom` to a standard type `standard` in the
   *  /RoleMap (writes the dict and updates the in-memory map). */
  RegisterRole(custom: string, standard: string): void {
    let rm = this.doc.resolve(this.Dict.get('RoleMap'));
    if (!isDict(rm)) { rm = new Map<string, PdfObject>(); this.Dict.set('RoleMap', rm); }
    (rm as PdfDict).set(custom, name(standard));
    this.RoleMap.set(custom, standard);
    this.doc.markModified();
  }
}

/** Per-page cache of MCID -> glyph events, built from one content walk. */
/** Per page: each MCID's glyphs, and the content-order index of each of those
 *  glyphs. The indices are what let `Nodes` split a parent's run around a child
 *  sequence nested inside it — the MCID grouping alone cannot say where the
 *  child sat, only that both exist. Built in ONE walk, since a second
 *  `visitContent` per page would double the cost of every structure read. */
interface McidIndex {
  byMcid: Map<number, GlyphEvent[]>;
  /** Parallel to `byMcid`: order[m][i] is the content position of byMcid[m][i]. */
  order: Map<number, number[]>;
  /** Each glyph's sub/superscript, for the glyphs that read as one.
   *
   *  Built from EVERY glyph the page draws, not just the MCID-bearing ones, and
   *  built here rather than in `styledRuns` because the classification needs the
   *  whole line and `styledRuns` sees one MCID. Free of an extra content walk:
   *  this index already makes one, and it is memoized per page. */
  script: Map<GlyphEvent, 'sub' | 'super'>;
}
const mcidCache = new WeakMap<Page, McidIndex>();

function mcidIndex(doc: Document, page: Page): McidIndex {
  const cached = mcidCache.get(page);
  if (cached) return cached;
  const byMcid = new Map<number, GlyphEvent[]>();
  const order = new Map<number, number[]>();
  // Every glyph in content order, MCID-bearing or not: the script rule measures
  // a run against its LINE, and a line is what a reader sees rather than what
  // the structure tree claims. Excluding untagged neighbours would give a
  // marker a different answer here than on an untagged page.
  const all: GlyphEvent[] = [];
  let n = 0;
  visitContent(doc, page, {
    glyph: (e: GlyphEvent) => {
      all.push(e);
      if (e.mcid === undefined || !e.text) return;
      const list = byMcid.get(e.mcid) ?? [];
      const ords = order.get(e.mcid) ?? [];
      list.push(e);
      ords.push(n++);
      byMcid.set(e.mcid, list);
      order.set(e.mcid, ords);
    },
    // What the document SHOWS. `StructElement.Nodes` is the tagged half of
    // every export — HTML, Markdown, DOCX, EPUB — so without this a tagged
    // document keeps emitting text on a switched-off layer while an untagged one
    // does not. There is no opt-out here because `Nodes` is a GETTER and cannot
    // carry one; a caller wanting what the file CONTAINS reads `mapRegions` or
    // `searchText`, which can.
    //
    // The `scriptByGlyph` line rule below stays honest under it: the untagged
    // path now excludes the same glyphs, so a marker gets the same answer on
    // both — which is what that rule's "a line is a visual fact" means.
  }, { skipHidden: true });
  const idx: McidIndex = { byMcid, order, script: scriptByGlyph(all) };
  mcidCache.set(page, idx);
  return idx;
}

function mcidGlyphs(doc: Document, page: Page): Map<number, GlyphEvent[]> {
  return mcidIndex(doc, page).byMcid;
}

/** The content position of the first glyph anywhere under `el` on `page`, or
 *  undefined when it draws none there. */
function firstGlyphOrder(doc: Document, el: StructElement, page: Page): number | undefined {
  const idx = mcidIndex(doc, page);
  let best: number | undefined;
  const visit = (e: StructElement): void => {
    for (const item of e.ContentItems) {
      if (item.kind !== 'mcid' || item.page !== page) continue;
      const first = idx.order.get(item.mcid)?.[0];
      if (first !== undefined && (best === undefined || first < best)) best = first;
    }
    for (const c of e.Children) visit(c);
  };
  visit(el);
  return best;
}

/** A glyph run's text, keeping the leading and trailing spaces the run drew.
 *
 *  `assembleLines` lays glyphs out as lines and drops whitespace at a line's
 *  edges, which is right for a whole element and wrong for a FRAGMENT of one:
 *  the space before a nested link is the only thing separating it from the word
 *  before, so dropping it renders `See the docs here.` as `Seethe docshere.`.
 *  The raw glyph text is consulted only for those two edges — everything
 *  between still goes through the layout. */
function spacedText(glyphs: GlyphEvent[]): string {
  const text = glyphsToText(glyphs);
  if (!text) return text;
  const raw = glyphs.map((g) => g.text).join('');
  const lead = /^\s/.test(raw) && !/^\s/.test(text) ? ' ' : '';
  const tail = /\s$/.test(raw) && !/\s$/.test(text) ? ' ' : '';
  return `${lead}${text}${tail}`;
}

/** Split a glyph run into maximal pieces sharing a style, each still built by
 *  `spacedText`.
 *
 *  **Invariant:** the split is on the derived STYLE, not on the font object. A
 *  document that sets one face through two font objects, or alternates between
 *  two regular faces, must not fragment into a run per font — that multiplies
 *  runs downstream for no visible difference, and every new boundary is another
 *  edge whose separator space has to be got right.
 *
 *  **Invariant:** each piece goes through `spacedText`, so the leading and
 *  trailing spaces a run drew survive. `assembleLines` drops whitespace at a
 *  line's edges, which is right for a whole element and wrong for a fragment of
 *  one — the `(the docs )` case. Splitting a run in three is three more chances
 *  to lose those spaces.
 *
 *  **Invariant:** script joins the split key but does NOT come from the font.
 *  It is measured against the whole line, so it arrives already decided in
 *  `script` — this function only reads it. A footnote marker sharing its
 *  neighbours' face is the case that needs the extra key: nothing about the
 *  font changes across it, so on the emphasis key alone it would be swallowed
 *  into one run with the body text either side of it. */
function styledRuns(
  glyphs: GlyphEvent[], page: Page, script: Map<GlyphEvent, 'sub' | 'super'>,
): StructTextNode[] {
  const out: StructTextNode[] = [];
  let start = 0;
  const emit = (from: number, to: number): void => {
    if (to <= from) return;
    const piece = glyphs.slice(from, to);
    const text = spacedText(piece);
    if (!text) return;
    const { bold, italic } = piece[0].font;
    const sc = script.get(piece[0]);
    out.push({
      kind: 'text', text, page,
      ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}),
      ...(sc ? { script: sc } : {}),
    });
  };
  for (let i = 1; i <= glyphs.length; i++) {
    const prev = glyphs[i - 1];
    const next = glyphs[i];
    if (next && next.font.bold === prev.font.bold && next.font.italic === prev.font.italic
      && script.get(next) === script.get(prev)) continue;
    emit(start, i);
    start = i;
  }
  return out;
}

/** Assemble a glyph list into text via the shared line layout. */
function glyphsToText(glyphs: GlyphEvent[]): string {
  const runs: Run[] = glyphs.map((e) => runFromGlyph(e));
  return assembleLines(runs);
}

/** Decode a PDF text-string value to JS text, or undefined when not a string. */
export function textValue(doc: Document, v: PdfObject | undefined): string | undefined {
  const s = doc.resolve(v);
  return isString(s) ? decodePdfText(s.bytes) : undefined;
}

/** Look up `key` in a PDF number tree rooted at `node` (/Nums leaves, /Kids
 *  with /Limits for intermediate nodes). Returns the (unresolved) value or
 *  undefined. */
export function lookupNumberTree(doc: Document, node: PdfDict, key: number): PdfObject | undefined {
  let cur: PdfDict | undefined = node;
  const seen = new Set<PdfDict>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const nums = doc.resolve(cur.get('Nums'));
    if (isArray(nums)) {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        if (doc.resolve(nums[i]) === key) return nums[i + 1];
      }
    }
    const kidsArr = doc.resolve(cur.get('Kids'));
    if (!isArray(kidsArr)) return undefined;
    let next: PdfDict | undefined;
    for (const k of kidsArr) {
      const kd = doc.resolve(k);
      if (!isDict(kd)) continue;
      const lim = doc.resolve(kd.get('Limits'));
      if (isArray(lim) && lim.length === 2) {
        const lo = doc.resolve(lim[0]); const hi = doc.resolve(lim[1]);
        if (typeof lo === 'number' && typeof hi === 'number' && key >= lo && key <= hi) {
          next = kd; break;
        }
      }
    }
    cur = next;
  }
  return undefined;
}
