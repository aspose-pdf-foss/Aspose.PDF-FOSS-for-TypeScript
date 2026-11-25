import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ExtractedParagraph } from './paragraphread.js';
import { EditableContent } from './editcontent.js';
import type { ContentSplice, ContentOpSource } from './content.js';
import { decodePageContentStreams, pageContentStreams } from './pagecontent.js';
import { sameStream, snapshotStream, type StreamSource } from './paths.js';
import { inflateStream } from './flate.js';
import { rethrowLimit, UnsupportedFeatureError } from './errors.js';
import { buildFragments, mul, visitPageBytes, walkOpts, type ExtractOptions, type GlyphEvent, type TextFragment } from './text.js';
import { insertTextPositions, planReplace, scopeStream } from './textedit.js';
import { checkRestyle, type TextRestyle } from './textrestyle.js';
import type { ShowInsert } from './replaceadjust.js';
import { alignedLineX } from './reflowwrap.js';
import type { PdfDict } from './types.js';

export interface EditableTextFragment extends TextFragment {
  ReplaceText(text: string): void;
  Restyle(style: TextRestyle): void;
  /** Translate the selected drawing in PDF page points. */
  MoveBy(dx: number, dy: number): void;
}

type Alignment = 'left' | 'center' | 'right' | 'justify' | 'fullJustify';
export interface EditableParagraph extends ExtractedParagraph {
  /** Align existing lines inside the bounds captured by GetParagraphs(). */
  Align(alignment: Alignment): void;
}

interface PageOrigin {
  doc: WeakRef<Document>;
  dict: WeakRef<PdfDict>;
  top: StreamSource[];
  forms: Map<string, StreamSource>;
  options: ExtractOptions;
}
interface Origin { page: PageOrigin; glyphs: GlyphEvent[]; }
const origins = new WeakMap<TextFragment, Origin>();
const stale = () => new RangeError('Text target is stale. Read the fragments or paragraphs again.');
const unsupported = (reason: string) => new UnsupportedFeatureError('Cannot edit this text target: ' + reason);
const location = (g: GlyphEvent) => JSON.stringify([g.addr, g.drawnBy, g.elementIndex, g.byteStart]);
const drawing = (g: GlyphEvent) => JSON.stringify([g.addr.streamIndex, g.addr.path, g.drawnBy]);

/** Public fragment read. The private glyph ranges come from the pass that actually grouped them. */
export function editableFragments(doc: Document, page: Page, opts?: ExtractOptions): EditableTextFragment[] {
  const glyphs: GlyphEvent[] = [];
  const streams = pageContentStreams(doc, page);
  const bytes = decodePageContentStreams(streams);
  visitPageBytes(doc, page, { glyph: g => glyphs.push(g) }, walkOpts(opts), bytes);
  const spans: [number, number][] = [];
  const fragments = buildFragments(glyphs, spans);
  if (!fragments.length) return [];
  const source: PageOrigin = { doc: new WeakRef(doc), dict: new WeakRef(page.Dict),
    top: streams.map((s, i) => snapshotStream(s, bytes[i])), forms: new Map(), options: { includeHidden: opts?.includeHidden } };
  for (const [i, fragment] of fragments.entries()) {
    const [from, to] = spans[i];
    const members = glyphs.slice(from, to);
    for (const g of members) {
      for (let n = 1; n <= g.addr.path.length; n++) {
        const path = g.addr.path.slice(0, n), key = JSON.stringify(path);
        if (source.forms.has(key)) continue;
        const stream = scopeStream(doc, page, path);
        if (stream) source.forms.set(key, snapshotStream(stream, inflateStream(stream)));
      }
    }
    origins.set(fragment, { page: source, glyphs: members });
    Object.defineProperties(fragment, fragmentMethods);
  }
  return fragments as EditableTextFragment[];
}

function livePage(origin: PageOrigin) {
  const doc = origin.doc.deref(), dict = origin.dict.deref();
  const number = doc && dict && doc.pageNumberOf(dict);
  if (!doc || !number) throw stale();
  const page = doc.Pages[number - 1], streams = pageContentStreams(doc, page);
  if (streams.length !== origin.top.length || streams.some((s, i) => s !== origin.top[i].stream.deref())) throw stale();
  try {
    const bytes = decodePageContentStreams(streams);
    if (streams.every((s, i) => sameStream(origin.top[i], s, bytes[i]))) return { doc, page, bytes };
  } catch (caught) { rethrowLimit(caught); }
  throw stale();
}

