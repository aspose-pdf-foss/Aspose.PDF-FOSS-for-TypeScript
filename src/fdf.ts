import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { PdfParseError } from './errors.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isRef, isString, name } from './types.js';
import { enc, serializeObject, serializeValue } from './serialize.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import type { FormData, FormDataField, SkippedAnnot } from './formdata.js';
import { readFdfAnnots, writeFdfAnnots } from './fdfannot.js';

const str = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });
const latin1 = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

/** /V for one field: a name for the button types, a string for text and
 *  single-select choice, an array of strings for multi-select. */
function fieldValue(f: FormDataField): PdfObject {
  if (f.type === 'checkbox' || f.type === 'radio') return name(f.values[0] ?? 'Off');
  if (f.values.length > 1) return f.values.map(str);
  return str(f.values[0] ?? '');
}

/** A hex-digit string, as the raw bytes it encodes. */
function hexString(hex: string): PdfObject {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { kind: 'string', bytes };
}

/** Serialize form data as an FDF file. The field list is flat, with each
 *  entry's /T carrying the full dotted name — legal, and what most producers
 *  emit. No cross-reference table is written; FDF permits its absence. */
export function writeFdf(data: FormData): Uint8Array {
  const fields: PdfObject[] = data.fields.map((f) => {
    const d: PdfDict = new Map<string, PdfObject>();
    d.set('T', str(f.name));
    d.set('V', fieldValue(f));
    if (f.richText !== undefined) d.set('RV', str(f.richText));
    return d;
  });

  const fdf: PdfDict = new Map<string, PdfObject>();
  fdf.set('Fields', fields);
  if (data.file !== undefined) fdf.set('F', str(data.file));
  if (data.id !== undefined)
    fdf.set('ID', [hexString(data.id[0]), hexString(data.id[1])]);

  // Annotations become indirect objects numbered from 2; the catalog is 1.
  // /Annots has to be set before the catalog is serialized below.
  let annotObjects: Map<number, PdfObject> | undefined;
  if (data.annots !== undefined && data.annots.length > 0) {
    const { array, objects } = writeFdfAnnots(data.annots, 2);
    fdf.set('Annots', array);
    annotObjects = objects;
  }

  const root: PdfDict = new Map<string, PdfObject>([['FDF', fdf]]);

  // Assembled as bytes, not as a string: an appearance stream's payload is
  // arbitrary binary, and round-tripping it through a JS string would re-encode
  // every byte above 0x7F as UTF-8 and corrupt it.
  const parts: Uint8Array[] = [
    enc('%FDF-1.2\n'),
    enc(`1 0 obj\n${serializeValue(root)}\nendobj\n`),
  ];
  if (annotObjects !== undefined) {
    for (const num of [...annotObjects.keys()].sort((a, b) => a - b)) {
      parts.push(enc(`${num} 0 obj\n`));
      parts.push(serializeObject(annotObjects.get(num)!));
      parts.push(enc('\nendobj\n'));
    }
  }
  parts.push(enc('trailer\n<< /Root 1 0 R >>\n%%EOF\n'));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Values as strings, whatever PDF type they arrived as. */
function valueStrings(v: PdfObject, resolve: (o: PdfObject) => PdfObject): string[] {
  if (isString(v)) return [decodePdfText(v.bytes)];
  if (isName(v)) return [v.name];
  if (isArray(v)) {
    const out: string[] = [];
    for (const e of v) {
      const r = resolve(e);
      if (isString(r)) out.push(decodePdfText(r.bytes));
      else if (isName(r)) out.push(r.name);
    }
    return out;
  }
  return [];
}

/** Flatten the /Fields tree, joining /T segments with '.'. Only nodes that
 *  carry a value become entries; the rest are containers. */
function walkFields(
  node: PdfObject,
  path: string,
  resolve: (o: PdfObject) => PdfObject,
  out: FormDataField[],
): void {
  const d = resolve(node);
  if (!isDict(d)) return;
  const t = resolve(d.get('T') ?? null);
  const seg = isString(t) ? decodePdfText(t.bytes) : '';
  const full = seg === '' ? path : path === '' ? seg : `${path}.${seg}`;

  if (d.has('V') || d.has('RV')) {
    const entry: FormDataField = {
      name: full,
      type: 'unknown',
      values: valueStrings(resolve(d.get('V') ?? null), resolve),
    };
    const rv = resolve(d.get('RV') ?? null);
    if (isString(rv)) entry.richText = decodePdfText(rv.bytes);
    out.push(entry);
  }

  const kids = resolve(d.get('Kids') ?? null);
  if (isArray(kids)) for (const k of kids) walkFields(k, full, resolve, out);
}

/** Parse an FDF file into the format-neutral model. Objects are scanned
 *  sequentially rather than through an xref, which FDF need not carry. */
export function readFdf(bytes: Uint8Array): FormData {
  if (!latin1(bytes.subarray(0, 5)).startsWith('%FDF-'))
    throw new PdfParseError('FDF: missing %FDF- header');

  const src = latin1(bytes);
  const objects = new Map<number, PdfObject>();
  for (const m of src.matchAll(/(\d+)[\s]+(\d+)[\s]+obj\b/g)) {
    try {
      const { num, value } = new ObjectParser(new Lexer(bytes, m.index ?? 0)).parseIndirectObject();
      objects.set(num, value);
    } catch {
      // A stray "n g obj" inside a string or comment: not an object, skip it.
    }
  }

  const ti = src.lastIndexOf('trailer');
  if (ti < 0) throw new PdfParseError('FDF: no trailer');
  const trailer = new ObjectParser(new Lexer(bytes, ti + 'trailer'.length)).parseObject();
  if (!isDict(trailer)) throw new PdfParseError('FDF: trailer is not a dictionary');

  const resolve = (o: PdfObject): PdfObject => (isRef(o) ? objects.get(o.num) ?? null : o);
  const root = resolve(trailer.get('Root') ?? null);
  if (!isDict(root)) throw new PdfParseError('FDF: no /Root dictionary');
  const fdf = resolve(root.get('FDF') ?? null);
  if (!isDict(fdf)) throw new PdfParseError('FDF: /Root has no /FDF dictionary');

  const data: FormData = { fields: [] };
  const f = resolve(fdf.get('F') ?? null);
  if (isString(f)) data.file = decodePdfText(f.bytes);
  const id = resolve(fdf.get('ID') ?? null);
  if (isArray(id) && id.length >= 2) {
    const a = resolve(id[0]);
    const b = resolve(id[1]);
    if (isString(a) && isString(b)) data.id = [toHex(a.bytes), toHex(b.bytes)];
  }
  const fields = resolve(fdf.get('Fields') ?? null);
  if (isArray(fields)) for (const e of fields) walkFields(e, '', resolve, data.fields);

  const annotSkips: SkippedAnnot[] = [];
  const annots = readFdfAnnots(resolve(fdf.get('Annots') ?? null), resolve, annotSkips);
  if (annots.length > 0) data.annots = annots;
  if (annotSkips.length > 0) data.annotSkips = annotSkips;
  return data;
}
