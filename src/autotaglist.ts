import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import type { TextRegion } from './autotagannot.js';
import { centerInside, TEXT_STATE } from './autotagpaint.js';
import { classifyBlock, isCodeLine, markerOf, pageMetrics, type LineMarker } from './docinfer.js';
import { dominantSize } from './textrank.js';
import { blockFromLines, layoutLines, runFromGlyph, visitContent, type GlyphEvent, type Rect, type TextBlock, type TextLine } from './text.js';
import { EditableContent } from './editcontent.js';
import type { ContentOp, ContentOpSource, ContentSplice, ContentWrap } from './content.js';
import { isArray, name, type PdfObject, type PdfString } from './types.js';
import type { ListAttributes } from './structattr.js';

/** Structured text breaks a paragraph on a left-edge shift of two line
 *  heights. A normal sublist can exceed that alone. Keep adjacent marked
 *  boundaries together at normal leading, within six line heights of indent
 *  so that a list in a remote column cannot corroborate this one. */
export function listCandidateBlocks(blocks: TextBlock[]): TextBlock[] {
  const result: TextBlock[] = [];
  for (let i = 0; i < blocks.length;) {
    const block = blocks[i++];
    let last = block.lines.at(-1), combined: TextLine[] | undefined;
    while (last && i < blocks.length) {
      const next = blocks[i].lines[0];
      if (!next || !markerOf(last) || !markerOf(next) || isCodeLine(last) || isCodeLine(next)) break;
      const size = Math.max(last.quad[3] - last.quad[1], next.quad[3] - next.quad[1]) || 1;
      const gap = last.quad[1] - next.quad[1], indent = Math.abs(last.quad[0] - next.quad[0]);
      if (gap <= 0 || gap > 1.6 * size || indent <= 2 * size || indent > 6 * size) break;
      combined ??= [...block.lines];
      for (const line of blocks[i].lines) combined.push(line);
      last = blocks[i++].lines.at(-1);
    }
    result.push(combined ? blockFromLines(combined) : block);
  }
  return result;
}

function visibleGlyphs(doc: Document, page: Page): GlyphEvent[] {
  const glyphs: GlyphEvent[] = [];
  visitContent(doc, page, { glyph: g => { if (!g.artifact) glyphs.push(g); } }, { skipHidden: true });
  return glyphs;
}

interface LineParts { label: number[]; body: number[] }

// Only accept a boundary proved by the glyphs that produced the extracted
// text. A synthesized space has no glyph; a single glyph that decodes to
// both marker and body cannot be divided at that Unicode boundary.
function lineParts(line: TextLine, glyphs: GlyphEvent[], boundary: number): LineParts | undefined {
  const ids: number[] = [];
  for (const [i, g] of glyphs.entries()) {
    if (!centerInside(g.quad, line.quad)) continue;
    if (g.addr.path.length || g.mcid !== undefined || g.vertical || Math.abs(g.angle) > 0.01) return undefined;
    if (g.text) ids.push(i);
  }
  const { text, refs } = layoutLines(ids.map(i => runFromGlyph(glyphs[i], i)));
  if (text !== line.text.trimEnd() || boundary >= text.length) return undefined;
  const bodyStart = refs[boundary];
  if (bodyStart === undefined || (boundary > 0 && bodyStart === refs[boundary - 1])) return undefined;
  ids.sort((a, b) => glyphs[a].quad[0] - glyphs[b].quad[0]);
  // An operator must draw one contiguous run in its original byte order.
  // Refuse a TJ that kerns backwards through other text, or across two lines.
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i], g = glyphs[id];
    if ((sameShow(glyphs[id - 1], g) && ids[i - 1] !== id - 1)
      || (sameShow(glyphs[id + 1], g) && ids[i + 1] !== id + 1)) return undefined;
  }
  const at = ids.indexOf(bodyStart);
  return { label: ids.slice(0, at), body: ids.slice(at) };
}

function sameShow(a: GlyphEvent | undefined, b: GlyphEvent): boolean {
  return a !== undefined && !a.addr.path.length && a.addr.streamIndex === b.addr.streamIndex && a.addr.opIndex === b.addr.opIndex;
}

