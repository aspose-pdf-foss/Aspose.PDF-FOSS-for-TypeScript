import { XmlNode } from './xml.js';
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isStream, isString, name as pdfName } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { serializeObject } from './serialize.js';
import { decodeCosXmlAppearance } from './cosxml.js';
import type { AnnotData } from './annotdata.js';
import type { SkippedAnnot } from './formdata.js';

/** PDF /Subtype → XFDF element name. The XFDF names are the PDF ones
 *  lowercased, with no other transformation. */
export const XFDF_ELEMENT: ReadonlyMap<string, string> = new Map([
  ['Text', 'text'], ['Highlight', 'highlight'], ['Underline', 'underline'],
  ['Squiggly', 'squiggly'], ['StrikeOut', 'strikeout'], ['Square', 'square'],
  ['Circle', 'circle'], ['Line', 'line'], ['Polygon', 'polygon'],
  ['PolyLine', 'polyline'], ['Ink', 'ink'], ['FreeText', 'freetext'],
  ['Stamp', 'stamp'], ['Caret', 'caret'], ['Sound', 'sound'], ['Link', 'link'],
  ['FileAttachment', 'fileattachment'], ['Popup', 'popup'],
]);

/** XFDF element name → PDF /Subtype. */
export const XFDF_SUBTYPE: ReadonlyMap<string, string> =
  new Map(Array.from(XFDF_ELEMENT, ([k, v]) => [v, k] as const));

type AttrKind = 'text' | 'name' | 'num' | 'nums' | 'color' | 'date' | 'flags' | 'inklist';

interface AttrSpec { attr: string; key: string; kind: AttrKind }

/** The attribute table, driving both directions so they cannot drift apart.
 *  Entries whose key is absent from a given subtype's dict simply do not
 *  appear — there is no per-subtype gating, because the dict is the authority
 *  on which entries an annotation actually has. */
const COMMON: readonly AttrSpec[] = [
  { attr: 'rect', key: 'Rect', kind: 'nums' },
  { attr: 'color', key: 'C', kind: 'color' },
  { attr: 'interior-color', key: 'IC', kind: 'color' },
  { attr: 'opacity', key: 'CA', kind: 'num' },
  { attr: 'flags', key: 'F', kind: 'flags' },
  { attr: 'date', key: 'M', kind: 'date' },
  { attr: 'creationdate', key: 'CreationDate', kind: 'date' },
  { attr: 'title', key: 'T', kind: 'text' },
  { attr: 'subject', key: 'Subj', kind: 'text' },
  { attr: 'name', key: 'NM', kind: 'text' },
  { attr: 'intent', key: 'IT', kind: 'name' },
  { attr: 'icon', key: 'Name', kind: 'name' },
  { attr: 'symbol', key: 'Sy', kind: 'name' },
  { attr: 'rotation', key: 'Rotate', kind: 'num' },
  { attr: 'coords', key: 'QuadPoints', kind: 'nums' },
  { attr: 'vertices', key: 'Vertices', kind: 'nums' },
  { attr: 'inklist', key: 'InkList', kind: 'inklist' },
  { attr: 'fringe', key: 'RD', kind: 'nums' },
];

/** Child elements carrying plain text. /RC is handled separately: it is markup. */
const TEXT_CHILDREN: readonly { el: string; key: string }[] = [
  { el: 'contents', key: 'Contents' },
  { el: 'defaultappearance', key: 'DA' },
  { el: 'defaultstyle', key: 'DS' },
];

/** /F bit values, low bit first, under the names XFDF gives them. */
const FLAG_NAMES: readonly string[] = [
  'invisible', 'hidden', 'print', 'nozoom', 'norotate', 'noview', 'readonly',
  'locked', 'togglenoview',
];

const el = (name: string, attrs: Record<string, string> = {}): XmlNode =>
  ({ name, attrs: new Map(Object.entries(attrs)), children: [], text: '', nodes: [] });

/** A number as XFDF writes it: no exponent, no trailing zeros. */
const numStr = (n: number): string => String(Number(n.toFixed(6)));

const hex2 = (v: number): string =>
  Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0').toUpperCase();

