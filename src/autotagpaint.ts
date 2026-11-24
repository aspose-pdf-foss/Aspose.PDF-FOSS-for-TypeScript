import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { TextRegion } from './autotagannot.js';
import { EditableContent, type ContentAddr } from './editcontent.js';
import { layoutLines, runFromGlyph, visitContent, type GlyphEvent, type Rect } from './text.js';
import { name, type PdfObject } from './types.js';
import type { ContentOp, ContentWrap } from './content.js';

export function centerInside(box: Rect, region: Rect): boolean {
  const x = (box[0] + box[2]) / 2, y = (box[1] + box[3]) / 2;
  return x >= Math.min(region[0], region[2]) && x <= Math.max(region[0], region[2])
    && y >= Math.min(region[1], region[3]) && y <= Math.max(region[1], region[3]);
}

// Text-state changes inside one text object may separate two runs of the same
// paragraph. Keep them in one MCID so consumers can assemble the word or line.
export const TEXT_STATE = new Set(['Tf', 'Tc', 'Tw', 'Tz', 'TL', 'Tr', 'Ts', 'Td', 'TD', 'Tm', 'T*']);

type Owner = StructElement | 'artifact';
interface Draw { owner: Owner; order: number }
interface Span { draw: Draw; lastOrder: number; wrap: ContentWrap }

/** Include BT/ET only if the span covers a whole text object. Two complete,
 * adjacent text objects can then share a word without crossing PDF scopes. */
function wholeTextObject(ops: readonly ContentOp[], wrap: ContentWrap): void {
  let start = wrap.first - 1, end = wrap.end;
  while (start >= 0 && TEXT_STATE.has(ops[start].operator)) start--;
  while (end < ops.length && TEXT_STATE.has(ops[end].operator)) end++;
  if (ops[start]?.operator === 'BT' && ops[end]?.operator === 'ET') {
    wrap.first = start;
    wrap.end = end + 1;
  }
}

function streamSpans(ops: readonly ContentOp[], draws: Map<number, Draw>): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < ops.length; i++) {
    const draw = draws.get(i);
    if (!draw) continue;
    let end = i + 1, lastOrder = draw.order;
    if (draw.owner !== 'artifact') {
      for (let next = end; next < ops.length; next++) {
        const neighbor = draws.get(next);
        if (neighbor?.owner === draw.owner && neighbor.order === lastOrder + 1) {
          end = next + 1;
          lastOrder++;
        } else if (!TEXT_STATE.has(ops[next].operator)) break;
      }
    }
    const wrap: ContentWrap = { first: i, end, before: [], after: [{ operator: 'EMC', operands: [] }] };
    if (draw.owner !== 'artifact') wholeTextObject(ops, wrap);
    const prev = spans.at(-1);
    if (prev && prev.draw.owner === draw.owner && prev.lastOrder + 1 === draw.order && prev.wrap.end === wrap.first) {
      prev.wrap.end = wrap.end;
      prev.lastOrder = lastOrder;
    } else spans.push({ draw, lastOrder, wrap });
    i = wrap.end - 1;
  }
  return spans;
}

/** Resolve addresses after list/furniture edits. Each original show or image draw
 * receives at most one owner. An interleaved artifact or unrelated draw is never
 * pulled into a paragraph merely because its operator is between two text runs. */
export function markPagePaint(doc: Document, page: Page, text: TextRegion[], images: Owner[]): void {
  const streams = new Map<number, Map<number, Draw>>();
  function assign(addr: ContentAddr, owner: Owner, order: number) {
    let ops = streams.get(addr.streamIndex);
    if (!ops) streams.set(addr.streamIndex, ops = new Map());
    if (!ops.has(addr.opIndex)) ops.set(addr.opIndex, { owner, order });
  }
  const glyphs: GlyphEvent[] = [];
  let imageIndex = 0;
  visitContent(doc, page, {
    glyph: g => {
      if (!g.addr.path.length && !g.artifact && g.mcid === undefined) glyphs.push(g);
    },
    image: img => {
      if (img.addr.path.length || img.artifact || img.mcid !== undefined) return;
      assign(img.addr, images[imageIndex++], 0);
    },
  }, { skipHidden: true });
  const { refs } = layoutLines(glyphs.map(g => runFromGlyph(g, g)));
  let order = 0;
  for (const g of refs) {
    if (!g || streams.get(g.addr.streamIndex)?.has(g.addr.opIndex)) continue;
    const region = text.find(r => centerInside(g.quad, r.quad));
    if (region) assign(g.addr, region.owner, order++);
  }
  if (!streams.size) return;

  // Collect the spans in stream order, allocate their MCIDs in reading order,
  // then wrap the original bytes at their original offsets.
  const edit = new EditableContent(doc, page);
  const edits = Array.from(streams, ([stream, draws]) => {
    const source = edit.topSource(stream);
    return { stream, source, spans: streamSpans(source.ops, draws) };
  });
  const spans = edits.flatMap(edit => edit.spans);
  for (const { draw, wrap } of spans.sort((a, b) => a.draw.order - b.draw.order)) {
    const owner = draw.owner;
    wrap.before = owner === 'artifact' ? [{ operator: 'BMC', operands: [name('Artifact')] }]
      : [{ operator: 'BDC', operands: [name(owner.Type), new Map<string, PdfObject>([['MCID', owner.NextMcid(page)]])] }];
  }
  edit.writeTopStreams(new Map(edits.map(({ stream, source, spans }) =>
    [stream, source.replaceAll(spans.map(s => s.wrap))])));
}