type Numbering = NonNullable<ListAttributes['listNumbering']>;
function numbering(marker: LineMarker, label: string, prior?: Numbering): Numbering {
  if (!marker.ordered) return label === '◦' ? 'Circle' : label === '▪' ? 'Square' : 'Disc';
  if (marker.ordinal !== undefined) return 'Decimal';
  const upper = label === label.toUpperCase();
  const letters = label.replace(/[^a-z]/gi, '');
  // A single C can be the third letter or a Roman numeral. Let its list's
  // established style decide; a list starting with i conventionally uses Roman.
  if (/^[ivxlcdm]+$/i.test(letters) && (letters.length > 1 || prior?.endsWith('Roman')
    || (!prior?.endsWith('Alpha') && /^i$/i.test(letters)))) return upper ? 'UpperRoman' : 'LowerRoman';
  return upper ? 'UpperAlpha' : 'LowerAlpha';
}

interface Marks { before: ContentOp[]; after: ContentOp[]; middle: ContentOp[]; cut?: GlyphEvent }
const end: ContentOp = { operator: 'EMC', operands: [] };

/** Divide the encoded string at a decoded glyph's byte offset. Retain every
 *  TJ displacement and apply a quote operator's line move and spacing once. */
function divideShow(op: ContentOp, at: GlyphEvent): [ContentOp, ContentOp] {
  const argIndex = op.operator === '"' ? 2 : 0;
  const arg = op.operands[argIndex];
  const pieces = isArray(arg) ? arg : [arg];
  const s = pieces[at.elementIndex] as PdfString;
  const left = [...pieces.slice(0, at.elementIndex), { kind: 'string' as const, bytes: s.bytes.subarray(0, at.byteStart) }];
  const right = [{ kind: 'string' as const, bytes: s.bytes.subarray(at.byteStart) }, ...pieces.slice(at.elementIndex + 1)];
  if (isArray(arg)) return [{ operator: 'TJ', operands: [left] }, { operator: 'TJ', operands: [right] }];
  return [{ operator: op.operator, operands: [...op.operands.slice(0, argIndex), ...left] }, { operator: 'Tj', operands: right }];
}

function listPainter(doc: Document, page: Page, glyphs: GlyphEvent[]) {
  const ec = new EditableContent(doc, page);
  const streams = new Map<number, Map<number, Marks>>();
  const sources = new Map<number, ContentOpSource>();
  const sourceOf = (index: number): ContentOpSource => {
    let source = sources.get(index);
    if (!source) sources.set(index, source = ec.topSource(index));
    return source;
  };
  const marks = (g: GlyphEvent): Marks => {
    const { streamIndex, opIndex } = g.addr;
    let stream = streams.get(streamIndex);
    if (!stream) streams.set(streamIndex, stream = new Map());
    let mark = stream.get(opIndex);
    if (!mark) stream.set(opIndex, mark = { before: [], after: [], middle: [] });
    return mark;
  };
  const markPart = (ids: number[], owner: StructElement): void => {
    for (let i = 0; i < ids.length;) {
      const first = ids[i++];
      let last = first;
      // Text-state changes inside a word do not interrupt its MCID. Graphics
      // and marked-content operators, or crossing a stream boundary, do.
      while (i < ids.length && ids[i] === last + 1) {
        const a = glyphs[last].addr, b = glyphs[ids[i]].addr;
        if (b.streamIndex !== a.streamIndex || b.opIndex < a.opIndex) break;
        if (b.opIndex > a.opIndex + 1 && !sourceOf(a.streamIndex).ops.slice(a.opIndex + 1, b.opIndex)
          .every(op => TEXT_STATE.has(op.operator))) break;
        last = ids[i++];
      }
      const g = glyphs[first], h = glyphs[last];
      const open: ContentOp = { operator: 'BDC', operands: [name(owner.Type),
        new Map<string, PdfObject>([['MCID', owner.NextMcid(page)]])] };
      const start = marks(g), finish = marks(h);
      if (sameShow(glyphs[first - 1], g)) { start.cut = g; start.middle.push(open); }
      else start.before.push(open);
      if (sameShow(glyphs[last + 1], h)) finish.middle.push(end);
      else finish.after.push(end);
    }
  };
  const commit = (): void => {
    const bytes = new Map<number, Uint8Array>();
    for (const [stream, edits] of streams) {
      const source = sourceOf(stream), splices: (ContentSplice | ContentWrap)[] = [];
      for (const [i, m] of edits) {
        if (m.cut) {
          const [left, right] = divideShow(source.ops[i], m.cut);
          splices.push({ first: i, end: i + 1, ops: [...m.before, left, ...m.middle, right, ...m.after] });
        } else {
          splices.push({ first: i, end: i + 1, before: m.before, after: m.after });
        }
      }
      bytes.set(stream, source.replaceAll(splices));
    }
    ec.writeTopStreams(bytes);
  };
  return { markPart, commit };
}

