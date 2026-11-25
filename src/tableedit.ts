import type { Document } from './document.js';
import type { Page } from './page.js';
import type { Table, Rect, TableExtractOptions } from './tablemodel.js';
import type { TableBuilder } from './tableauthor.js';
import { drawFittedTable } from './tablerender.js';
import { EditableContent, type ContentAddr } from './editcontent.js';
import type { ContentOpSource, ContentSplice } from './content.js';
import { rewritePath } from './pathedit.js';
import { rewriteShowOp } from './redact.js';
import { type PagePath, type StreamSource, deviceBbox, sameStream, snapshotStream } from './paths.js';
import { pageContentStreams } from './pagecontent.js';
import { scopeStream } from './textedit.js';
import { deviceSegments } from './tableink.js';
import { cellText } from './tablegrid.js';
import { buildFragments, mul, visitContent, type GlyphEvent, type TextFragment } from './text.js';
import { boxCorners, glyphCorners, glyphInFrame, rot, touchesBox } from './tableorient.js';
import { UnsupportedFeatureError } from './errors.js';
import type { PdfDict } from './types.js';
import { extractTaggedTables } from './tablestruct.js';

const refuse = (reason: string) => new UnsupportedFeatureError('Cannot edit detected table: ' + reason);
const stale = () => new RangeError('Detected table is stale. Call GetTables() again.');
const near = (a: number, b: number) => Math.abs(a - b) <= 0.001;
const sameBox = (a: Rect, b: Rect) => a.every((v, i) => near(v, b[i]));
const inside = (a: Rect, b: Rect) => a[0] >= b[0] - 0.001 && a[1] >= b[1] - 0.001 &&
  a[2] <= b[2] + 0.001 && a[3] <= b[3] + 0.001;
const intersects = (a: Rect, b: Rect) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const glyphKey = (g: GlyphEvent) => JSON.stringify([g.addr, g.drawnBy, g.elementIndex, g.byteStart, g.text, g.quad]);
const pathKey = (p: PagePath) => JSON.stringify([p.Addr, p.bbox, p.ctm, p.subpaths, p.fill, p.stroke, p.lineWidth]);

interface PageSource {
  doc: WeakRef<Document>;
  dict: WeakRef<PdfDict>;
  streams: StreamSource[];
  forms: Map<string, { path: readonly string[]; source: StreamSource }>;
  glyphs: Set<string>;
  paths: Set<string>;
  regional: boolean;
  includeHidden: boolean;
}
interface Target {
  source: PageSource;
  angle: number;
  box: Rect;
  cells: { box: Rect; text: string }[];
}
const targets = new WeakMap<Table, Target>();

/** Bind only results produced by geometry detection. Keep the selection
 * independent of the publicly mutable cells, bounds and page number. */
export function bindDetectedTables(page: Page, tables: Table[], paths: PagePath[], glyphs: GlyphEvent[], options: TableExtractOptions): void {
  if (!tables.length) return;
  const doc = page.Document;
  const forms: PageSource['forms'] = new Map();
  function remember(path: readonly string[]) {
    if (!path.length) return;
    const key = JSON.stringify(path);
    if (forms.has(key)) return;
    const form = scopeStream(doc, page, path);
    if (form) forms.set(key, { path, source: snapshotStream(form, form.raw) });
  }
  for (const p of paths) remember(p.addr.path);
  for (const g of glyphs) remember(g.addr.path);
  const source: PageSource = { doc: new WeakRef(doc), dict: new WeakRef(page.Dict),
    streams: pageContentStreams(doc, page).map(s => snapshotStream(s, s.raw)), forms,
    glyphs: new Set(glyphs.map(glyphKey)), paths: new Set(paths.map(pathKey)),
    regional: !!options.region, includeHidden: !!options.includeHidden };
  for (const t of tables) {
    const cells = t.rows.flatMap(row => row.cells);
    if (cells.some(c => c.tables?.length)) continue;
    targets.set(t, { source, angle: t.angle, box: [...t.quad], cells: cells.map(c => ({ box: [...c.quad], text: c.text })) });
  }
}

/** Every point of a ruled segment must belong to recovered cell sides. A line
 * that crosses a grid or merely ends on an edge is neighboring artwork. */
