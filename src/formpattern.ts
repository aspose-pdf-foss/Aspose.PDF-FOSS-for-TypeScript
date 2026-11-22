import type { Document } from './document.js';
import type { Page } from './page.js';
import type { ContentAddr } from './editcontent.js';
import { parseContentStream, type ContentOp, type ContentOpSource } from './content.js';
import { decodePageContentStreams, pageContentStreams } from './pagecontent.js';
import { resolvePattern } from './pagerender.js';
import { isArray, isDict, isName, isString, type PdfDict, type PdfObject, type PdfStream, type PdfString } from './types.js';

export interface PatternBinding {
  stream: PdfStream;
  resource: PdfObject;
  selection: ContentOp;
}

export interface PatternPaintState {
  fill?: PatternBinding;
  stroke?: PatternBinding;
  textMode: number;
  font?: FontBinding;
  fontSize: number;
}

export interface FontBinding {
  dict: PdfDict;
  resource: PdfObject;
  name?: string;
  type3: boolean;
}

/** Pattern state follows q/Q and Form entry. A tiling cell starts fresh. */
export function trackPatternPaint(doc: Document, resources: PdfDict | undefined, initial?: PatternPaintState) {
  let current: PatternPaintState = initial ? { ...initial } : { textMode: 0, fontSize: 0 };
  const saved: PatternPaintState[] = [];
  const patterns = doc.resolve(resources?.get('Pattern'));
  const fonts = doc.resolve(resources?.get('Font'));
  const states = doc.resolve(resources?.get('ExtGState'));
  const setFont = (value: PdfObject | undefined, name?: string): boolean => {
    const font = doc.resolve(value);
    if (value === undefined || !isDict(font)) return false;
    const subtype = doc.resolve(font.get('Subtype'));
    current.font = { dict: font, resource: value, name, type3: isName(subtype) && subtype.name === 'Type3' };
    return true;
  };
  const setFontSize = (value: PdfObject | undefined) => { current.fontSize = typeof value === 'number' ? value : 0; };
  return {
    get state(): PatternPaintState { return current; },
    update(op: ContentOp): void {
      switch (op.operator) {
        case 'q': saved.push({ ...current }); break;
        case 'Q': current = saved.pop() ?? current; break;
        case 'g': case 'rg': case 'k': case 'cs': case 'sc': current.fill = undefined; break;
        case 'G': case 'RG': case 'K': case 'CS': case 'SC': current.stroke = undefined; break;
        case 'Tr': current.textMode = typeof op.operands[0] === 'number' ? op.operands[0] | 0 : 0; break;
        case 'Tf': {
          setFontSize(op.operands[1]);
          const key = op.operands[0];
          if (isName(key) && isDict(fonts)) setFont(fonts.get(key.name), key.name);
          break;
        }
        case 'gs': {
          const key = op.operands[0];
          const state = isName(key) && isDict(states) ? doc.resolve(states.get(key.name)) : undefined;
          const font = isDict(state) ? doc.resolve(state.get('Font')) : undefined;
          if (isArray(font) && setFont(font[0])) setFontSize(font[1]);
          break;
        }
        case 'scn': case 'SCN': {
          const target = op.operands.at(-1);
          const resource = isName(target) && isDict(patterns) ? patterns.get(target.name) : undefined;
          const pattern = isName(target) && resource !== undefined ? resolvePattern(doc, resources, target.name) : undefined;
          const binding = pattern?.kind === 'tiling' && resource !== undefined
            ? { stream: pattern.stream, resource, selection: op } : undefined;
          current[op.operator === 'scn' ? 'fill' : 'stroke'] = binding;
          break;
        }
      }
    },
  };
}

/** Read inherited paint using the renderer's joined page-content view. */
export function pagePatternPaint(doc: Document, page: Page, addr: ContentAddr, source: ContentOpSource): PatternPaintState {
  const paint = trackPatternPaint(doc, page.Resources);
  const streams = pageContentStreams(doc, page);
  let ops = source.ops.slice(0, addr.opIndex);
  if (streams.length > 1) {
    const preceding = decodePageContentStreams(streams.slice(0, addr.streamIndex));
    const offset = preceding.reduce((sum, bytes) => sum + bytes.length + 1, 0);
    const end = source.endOffset(addr.opIndex);
    if (end !== undefined) ops = parseContentStream(page.Contents.subarray(0, offset + end), doc.loadLimits);
  }
  for (const op of ops) paint.update(op);
  return paint.state;
}

const fill = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const stroke = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const showText = new Set(['Tj', 'TJ', "'", '"']);
export const pathConstruction = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*']);
export function shownStrings(op: ContentOp): PdfString[] {
  if (!showText.has(op.operator)) return [];
  const text = op.operands[op.operator === '"' ? 2 : 0];
  if (op.operator === 'TJ') return isArray(text) ? text.filter(isString) : [];
  return isString(text) ? [text] : [];
}

/** Find contiguous path and text painting sites which can consume a pattern. */
export function trackPatternSites() {
  let first: number | undefined;
  return (op: ContentOp, index: number, state: PatternPaintState) => {
    const { operator, operands } = op;
    if (pathConstruction.has(operator)) {
      // W and a stray l or h can leave the renderer with an empty path.
      if (operator === 'm' || operator === 're') first ??= index;
      if (operator === 'c' || operator === 'v' || operator === 'y') {
        const count = operands.filter((o) => typeof o === 'number').length;
        if (count === (operator === 'c' ? 6 : 4)) first ??= index;
      }
      return undefined;
    }
    if (operator === 'n') { first = undefined; return undefined; }
    const fills = fill.has(operator), strokes = stroke.has(operator);
    if (fills || strokes) {
      const start = first;
      first = undefined;
      if (start === undefined) return undefined;
      const bindings = [fills ? state.fill : undefined, strokes ? state.stroke : undefined];
      return { first: start, end: index + 1, bindings: bindings.filter((p) => p !== undefined) };
    }
    if (state.fill && state.font && !state.font.type3 && (state.textMode & 3) !== 3
      && shownStrings(op).some(({ bytes }) => bytes.length > 0)) {
      return { first: index, end: index + 1, bindings: [state.fill] };
    }
    return undefined;
  };
}