/** Infer one block in reading order. Preflight the encoded marker boundaries
 *  before appending anything so an inseparable line retains its prose tag. */
export function tagListBlock(doc: Document, root: StructTreeRoot, page: Page, block: TextBlock,
  regions: TextRegion[] | undefined, emitProse: (lines: TextLine[]) => void): number {
  const bodySize = dominantSize(block);
  const classes = classifyBlock(block.lines, { bodySize, metrics: pageMetrics([block], bodySize) });
  if (!classes.some(c => c.kind === 'item')) return 0;
  const glyphs = visibleGlyphs(doc, page), lines: (LineParts | undefined)[] = [];
  const used = new Set<number>();
  for (const [i, c] of classes.entries()) {
    if (c.kind !== 'item' && c.kind !== 'continuation') continue;
    const mapped = lineParts(block.lines[i], glyphs, c.kind === 'item' ? c.marker.textStart : 0);
    if (!mapped || (c.kind === 'item' && !mapped.label.length)) return 0;
    for (const id of [...mapped.label, ...mapped.body]) {
      if (used.has(id)) return 0;
      used.add(id);
    }
    lines[i] = mapped;
  }

  const painter = listPainter(doc, page, glyphs);
  const record = (ids: number[], owner: StructElement): void => {
    // Allocate in reading order, before a nested L is appended to this body.
    painter.markPart(ids, owner);
    if (!regions) return;
    const quad: Rect = [...glyphs[ids[0]].quad];
    for (const id of ids) {
      const r = glyphs[id].quad;
      quad[0] = Math.min(quad[0], r[0]); quad[1] = Math.min(quad[1], r[1]);
      quad[2] = Math.max(quad[2], r[2]); quad[3] = Math.max(quad[3], r[3]);
    }
    regions.push({ quad, owner });
  };
  const stack: { depth: number; list: StructElement; body: StructElement; style: Numbering }[] = [];
  let count = 0, prose: TextLine[] = [];
  for (const [i, c] of classes.entries()) {
    const line = block.lines[i], mapped = lines[i];
    if (!mapped) { prose.push(line); stack.length = 0; continue; }
    if (prose.length) { emitProse(prose); prose = []; }
    if (c.kind === 'item') {
      while (stack.length && stack[stack.length - 1].depth > c.depth) stack.pop();
      const previous = stack.at(-1);
      const style = numbering(c.marker, line.text.slice(0, c.marker.textStart).trim(),
        previous?.depth === c.depth ? previous.style : undefined);
      if (previous?.depth === c.depth && previous.style !== style) stack.pop();
      const parent = stack.at(-1);
      const reuse = parent?.depth === c.depth;
      const list = reuse ? parent.list : (parent?.body ?? root).Append('L');
      if (!reuse) {
        list.SetListAttributes({ listNumbering: style });
        count++;
      }
      const item = list.Append('LI');
      record(mapped.label, item.Append('Lbl'));
      const body = item.Append('LBody');
      if (reuse) parent.body = body;
      else stack.push({ depth: c.depth, list, body, style });
    }
    record(mapped.body, stack[stack.length - 1].body);
  }
  if (prose.length) emitProse(prose);
  painter.commit();
  return count;
}
