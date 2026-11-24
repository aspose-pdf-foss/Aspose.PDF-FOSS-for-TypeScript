import type { Document } from './document.js';
import type { Page } from './page.js';
import type { Matrix } from './text.js';
import { isArray, isDict, isName, type PdfArray, type PdfDict, type PdfObject } from './types.js';
import { nameTreeEntries } from './nametree.js';
import { transformContent } from './pagecontent.js';
import { serializeValue } from './serialize.js';
import { PdfParseError } from './errors.js';

type Edit = () => void;

function positiveBox(box: readonly number[]): boolean {
  return Array.isArray(box) && box.length === 4 && Array.from(box).every(Number.isFinite)
    && box[2] > box[0] && box[3] > box[1];
}

function cropMatrix(page: Page, box: readonly number[]): Matrix {
  const crop = page.CropBox;
  if (!positiveBox(crop)) throw new RangeError(`ResizePages: invalid CropBox on page ${page.Number}`);
  const sx = (box[2] - box[0]) / (crop[2] - crop[0]);
  const sy = (box[3] - box[1]) / (crop[3] - crop[1]);
  const cm: Matrix = [sx, 0, 0, sy, box[0] - sx * crop[0], box[1] - sy * crop[1]];
  if (!cm.every(Number.isFinite) || sx <= 0 || sy <= 0)
    throw new RangeError(`ResizePages: unrepresentable transform on page ${page.Number}`);
  return cm;
}

function coordinate(cm: Matrix, value: PdfObject, x: boolean, key: string, distance = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new PdfParseError(`ResizePages: invalid /${key} coordinate`);
  const result = value * (x ? cm[0] : cm[3]) + (distance ? 0 : cm[x ? 4 : 5]);
  if (!Number.isFinite(result)) throw new RangeError(`ResizePages: /${key} coordinate overflow`);
  return result;
}

function points(doc: Document, raw: PdfObject | undefined, key: string, cm: Matrix): number[] {
  const a = doc.resolve(raw);
  if (!isArray(a) || a.length === 0 || a.length % 2 ||
      ((key === 'Rect' || key === 'L' || key === 'RD') && a.length !== 4) ||
      (key === 'QuadPoints' && a.length % 8 !== 0) ||
      (key === 'CL' && a.length !== 4 && a.length !== 6))
    throw new PdfParseError(`ResizePages: malformed /${key} array`);
  return Array.from(a, (v, i) => coordinate(cm, doc.resolve(v), i % 2 === 0, key, key === 'RD'));
}

function planAnnotation(doc: Document, annot: PdfDict, cm: Matrix, edits: Edit[]): void {
  for (const key of ['Rect', 'QuadPoints', 'Vertices', 'L', 'CL', 'RD']) {
    if (!annot.has(key)) continue;
    const mapped = points(doc, annot.get(key), key, cm);
    edits.push(() => annot.set(key, mapped));
  }
  if (annot.has('InkList')) {
    const list = doc.resolve(annot.get('InkList'));
    if (!isArray(list)) throw new PdfParseError('ResizePages: malformed /InkList');
    const mapped = list.map(stroke => points(doc, stroke, 'InkList', cm));
    edits.push(() => annot.set('InkList', mapped));
  }
  const subtype = doc.resolve(annot.get('Subtype'));
  if (isName(subtype) && subtype.name === 'Line' && ['LL', 'LLE', 'LLO'].some(key => annot.has(key))) {
    // A leader length is a signed perpendicular distance between parallel
    // lines. Under anisotropic scaling the unit normal transforms by A^-T.
    const line = points(doc, annot.get('L'), 'L', [1, 0, 0, 1, 0, 0]);
    const dx = line[2] - line[0], dy = line[3] - line[1], length = Math.hypot(dx, dy);
    const scale = cm[0] === cm[3] ? cm[0] : 1 / Math.hypot(dy / length / cm[0], dx / length / cm[3]);
    for (const key of ['LL', 'LLE', 'LLO']) {
      if (!annot.has(key)) continue;
      const v = doc.resolve(annot.get(key));
      if (typeof v !== 'number' || !Number.isFinite(v * scale))
        throw new PdfParseError(`ResizePages: invalid /${key} line leader`);
      edits.push(() => annot.set(key, v * scale));
    }
  }
}

/** Visit explicit local destinations only. A remote action also has a /D, and
 *  another name-tree branch may contain arbitrary arrays. Neither is a target. */