function glyphState(g: GlyphEvent): string {
  return JSON.stringify([g.text, g.code, g.cid, g.byteLen, g.quad, g.penEnd, g.tm, g.tlm, g.ctm,
    g.tfKey, g.tfSize, g.charSpacing, g.wordSpacing, g.hscale, g.vertical, g.renderMode, g.color,
    g.fillState, g.strokeState, g.font.name, g.font.bold, g.font.italic]);
}

/** Resolve a batch once, using source addresses even when the labels and bounds coincide. */
function resolveFragments(fragments: TextFragment[]) {
  const originsForEdit = fragments.map(f => {
    const origin = origins.get(f);
    if (!origin) throw stale();
    return origin;
  });
  const source = originsForEdit[0].page;
  if (originsForEdit.some(o => o.page !== source)) throw unsupported('multiple page sources');
  const { doc, page, bytes } = livePage(source);
  const wanted = new Map<string, GlyphEvent | undefined>();
  const checked = new Set<string>();
  for (const { glyphs } of originsForEdit) {
    for (const g of glyphs) {
      wanted.set(location(g), undefined);
      for (let n = 1; n <= g.addr.path.length; n++) {
        const path = g.addr.path.slice(0, n), key = JSON.stringify(path);
        if (checked.has(key)) continue;
        const form = scopeStream(doc, page, path), snapshot = source.forms.get(key);
        if (!form || !snapshot || form !== snapshot.stream.deref()) throw stale();
        let matches = false;
        try { matches = sameStream(snapshot, form, inflateStream(form)); }
        catch (caught) { rethrowLimit(caught); }
        if (!matches) throw stale();
        checked.add(key);
      }
    }
  }
  visitPageBytes(doc, page, { glyph(g) {
    const key = location(g);
    if (!wanted.has(key)) return;
    if (wanted.get(key)) throw unsupported('ambiguous glyph address');
    wanted.set(key, g);
  } }, walkOpts(source.options), bytes);
  const groups = originsForEdit.map(o => o.glyphs.map(old => {
    const g = wanted.get(location(old));
    if (!g || g.font.dict !== old.font.dict || glyphState(old) !== glyphState(g)) throw stale();
    if (g.vertical || !g.text) throw unsupported('vertical or unmapped glyph');
    if ((g.renderMode ?? 0) >= 4) throw unsupported('the glyphs establish a clipping path');
    return g;
  }));
  return { doc, page, groups };
}

function singlePart(gs: GlyphEvent[]): void {
  const first = gs[0], scope = drawing(first);
  let next = first.byteStart;
  for (const g of gs) {
    if (drawing(g) !== scope || g.addr.opIndex !== first.addr.opIndex || g.elementIndex !== first.elementIndex || g.byteStart !== next)
      throw unsupported('multi-part fragment');
    next += g.byteLen;
  }
}

function replaceFragment(this: TextFragment, text: string): void {
  if (typeof text !== 'string') throw new TypeError('Fragment replacement must be a string');
  const { doc, page, groups: [gs] } = resolveFragments([this]);
  singlePart(gs);
  planReplace(doc, page, page.Number, '', text, {}, gs).apply();
}

function restyleFragment(this: TextFragment, style: TextRestyle): void {
  const doc = origins.get(this)?.page.doc.deref();
  if (!doc) throw stale();
  const { opts, request } = checkRestyle(doc, { ...style }, undefined);
  const { page, groups: [gs] } = resolveFragments([this]);
  singlePart(gs);
  planReplace(doc, page, page.Number, '', request, opts, gs).apply();
}

interface Shift { glyph: GlyphEvent; dx: number; dy: number; }

/** TJ changes the along-baseline pen and Ts changes the perpendicular offset.
 * Undo both at the byte boundary, leaving the text line matrix intact for T*. */
function positioning(shifts: Shift[]): Map<number, ShowInsert[]> {
  const byOp = new Map<number, ShowInsert[]>();
  for (let i = 0; i < shifts.length; i++) {
    const { glyph: g, dx, dy } = shifts[i];
    if (!dx && !dy) continue;
    const [a, b, c, d, e, f] = mul(g.tm, g.ctm), det = a * d - b * c;
    const kern = -1000 * (d * dx - c * dy) / (det * g.tfSize * g.hscale);
    const rise = (a * (g.quad[1] - f) - b * (g.quad[0] - e)) / det;
    const raised = rise + (a * dy - b * dx) / det;
    if (![kern, rise, raised].every(Number.isFinite)) throw unsupported('singular text transform');
    const list = byOp.get(g.addr.opIndex) ?? [];
    byOp.set(g.addr.opIndex, list);
    const add = (byteStart: number, piece: ShowInsert['piece']) =>
      list.push({ addr: g.addr, elementIndex: g.elementIndex, byteStart, piece });
    if (raised !== rise) add(g.byteStart, { kind: 'op', op: { operator: 'Ts', operands: [raised] } });
    if (kern) add(g.byteStart, { kind: 'kern', value: kern });
    // One pair encloses a whole stretch of the same show string. A new word
    // in justified text can have a different shift and starts its own pair.
    let end = g.byteStart + g.byteLen;
    while (i + 1 < shifts.length) {
      const next = shifts[i + 1];
      if (next.dx !== dx || next.dy !== dy || next.glyph.addr.opIndex !== g.addr.opIndex ||
          next.glyph.elementIndex !== g.elementIndex || next.glyph.byteStart !== end) break;
      end += next.glyph.byteLen;
      i++;
    }
    if (kern) add(end, { kind: 'kern', value: -kern });
    if (raised !== rise) add(end, { kind: 'op', op: { operator: 'Ts', operands: [rise] } });
  }
  return byOp;
}