function isEdge(segment: number[], boxes: Rect[]): boolean {
  const [x, y, u, v] = segment;
  const horizontal = near(y, v);
  if (!horizontal && !near(x, u)) return false;
  const a = horizontal ? 0 : 1, b = horizontal ? 1 : 0;
  const fixed = horizontal ? y : x;
  const lo = Math.min(segment[a], segment[a + 2]), hi = Math.max(segment[a], segment[a + 2]);
  if (near(lo, hi)) return false;
  const sides = boxes.filter(r => (near(fixed, r[b]) || near(fixed, r[b + 2])) &&
    r[a] >= lo - 0.001 && r[a + 2] <= hi + 0.001).sort((l, r) => l[a] - r[a]);
  let end = lo;
  for (const side of sides) {
    if (side[a] > end + 0.001) break;
    end = Math.max(end, side[a + 2]);
  }
  return near(end, hi);
}

function ownedPath(p: PagePath, boxes: Rect[]): boolean {
  if (p.subpaths.some(s => s.segments.some(c => c.op === 'cubic'))) return false;
  const segments = deviceSegments(p).filter(([x, y, u, v]) => !near(x, u) || !near(y, v));
  if (!segments.length) return false;
  if (p.fill) {
    const r = p.bbox;
    const edges = new Set(segments.map(([x, y, u, v]) =>
      near(x, u) ? 'x' + x : near(y, v) ? 'y' + y : 'diagonal'));
    if (p.subpaths.length !== 1 || segments.length !== 4 || edges.size !== 4 ||
        !segments.every(s => isEdge(s, [r]))) return false;
    if (boxes.some(box => sameBox(box, r))) return true;
    // Thin filled rectangles can be grid rules. Match their centerline.
    const [x, y, u, v] = r;
    return !p.stroke && ((v - y <= 3 && isEdge([x, (y + v) / 2, u, (y + v) / 2], boxes)) ||
      (u - x <= 3 && isEdge([(x + u) / 2, y, (x + u) / 2, v], boxes)));
  }
  return !!p.stroke && segments.every(s => isEdge(s, boxes));
}

interface StreamEdits {
  paths: PagePath[];
  shows: Map<number, (GlyphEvent & { removed: boolean })[]>;
}

