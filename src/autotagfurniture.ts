import type { Document } from './document.js';
import type { Page } from './page.js';
import { name, type PdfDict } from './types.js';
import { EditableContent, type ContentAddr } from './editcontent.js';
import type { ContentWrap } from './content.js';
import type { Rect } from './text.js';
import { repeatedTextGroups, textLines } from './watermarkdetect.js';

type Subtype = 'Header' | 'Footer' | 'Watermark';

interface Candidate {
  page: number;
  bbox: Rect;
  text: string;
  key: string;
  subtype: Subtype;
  folio: boolean;
  ops: ContentAddr[];
}

/** The outer tenth of the displayed crop box. Require the entire line to fit
 *  in the band. A shifted crop origin and page rotation both affect the edge. */
function marginal(page: Page, box: Rect): Subtype | undefined {
  const crop = page.CropBox;
  if (box[0] < crop[0] || box[1] < crop[1] || box[2] > crop[2] || box[3] > crop[3]) return;
  const rotate = page.Rotate;
  const axis = rotate === 90 || rotate === 270 ? 0 : 1;
  const band = (crop[axis + 2] - crop[axis]) / 10;
  const lowIsHeader = rotate === 90 || rotate === 180;
  if (box[axis + 2] <= crop[axis] + band) return lowIsHeader ? 'Header' : 'Footer';
  if (box[axis] >= crop[axis + 2] - band) return lowIsHeader ? 'Footer' : 'Header';
}

/** Normalize only an entire folio whose changing field agrees with the
 *  physical page number. Keep all other digits, including the stated total. */
function folioKey(text: string, page: number): string | undefined {
  const m = /^((?:page\s+|p\.?\s*)?)(\d+)(\s*(?:of|\/)\s*\d+)?$/i.exec(text);
  if (m && Number(m[2]) === page) return m[1] + '#' + (m[3] ?? '');
}

function samePlace(a: Candidate, b: Candidate): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 2;
  const x = a.bbox, y = b.bbox;
  if (!near(x[1], y[1]) || !near(x[3], y[3])) return false;
  // A left-, right- or centre-aligned folio can gain a digit at page 10.
  if (a.folio) return near(x[0], y[0]) || near(x[2], y[2]) || near((x[0] + x[2]) / 2, (y[0] + y[2]) / 2);
  return near(x[0], y[0]) && near(x[2], y[2]);
}

/** Identify recurring text before AutoTag changes any page. Apply to a page
 *  before adding its first MCID, while all original show addresses are valid. */
export function prepareFurniture(doc: Document, furniture: boolean, watermark?: (text: string) => boolean):
  (page: Page, tableQuads?: readonly Rect[]) => number {
  const candidates: Candidate[] = [];
  if ((!furniture && !watermark) || doc.Pages.length < 2) return () => 0;
  for (const page of doc.Pages) {
    for (const line of textLines(doc, page, page.Number, true)) {
      if (!line.ops) continue;
      const band = furniture ? marginal(page, line.bbox) : undefined;
      if (!band && !watermark) continue;
      const subtype = band ?? 'Watermark';
      const folio = band && folioKey(line.text, page.Number);
      const key = JSON.stringify([subtype, folio !== undefined, folio ?? line.text]);
      candidates.push({ ...line, subtype, folio: folio !== undefined, key, ops: line.ops });
    }
  }
  const byPage = new Map<number, Candidate[]>();
  const minPages = Math.max(2, Math.ceil(doc.Pages.length / 2));
  for (const group of repeatedTextGroups(candidates, minPages, 2, samePlace)) {
    if (group[0].subtype === 'Watermark' && !watermark?.(group[0].text)) continue;
    for (const candidate of group) {
      let pageLines = byPage.get(candidate.page);
      if (!pageLines) byPage.set(candidate.page, pageLines = []);
      pageLines.push(candidate);
    }
  }

  return (page, tableQuads = []) => {
    const lines = byPage.get(page.Number)?.filter(({ subtype, bbox }) =>
      subtype === 'Watermark' || !tableQuads.some(q =>
        q[0] <= bbox[2] && bbox[0] <= q[2] && q[1] <= bbox[3] && bbox[1] <= q[3]));
    if (!lines?.length) return 0;
    const streams = new Map<number, ContentWrap[]>();
    for (const line of lines) {
      const props: PdfDict = new Map([['Type', name('Pagination')], ['Subtype', name(line.subtype)]]);
      if (line.subtype !== 'Watermark') props.set('Attached', [name(line.subtype === 'Header' ? 'Top' : 'Bottom')]);
      for (const { streamIndex, opIndex } of line.ops) {
        let wraps = streams.get(streamIndex);
        if (!wraps) streams.set(streamIndex, wraps = []);
        wraps.push({ first: opIndex, end: opIndex + 1,
          before: [{ operator: 'BDC', operands: [name('Artifact'), props] }], after: [{ operator: 'EMC', operands: [] }] });
      }
    }
    // Preserve every source byte inside and between shows. A path, form or
    // body show between two words of a header must stay outside the scopes.
    const edit = new EditableContent(doc, page);
    const bytes = new Map<number, Uint8Array>();
    for (const [index, wraps] of streams) bytes.set(index, edit.topSource(index).replaceAll(wraps));
    edit.writeTopStreams(bytes);
    byPage.delete(page.Number);
    return lines.length;
  };
}