/** A flat number list from an array; undefined when absent or malformed. */
function nums(o: PdfObject | undefined): number[] | undefined {
  if (!isArray(o)) return undefined;
  const out: number[] = [];
  for (const e of o) {
    if (typeof e !== 'number' || !Number.isFinite(e)) return undefined;
    out.push(e);
  }
  return out;
}

/** Format one dict entry as its XFDF attribute value; undefined to omit it. */
function format(kind: AttrKind, v: PdfObject | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  switch (kind) {
    case 'text': case 'date':
      return isString(v) ? decodePdfText(v.bytes) : undefined;
    case 'name':
      return isName(v) ? v.name : undefined;
    case 'num':
      return typeof v === 'number' && Number.isFinite(v) ? numStr(v) : undefined;
    case 'nums': {
      const a = nums(v);
      return a === undefined || a.length === 0 ? undefined : a.map(numStr).join(',');
    }
    case 'color': {
      const a = nums(v);
      return a === undefined || a.length !== 3 ? undefined : `#${hex2(a[0])}${hex2(a[1])}${hex2(a[2])}`;
    }
    case 'flags': {
      if (typeof v !== 'number' || !Number.isInteger(v) || v === 0) return undefined;
      const on = FLAG_NAMES.filter((_, i) => (v & (1 << i)) !== 0);
      return on.length === 0 ? undefined : on.join(',');
    }
    case 'inklist': {
      if (!isArray(v)) return undefined;
      const paths: string[] = [];
      for (const stroke of v) {
        const a = nums(stroke);
        if (a === undefined || a.length === 0) return undefined;
        paths.push(a.map(numStr).join(','));
      }
      return paths.length === 0 ? undefined : paths.join(';');
    }
  }
}

/** Serialize one annotation as its XFDF element; undefined for a subtype with
 *  no XFDF equivalent. */
function writeOne(a: AnnotData): XmlNode | undefined {
  const sub = a.dict.get('Subtype');
  const subtype = isName(sub) ? sub.name : '';
  const elName = XFDF_ELEMENT.get(subtype);
  if (elName === undefined) return undefined;

  const node = el(elName, { page: String(a.page) });
  for (const spec of COMMON) {
    const text = format(spec.kind, a.dict.get(spec.key));
    if (text !== undefined) node.attrs.set(spec.attr, text);
  }

  // /L is one array in the dict but two attributes in XFDF.
  const l = nums(a.dict.get('L'));
  if (l !== undefined && l.length === 4) {
    node.attrs.set('start', `${numStr(l[0])},${numStr(l[1])}`);
    node.attrs.set('end', `${numStr(l[2])},${numStr(l[3])}`);
  }
  // /LE likewise.
  const le = a.dict.get('LE');
  if (isArray(le) && le.length === 2 && isName(le[0]) && isName(le[1])) {
    node.attrs.set('head', (le[0] as { name: string }).name);
    node.attrs.set('tail', (le[1] as { name: string }).name);
  }
  // Border width lives at /BS /W.
  const bs = a.dict.get('BS');
  if (isDict(bs)) {
    const w = (bs as PdfDict).get('W');
    if (typeof w === 'number' && Number.isFinite(w)) node.attrs.set('width', numStr(w));
  }
  if (a.inReplyTo !== undefined) node.attrs.set('inreplyto', a.inReplyTo);

  // /AP travels as base64 in an <appearance> child. The dict is self-contained,
  // so /N is already an inline stream rather than a reference.
  const ap = a.dict.get('AP');
  if (isDict(ap)) {
    const n = (ap as PdfDict).get('N');
    if (isStream(n)) {
      const child = el('appearance');
      child.text = encodeAppearance(n);
      node.children.push(child);
    }
  }

  for (const { el: childName, key } of TEXT_CHILDREN) {
    const v = a.dict.get(key);
    if (!isString(v)) continue;
    const child = el(childName);
    child.text = decodePdfText(v.bytes);
    node.children.push(child);
  }
  // /RC is markup: emitted verbatim rather than escaped.
  const rc = a.dict.get('RC');
  if (isString(rc)) {
    const child = el('contents-richtext');
    child.raw = decodePdfText(rc.bytes);
    node.children.push(child);
  }
  return node;
}

/** Serialize the annotation list as an <annots> element. A popup is emitted
 *  nested inside the annotation that owns it, which is where XFDF puts it. */
