import { Lexer } from './lexer.js';
import type { Document } from './document.js';
import { PdfDict, isDict, isName, isString } from './types.js';
import { normalizeFont, type StdFont } from './metrics.js';

/** A parsed /DA default-appearance: font resource name, size (0 = auto), and an
 *  RGB fill color in 0..1. */
export interface DA {
  fontName: string;
  size: number;
  color: [number, number, number];
}

/** Parse a /DA string, keeping the last of each operator. Recognises the text
 *  font operator (`Tf`) and the fill-color operators `g`/`rg`/`k`; everything
 *  else is ignored. Defaults: font `Helv`, size 0, black. */
export function parseDA(s: string): DA {
  const da: DA = { fontName: 'Helv', size: 0, color: [0, 0, 0] };
  const operands: Array<number | string> = []; // numbers, or font names (no '/')
  const lex = new Lexer(new TextEncoder().encode(s));
  for (;;) {
    const tok = lex.next();
    if (tok.t === 'eof') break;
    if (tok.t === 'num') { operands.push(tok.v); continue; }
    if (tok.t === 'name') { operands.push(tok.v); continue; }
    if (tok.t === 'kw') {
      const op = tok.v;
      if (op === 'Tf' && operands.length >= 2) {
        const size = operands[operands.length - 1];
        const fn = operands[operands.length - 2];
        if (typeof size === 'number') da.size = size;
        if (typeof fn === 'string') da.fontName = fn;
      } else if (op === 'g' && operands.length >= 1) {
        const v = operands[operands.length - 1];
        if (typeof v === 'number') da.color = [v, v, v];
      } else if (op === 'rg' && operands.length >= 3) {
        const [r, g, b] = operands.slice(-3);
        if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number')
          da.color = [r, g, b];
      } else if (op === 'k' && operands.length >= 4) {
        const [c, m, y, kk] = operands.slice(-4);
        if ([c, m, y, kk].every((n) => typeof n === 'number')) {
          const cc = c as number, mm = m as number, yy = y as number, kv = kk as number;
          da.color = [(1 - cc) * (1 - kv), (1 - mm) * (1 - kv), (1 - yy) * (1 - kv)];
        }
      }
      operands.length = 0;
    }
    // delim / str tokens are not meaningful inside a /DA — ignore.
  }
  return da;
}

/** A /DA resolved against the document: the parsed values plus the concrete
 *  Standard-14 base font the resource name maps to. */
export interface ResolvedDA {
  fontName: string;
  std: StdFont;
  size: number;
  color: [number, number, number];
}

function daString(doc: Document, fieldDict: PdfDict, acroForm: PdfDict): string {
  const fv = doc.resolve(fieldDict.get('DA'));
  if (isString(fv)) return new TextDecoder('latin1').decode(fv.bytes);
  const av = doc.resolve(acroForm.get('DA'));
  if (isString(av)) return new TextDecoder('latin1').decode(av.bytes);
  return '/Helv 0 Tf 0 g';
}

function drBaseFont(doc: Document, acroForm: PdfDict, fontName: string): string | undefined {
  const dr = doc.resolve(acroForm.get('DR'));
  if (!isDict(dr)) return undefined;
  const fonts = doc.resolve((dr as PdfDict).get('Font'));
  if (!isDict(fonts)) return undefined;
  const fd = doc.resolve((fonts as PdfDict).get(fontName));
  if (!isDict(fd)) return undefined;
  const bf = doc.resolve((fd as PdfDict).get('BaseFont'));
  return isName(bf) ? bf.name : undefined;
}

/** Resolve the effective /DA for a field: field /DA, else AcroForm /DA, else a
 *  Helvetica default. The font resource name is mapped to a Standard-14 font via
 *  the AcroForm /DR /Font /BaseFont when available, otherwise by name. */
export function resolveDA(doc: Document, fieldDict: PdfDict, acroForm: PdfDict): ResolvedDA {
  const da = parseDA(daString(doc, fieldDict, acroForm));
  const baseFont = drBaseFont(doc, acroForm, da.fontName);
  const std = normalizeFont(baseFont ?? da.fontName);
  return { fontName: da.fontName, std, size: da.size, color: da.color };
}