function moveGlyphs(doc: Document, page: Page, shifts: Shift[]): void {
  const first = shifts[0].glyph, scope = drawing(first);
  if (shifts.some(s => drawing(s.glyph) !== scope)) throw unsupported('multiple content streams or Form drawings');
  const edits = positioning(shifts);
  if (!edits.size) return;
  const indexes = [...edits.keys()].sort((a, b) => a - b);
  const rewrite = (source: ContentOpSource): ContentSplice => {
    const first = indexes[0], end = indexes[indexes.length - 1] + 1;
    const ops = source.ops.slice(first, end).flatMap((op, i) => {
      const inserts = edits.get(i + first);
      return inserts ? insertTextPositions(op, inserts) : [op];
    });
    return { first, end, ops };
  };
  const ec = new EditableContent(doc, page);
  if (first.drawnBy?.length) ec.editFormOccurrence(first.drawnBy, rewrite);
  else {
    const slot = first.addr.streamIndex, source = ec.topSource(slot);
    const edit = rewrite(source);
    ec.writeTopStreams(new Map([[slot, source.replace(edit.first, edit.end, edit.ops)]]));
  }
}

function moveFragment(this: TextFragment, dx: number, dy: number): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('MoveBy requires two finite offsets');
  const { doc, page, groups: [gs] } = resolveFragments([this]);
  singlePart(gs);
  moveGlyphs(doc, page, gs.map(glyph => ({ glyph, dx, dy })));
}

const fragmentMethods = {
  ReplaceText: { value: replaceFragment }, Restyle: { value: restyleFragment }, MoveBy: { value: moveFragment },
};

/** Capture lines and bounds before exposing their mutable read snapshots. */
export function editableParagraph(p: ExtractedParagraph): EditableParagraph {
  const joined = !!p.continuations?.length;
  const left = p.quad[0], right = p.quad[2];
  const lines = p.lines.map(line => ({ left: line.quad[0], right: line.quad[2], fragments: [...line.fragments] }));
  const align = (mode: Alignment) => {
    if (!['left', 'center', 'right', 'justify', 'fullJustify'].includes(mode)) throw new TypeError('Unknown paragraph alignment');
    if (joined) throw unsupported('joined paragraph has multiple source rectangles');
    const { doc, page, groups } = resolveFragments(lines.flatMap(l => l.fragments));
    const shifts: Shift[] = [];
    let index = 0;
    for (const [i, line] of lines.entries()) {
      const gs = groups.slice(index, index + line.fragments.length).flat();
      index += line.fragments.length;
      if (gs.some(g => Math.abs(g.angle) > 1e-6)) throw unsupported('paragraph alignment requires horizontal lines');
      const justify = mode === 'fullJustify' || (mode === 'justify' && i < lines.length - 1);
      const gaps = new Set<GlyphEvent>();
      for (let j = 1; j < gs.length; j++) {
        const prev = gs[j - 1], g = gs[j];
        const gap = g.quad[0] - prev.penEnd[0];
        if (gap < -Math.max(0.01, g.fontSize / 4)) throw unsupported('overlapping text makes the line order ambiguous');
        if (g.text.trim() && (!prev.text.trim() || gap > g.fontSize / 4)) gaps.add(g);
      }
      const spare = (right - left) - (line.right - line.left);
      let dx = alignedLineX(mode === 'fullJustify' ? 'justify' : mode, left, right, line.right - line.left, left) - line.left;
      for (const g of gs) {
        if (justify && gaps.has(g)) dx += spare / gaps.size;
        shifts.push({ glyph: g, dx, dy: 0 });
      }
    }
    moveGlyphs(doc, page, shifts);
  };
  Object.defineProperty(p, 'Align', { value: align });
  return p as EditableParagraph;
}