export function writeAnnots(annots: AnnotData[]): XmlNode {
  const root = el('annots');

  const nameOf = (a: AnnotData): string | undefined => {
    const nm = a.dict.get('NM');
    return isString(nm) ? decodePdfText(nm.bytes) : undefined;
  };
  const byName = new Map<string, AnnotData>();
  for (const a of annots) {
    const nm = nameOf(a);
    if (nm !== undefined) byName.set(nm, a);
  }
  const nested = new Set<AnnotData>();
  for (const a of annots) {
    if (a.popupName === undefined) continue;
    const p = byName.get(a.popupName);
    if (p !== undefined) nested.add(p);
  }

  for (const a of annots) {
    if (nested.has(a)) continue;   // emitted inside its parent instead
    const node = writeOne(a);
    if (node === undefined) continue;
    if (a.popupName !== undefined) {
      const p = byName.get(a.popupName);
      const pn = p === undefined ? undefined : writeOne(p);
      if (pn !== undefined) node.children.push(pn);
    }
    root.children.push(node);
  }
  return root;
}

// ---------------------------------------------------------------------------
// The <appearance> codec
// ---------------------------------------------------------------------------

/** Encode an appearance stream for the <appearance> element: the Form XObject
 *  serialized as a single-object PDF fragment, base64-encoded.
 *
 *  The XFDF standard does not pin this payload down and producers disagree, so
 *  this encoding is ours. decodeAppearance treats anything it cannot read as
 *  absent, which keeps a foreign file importable at property fidelity. */
export function encodeAppearance(stream: PdfStream): string {
  const body = serializeObject(stream);
  const head = new TextEncoder().encode('1 0 obj\n');
  const tail = new TextEncoder().encode('\nendobj\n');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return Buffer.from(out).toString('base64');
}

/** First non-whitespace byte, or -1. The two encodings we read are told apart
 *  by it: ours opens `1 0 obj`, Acrobat's `<DICT KEY="AP">`. */
function firstByte(bytes: Uint8Array): number {
  for (const b of bytes) if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return b;
  return -1;
}

/** Decode an <appearance> payload. Reads two encodings: ours (a single-object
 *  PDF fragment, see encodeAppearance) and Acrobat's COS-as-XML (see
 *  cosxml.ts). Returns undefined for anything unusable — a third encoding,
 *  corrupt base64, or an object that is not a stream — so the caller
 *  regenerates the appearance instead of failing the import. */
export function decodeAppearance(b64: string): PdfStream | undefined {
  const trimmed = b64.trim();
  if (trimmed === '' || /[^A-Za-z0-9+/=\s]/.test(trimmed)) return undefined;
  try {
    const bytes = new Uint8Array(Buffer.from(trimmed, 'base64'));
    if (bytes.length === 0) return undefined;
    if (firstByte(bytes) === 0x3c /* < */) return decodeCosXmlAppearance(bytes);
    const { value } = new ObjectParser(new Lexer(bytes, 0)).parseIndirectObject();
    return isStream(value) ? value : undefined;
  } catch {
    return undefined;   // unreadable is not an error: we regenerate instead
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Thrown internally when an attribute cannot be parsed; caught per annotation
 *  and turned into a skip, so one bad element never fails a whole import. */
class AttrError extends Error {
  constructor(readonly attr: string) { super(`malformed ${attr}`); }
}

/** Comma-separated finite numbers. */
function parseNums(attr: string, text: string): number[] {
  const parts = text.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const out: number[] = [];
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isFinite(v)) throw new AttrError(attr);
    out.push(v);
  }
  if (out.length === 0) throw new AttrError(attr);
  return out;
}