function planRemoval(page: Page, target: Target) {
  const doc = page.Document, { angle, box, cells, source } = target;
  const frame = angle === 0 ? undefined : rot(-angle);
  const pageBoxTouches = (r: Rect) => frame ? touchesBox(boxCorners(r, frame), box) : intersects(r, box);
  if (extractTaggedTables(doc, page, { includeHidden: true }).some(t => pageBoxTouches(t.quad)))
    throw refuse('the selected region intersects a tagged table');
  if (source.regional && !page.GetTables({ structure: 'off', includeHidden: source.includeHidden }).some(t => near(t.angle, angle) && sameBox(t.quad, box)))
    throw refuse('the selected region contains only part of a table');
  const edits = new Map<number, StreamEdits>();
  let drawing: readonly ContentAddr[] | undefined;
  function group(addr: ContentAddr, calls: readonly ContentAddr[] = []) {
    if (drawing && JSON.stringify(drawing) !== JSON.stringify(calls))
      throw refuse('the selected content spans separate Form drawings');
    drawing = calls;
    let changes = edits.get(addr.streamIndex);
    if (!changes) { changes = { paths: [], shows: new Map() }; edits.set(addr.streamIndex, changes); }
    return changes;
  }
  const boxes = cells.map(c => c.box);
  for (const annot of page.Annotations) {
    if (annot.Rect && pageBoxTouches(annot.Rect)) throw refuse('overlapping annotation');
  }
  for (const p of page.GetPaths({ includeHidden: true })) {
    if (!p.fill && !p.stroke) continue;
    const ctm = frame && mul(p.ctm, frame);
    const local = ctm ? { ...p, ctm, bbox: deviceBbox(p.subpaths, ctm) } : p;
    const radius = p.stroke ? p.lineWidth / 2 : 0;
    const padded: Rect = [box[0] - radius, box[1] - radius, box[2] + radius, box[3] + radius];
    if (!intersects(local.bbox, padded)) continue;
    if (frame && !p.fill && !p.subpaths.some(s => s.segments.some(v => v.op === 'cubic')) &&
        deviceSegments(local).every(([x, y, u, v]) => !touchesBox([[x, y], [u, v], [u, v], [x, y]], padded))) continue;
    if (p.mcid !== undefined || !source.paths.has(pathKey(p)) || !ownedPath(local, boxes))
      throw refuse('overlapping or ambiguous vector drawing');
    if (p.Addr.start.streamIndex !== p.Addr.end.streamIndex) throw refuse('a path spans content streams');
    group(p.addr, p.Addr.invocations).paths.push(p);
  }
  const glyphs: GlyphEvent[] = [];
  visitContent(doc, page, { glyph: g => glyphs.push(g), image: image => {
    if (frame ? touchesBox(boxCorners([0, 0, 1, 1], mul(image.ctm, frame)), box) : intersects(image.quad, box))
      throw refuse('overlapping image');
  } });
  const spans: [number, number][] = [], members = cells.map((): TextFragment[] => []);
  const selected = new Set<GlyphEvent>();
  const touching: boolean[] = [];
  const localGlyphs = frame ? glyphs.map(g => {
    const corners = glyphCorners(g, frame);
    touching.push(touchesBox(corners, box));
    return glyphInFrame(g, frame, angle, corners);
  }) : glyphs;
  for (const [i, f] of buildFragments(localGlyphs, spans).entries()) {
    const [start, end] = spans[i];
    if (frame && !touching.slice(start, end).some(Boolean)) continue;
    if (!intersects(f.quad, box)) continue;
    const ci = cells.findIndex(c => inside(f.quad, c.box));
    if (ci < 0) throw refuse('text crosses a cell boundary');
    if (members[ci].some(other => Math.min(f.quad[2], other.quad[2]) - Math.max(f.quad[0], other.quad[0]) > 0.5 &&
        Math.min(f.quad[3], other.quad[3]) - Math.max(f.quad[1], other.quad[1]) > 0.5))
      throw refuse('overlapping text in a cell');
    members[ci].push(f);
    for (let j = start; j < end; j++) {
      if (frame && !inside(localGlyphs[j].quad, cells[ci].box)) throw refuse('text crosses a cell boundary');
      selected.add(glyphs[j]);
    }
  }
  if (cells.some((c, i) => c.text !== cellText(members[i]))) throw stale();
  for (const [index, g] of glyphs.entries()) {
    if (!(frame ? touching[index] : intersects(g.quad, box))) continue;
    if (!selected.has(g) || g.mcid !== undefined || g.vertical || Math.abs(localGlyphs[index].angle) > 0.001 ||
        (g.renderMode ?? 0) >= 3 || !source.glyphs.has(glyphKey(g))) throw refuse('ambiguous or marked cell text');
    const { shows } = group(g.addr, g.drawnBy);
    if (!shows.has(g.addr.opIndex)) shows.set(g.addr.opIndex, []);
  }
  for (const g of glyphs) {
    if (JSON.stringify(g.drawnBy ?? []) !== JSON.stringify(drawing)) continue;
    edits.get(g.addr.streamIndex)?.shows.get(g.addr.opIndex)?.push({ ...g, removed: selected.has(g) });
  }
  if (!edits.size) throw stale();
  return { edits, drawing: drawing! };
}

function splices(source: ContentOpSource, edits: StreamEdits): ContentSplice[] {
  const out = edits.paths.map(p => {
    const first = p.Addr.start.opIndex, end = p.Addr.end.opIndex + 1;
    return { first, end, ops: rewritePath(source.ops.slice(first, end), { kind: 'remove' }) };
  });
  for (const [first, glyphs] of edits.shows)
    out.push({ first, end: first + 1, ops: rewriteShowOp(source.ops[first], glyphs) });
  return out;
}

export function editDetectedTable(table: Table, builder?: TableBuilder): void {
  const target = targets.get(table);
  if (!target) throw refuse('requires an untagged single-page table without nesting');
  const { source } = target, doc = source.doc.deref(), dict = source.dict.deref();
  const number = doc && dict && doc.pageNumberOf(dict);
  if (!doc || !number) throw stale();
  const page = doc.Pages[number - 1], streams = pageContentStreams(doc, page);
  if (streams.length !== source.streams.length || streams.some((s, i) => !sameStream(source.streams[i], s, s.raw))) throw stale();
  for (const form of source.forms.values()) {
    const s = scopeStream(doc, page, form.path);
    if (!s || !sameStream(form.source, s, s.raw)) throw stale();
  }
  const { edits, drawing } = planRemoval(page, target);
  doc.editTablePage(page, draft => {
    const ec = new EditableContent(draft.Document, draft);
    if (drawing.length) {
      ec.editFormOccurrence(drawing, src => splices(src, edits.get(0)!));
    } else {
      const bytes = new Map<number, Uint8Array>();
      for (const [i, changes] of edits) {
        const src = ec.topSource(i);
        bytes.set(i, src.replaceAll(splices(src, changes)));
      }
      ec.writeTopStreams(bytes);
    }
    if (builder) drawFittedTable(draft, builder, target.box, doc, target.angle);
  });
}
