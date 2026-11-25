import type { Page } from './page.js';
import type { Rect } from './tablemodel.js';
import { UnsupportedFeatureError } from './errors.js';
import { isArray, isDict, isName, isStream, isString } from './types.js';
import { EditableContent, type ContentAddr } from './editcontent.js';
import { visitContent, type GlyphEvent } from './text.js';
import { rewriteShowOp } from './redact.js';
import { ownedPath } from './tableink.js';
import type { ContentOp, ContentSplice } from './content.js';

const refuse = (why: string) => new UnsupportedFeatureError('Cannot edit tagged table: ' + why);
const hits = (a: Rect, b: Rect) => a[0] <= b[2] && a[1] <= b[3] && a[2] >= b[0] && a[3] >= b[1];
const key = (a: ContentAddr) => a.streamIndex + '/' + a.opIndex;

/** Change paint operators while retaining graphics and text state inherited
 * by surrounding content. Walk the marker stack across stream boundaries. */
export function removeTaggedTableInk(page: Page, ids: Set<number>, box: Rect, cells: Rect[], replacing: boolean): Rect {
  const doc = page.Document, ec = new EditableContent(doc, page);
  const paths = page.GetPaths({ includeHidden: true });
  // Old producers often tag only the text. Accept a recovered ruled grid
  // only if its cells enclose the tagged cells one-for-one in reading order.
  if (paths.some(p => (p.stroke || p.fill) && p.mcid === undefined)) {
    const candidates = page.GetTables({ structure: 'off', includeHidden: true }).filter(t => {
      if (t.angle !== 0) return false;
      const grid = t.rows.flatMap(r => r.cells);
      return grid.length === cells.length && grid.some(c => c.borders) && grid.every((c, i) =>
        cells[i][0] >= c.quad[0] - 0.001 && cells[i][1] >= c.quad[1] - 0.001 &&
        cells[i][2] <= c.quad[2] + 0.001 && cells[i][3] <= c.quad[3] + 0.001);
    });
    if (candidates.length === 1) {
      box = candidates[0].quad;
      cells = candidates[0].rows.flatMap(r => r.cells.map(c => c.quad));
    }
  }
  if (replacing && page.Annotations.some(a => a.Rect && hits(a.Rect, box))) throw refuse('overlapping annotation');
  const seen = new Set<number>(), marks = new Map<string, number>();
  const shows = new Map<string, GlyphEvent[]>(), decorations = new Set<string>();
  visitContent(doc, page, {
    marked(e) {
      if (e.addr.path.length) {
        if (ids.has(e.mcid)) throw refuse('marked content inside a Form');
        return;
      }
      marks.set(key(e.addr), e.mcid);
      if (!ids.has(e.mcid)) return;
      if (seen.has(e.mcid)) throw refuse('duplicate page MCID');
      seen.add(e.mcid);
    },
    glyph(g) {
      if (g.mcid === undefined || !ids.has(g.mcid)) {
        if (replacing && hits(g.quad, box)) throw refuse('overlapping text');
        return;
      }
      if (g.addr.path.length || g.vertical || Math.abs(g.angle) > 0.001 || (g.renderMode ?? 0) >= 4)
        throw refuse('Form, rotated, vertical or clipping text');
      const k = key(g.addr), list = shows.get(k);
      if (list) list.push(g); else shows.set(k, [g]);
    },
    image(e) {
      if (replacing && (e.mcid === undefined || !ids.has(e.mcid)) && hits(e.quad, box))
        throw refuse('overlapping image');
    },
  });
  if (seen.size !== ids.size) throw refuse('missing marked-content sequence');
  for (const p of paths) {
    if ((!p.fill && !p.stroke) || !hits(p.bbox, box)) continue;
    if (p.mcid !== undefined) {
      if (replacing && !ids.has(p.mcid)) throw refuse('overlapping marked artwork');
      continue;
    }
    if (p.addr.path.length || !ownedPath(p, cells))
      throw refuse('ambiguous table decoration');
    decorations.add(key(p.addr));
  }
  const properties = doc.resolve(page.Resources?.get('Properties'));
  const xobjects = doc.resolve(page.Resources?.get('XObject'));
  const streams = new Map<number, Uint8Array>();
  const stack: { owned: boolean; actualText: boolean }[] = [];
  let owned = false;
  let actualText = false;
  for (let i = 0; i < ec.streamCount; i++) {
    const src = ec.topSource(i), edits: ContentSplice[] = [];
    for (const [j, op] of src.ops.entries()) {
      const k = i + '/' + j;
      let replacement: ContentOp[] | undefined;
      switch (op.operator) {
        case 'BMC': case 'BDC': {
          stack.push({ owned, actualText });
          const id = marks.get(k);
          if (id !== undefined) {
            if (owned && !ids.has(id)) throw refuse('unrelated marked content nested in a cell');
            if (!owned && actualText && ids.has(id)) throw refuse('shared enclosing ActualText');
            owned = ids.has(id);
          }
          const prop = op.operands[1];
          const value = doc.resolve(isName(prop) && isDict(properties) ? properties.get(prop.name) : prop);
          actualText ||= isDict(value) && value.has('ActualText');
          if (owned) replacement = [];
          break;
        }
        case 'EMC':
          if (owned) replacement = [];
          ({ owned, actualText } = stack.pop() ?? { owned: false, actualText: false });
          break;
        case 'Tj': case 'TJ': case "'": case '"':
          if (owned) {
            replacement = rewriteShowOp(op, (shows.get(k) ?? []).map(g => ({ ...g, removed: true })));
            if (replacement.some(o => o.operands.some(v => isArray(v) && v.some(s => isString(s) && s.bytes.length))))
              throw refuse('cannot determine cell text advances');
          }
          break;
        case 'Do':
          if (owned) {
            const n = op.operands[0], xo = isName(n) && isDict(xobjects) && doc.resolve(xobjects.get(n.name));
            const t = xo && isStream(xo) && doc.resolve(xo.dict.get('Subtype'));
            if (!t || !isName(t) || t.name !== 'Image') throw refuse('unresolved or Form cell drawing');
            replacement = [];
          }
          break;
        case 'BI': case 'sh': if (owned) replacement = []; break;
        case 'S': case 's': case 'B': case 'b': case 'B*': case 'b*': case 'f': case 'F': case 'f*':
          if (owned || decorations.has(k)) replacement = [{ operator: 'n', operands: [] }];
          break;
      }
      if (replacement) edits.push({ first: j, end: j + 1, ops: replacement });
    }
    if (edits.length) streams.set(i, src.replaceAll(edits));
  }
  if (stack.length || owned) throw refuse('unbalanced marked content');
  ec.writeTopStreams(streams);
  return box;
}