/** #RRGGBB → RGB components in 0..1. */
function parseColor(attr: string, text: string): number[] {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(text.trim());
  if (!m) throw new AttrError(attr);
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Comma-separated flag names → the /F bitfield. Unknown names are ignored. */
function parseFlags(text: string): number {
  let f = 0;
  for (const part of text.split(',')) {
    const i = FLAG_NAMES.indexOf(part.trim().toLowerCase());
    if (i >= 0) f |= 1 << i;
  }
  return f;
}

/** Turn one attribute into its dict value. */
function parseAttr(spec: AttrSpec, text: string): PdfObject {
  switch (spec.kind) {
    case 'text': case 'date':
      return { kind: 'string', bytes: encodePdfText(text) };
    case 'name':
      return pdfName(text);
    case 'num': {
      const v = Number(text);
      if (!Number.isFinite(v)) throw new AttrError(spec.attr);
      return v;
    }
    case 'nums':
      return parseNums(spec.attr, text);
    case 'color':
      return parseColor(spec.attr, text);
    case 'flags':
      return parseFlags(text);
    case 'inklist':
      return text.split(';').map((p) => parseNums(spec.attr, p));
  }
}

/** Build one AnnotData from an element, or throw AttrError. */
function readOne(node: XmlNode, subtype: string): AnnotData {
  const pageText = node.attrs.get('page');
  const page = pageText === undefined ? NaN : Number(pageText);
  if (!Number.isInteger(page) || page < 0) throw new AttrError('__page');

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', pdfName('Annot')],
    ['Subtype', pdfName(subtype)],
  ]);

  for (const spec of COMMON) {
    const text = node.attrs.get(spec.attr);
    if (text === undefined) continue;
    dict.set(spec.key, parseAttr(spec, text));
  }

  // start + end recombine into /L; head + tail into /LE.
  const start = node.attrs.get('start');
  const end = node.attrs.get('end');
  if (start !== undefined && end !== undefined)
    dict.set('L', [...parseNums('start', start), ...parseNums('end', end)]);
  const head = node.attrs.get('head');
  const tail = node.attrs.get('tail');
  if (head !== undefined && tail !== undefined) dict.set('LE', [pdfName(head), pdfName(tail)]);

  const width = node.attrs.get('width');
  if (width !== undefined) {
    const w = Number(width);
    if (!Number.isFinite(w)) throw new AttrError('width');
    dict.set('BS', new Map<string, PdfObject>([['W', w]]));
  }

  for (const child of node.children) {
    for (const { el: elName, key } of TEXT_CHILDREN)
      if (child.name === elName) dict.set(key, { kind: 'string', bytes: encodePdfText(child.text) });
    if (child.name === 'contents-richtext')
      dict.set('RC', { kind: 'string', bytes: encodePdfText(child.raw ?? child.text) });
    if (child.name === 'appearance') {
      const stream = decodeAppearance(child.text);
      if (stream !== undefined) dict.set('AP', new Map<string, PdfObject>([['N', stream]]));
    }
  }

  const out: AnnotData = { page, dict };
  const irt = node.attrs.get('inreplyto');
  if (irt !== undefined) out.inReplyTo = irt;
  return out;
}

/** Read the <annots> element into the format-neutral model. Accepts either the
 *  <annots> element itself or a root containing one. A nested <popup> becomes
 *  its own entry, linked from its parent by name. Problems are reported per
 *  annotation; nothing here throws. */
export function readAnnots(root: XmlNode, skipped: SkippedAnnot[]): AnnotData[] {
  const out: AnnotData[] = [];
  const annots = root.name === 'annots'
    ? root
    : root.children.find((c) => c.name === 'annots');
  if (annots === undefined) return out;

  let seq = 0;
  for (const node of annots.children) {
    const subtype = XFDF_SUBTYPE.get(node.name);
    if (subtype === undefined) {
      skipped.push({ reason: 'unsupported annotation type' });
      continue;
    }
    let entry: AnnotData;
    try {
      entry = readOne(node, subtype);
    } catch (err) {
      const attr = err instanceof AttrError ? err.attr : '';
      const pageText = node.attrs.get('page');
      const page = pageText === undefined ? NaN : Number(pageText);
      skipped.push({
        ...(Number.isInteger(page) ? { page } : {}),
        subtype,
        reason: attr === '__page' ? 'missing page index' : `malformed ${attr}`,
      });
      continue;
    }

    const popupEl = node.children.find((c) => c.name === 'popup');
    if (popupEl !== undefined) {
      try {
        const popup = readOne(popupEl, 'Popup');
        let nm = popup.dict.get('NM');
        if (!isString(nm)) {
          nm = { kind: 'string', bytes: encodePdfText(`popup-${++seq}`) };
          popup.dict.set('NM', nm);
        }
        entry.popupName = decodePdfText((nm as { bytes: Uint8Array }).bytes);
        out.push(popup);
      } catch {
        // A malformed popup loses the popup, not the annotation that owns it.
      }
    }
    out.push(entry);
  }
  return out;
}