function visitDestinations(doc: Document, pages: readonly Page[], visit: (v: PdfObject | undefined) => void): void {
  const catalog = doc.catalog(), actions: PdfObject[] = [];
  function owner(d: PdfDict): void {
    const action = d.get('A');
    if (action) actions.push(action);
    const aa = doc.resolve(d.get('AA'));
    if (isDict(aa)) for (const entry of aa.values()) actions.push(entry);
  }
  owner(catalog);
  const open = doc.resolve(catalog.get('OpenAction'));
  if (isDict(open)) actions.push(open);
  else visit(open);

  const names = doc.resolve(catalog.get('Names'));
  if (isDict(names)) for (const [, value] of nameTreeEntries(doc, names.get('Dests'))) visit(value);
  const legacy = doc.resolve(catalog.get('Dests'));
  if (isDict(legacy)) for (const value of legacy.values()) visit(value);

  for (const p of pages) {
    owner(p.Dict);
    const annots = doc.resolve(p.Dict.get('Annots'));
    if (isArray(annots)) for (const entry of annots) {
      const a = doc.resolve(entry);
      if (!isDict(a)) continue;
      owner(a);
      visit(a.get('Dest'));
    }
  }

  const outlines = doc.resolve(catalog.get('Outlines'));
  const nodes = [isDict(outlines) ? outlines.get('First') : undefined];
  const seenNodes = new Set<PdfDict>();
  while (nodes.length) {
    const node = doc.resolve(nodes.pop());
    if (!isDict(node) || seenNodes.has(node)) continue;
    seenNodes.add(node);
    owner(node);
    visit(node.get('Dest'));
    nodes.push(node.get('First'), node.get('Next'));
  }

  const form = doc.resolve(catalog.get('AcroForm'));
  const fields = isDict(form) ? doc.resolve(form.get('Fields')) : null;
  const pending = isArray(fields) ? fields.slice() : [];
  const seenFields = new Set<PdfDict>();
  while (pending.length) {
    const field = doc.resolve(pending.pop());
    if (!isDict(field) || seenFields.has(field)) continue;
    seenFields.add(field);
    owner(field);
    const kids = doc.resolve(field.get('Kids'));
    if (isArray(kids)) for (const kid of kids) pending.push(kid);
  }

  const seenActions = new Set<PdfDict>();
  while (actions.length) {
    const action = doc.resolve(actions.pop());
    if (!isDict(action) || seenActions.has(action)) continue;
    seenActions.add(action);
    const kind = doc.resolve(action.get('S'));
    if (isName(kind) && kind.name === 'GoTo') visit(action.get('D'));
    const next = doc.resolve(action.get('Next'));
    if (isArray(next)) for (const entry of next) actions.push(entry);
    else if (isDict(next)) actions.push(next);
  }
}

function planDestinations(doc: Document, pages: readonly Page[], matrices: Map<PdfDict, Matrix>, edits: Edit[]): void {
  const seen = new Set<PdfArray>();
  visitDestinations(doc, pages, raw => {
    const value = doc.resolve(raw);
    const dest = isDict(value) ? doc.resolve(value.get('D')) : value;
    if (!isArray(dest) || seen.has(dest)) return;
    seen.add(dest);
    const page = doc.resolve(dest[0]), kind = doc.resolve(dest[1]);
    const cm = isDict(page) ? matrices.get(page) : undefined;
    if (!cm || !isName(kind)) return;
    const operand = (i: number, x: boolean, nullable = true): void => {
      const n = doc.resolve(dest[i]);
      // Match outline.decodeView: an omitted nullable operand retains the
      // viewer's current coordinate. Keep its original representation.
      if (nullable && n === null) return;
      const mapped = coordinate(cm, n, x, kind.name);
      edits.push(() => { dest[i] = mapped; });
    };
    switch (kind.name) {
      case 'XYZ': operand(2, true); operand(3, false); break;
      case 'FitH': case 'FitBH': operand(2, false); break;
      case 'FitV': case 'FitBV': operand(2, true); break;
      case 'FitR': for (let i = 2; i < 6; i++) operand(i, i % 2 === 0, false); break;
    }
  });
}

export function resizePages(doc: Document, numbers: readonly number[], box: readonly number[]): void {
  if (!Array.isArray(numbers)) throw new TypeError('ResizePages: expected an array of page numbers');
  if (!positiveBox(box)) throw new RangeError('ResizePages: expected a finite box with positive width and height');
  if (!numbers.length) return;
  const pages = doc.Pages, matrices = new Map<PdfDict, Matrix>(), edits: Edit[] = [];
  for (const n of numbers) {
    if (!Number.isInteger(n) || n < 1 || n > pages.length) throw new RangeError(`ResizePages: invalid page ${n}`);
    const page = pages[n - 1];
    if (matrices.has(page.Dict)) continue;
    const cm = cropMatrix(page, box);
    matrices.set(page.Dict, cm);
    edits.push(() => {
      page.MediaBox = [...box];
      page.CropBox = [...box];
      transformContent(doc, page, cm, serializeValue);
    });
  }
  const owners = new Map<PdfDict, Matrix | undefined>();
  for (const page of pages) {
    const cm = matrices.get(page.Dict), annots = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(annots)) continue;
    const pending = annots.slice();
    while (pending.length) {
      const annot = doc.resolve(pending.pop());
      if (!isDict(annot)) continue;
      if (owners.has(annot)) {
        const previous = owners.get(annot);
        if (previous !== cm && !(previous && cm && previous.every((v, i) => v === cm[i])))
          throw new PdfParseError('ResizePages: annotation belongs to pages with different transforms');
        continue;
      }
      owners.set(annot, cm);
      if (cm) planAnnotation(doc, annot, cm, edits);
      const popup = annot.get('Popup');
      if (popup) pending.push(popup);
    }
  }
  planDestinations(doc, pages, matrices, edits);
  for (const apply of edits) apply();
}
