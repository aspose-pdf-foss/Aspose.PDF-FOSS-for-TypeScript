import { parseXml, XmlNode } from './xml.js';
import { PdfArray, PdfDict, PdfObject, PdfStream, name as pdfName } from './types.js';

/** Adobe's COS-as-XML encoding, read-only.
 *
 *  Acrobat does not put a PDF fragment in an XFDF <appearance> element (which
 *  is what we write — see encodeAppearance in xfdfannot.ts). It puts base64 of
 *  an XML serialization of the COS objects, rooted at <DICT KEY="AP">:
 *
 *    <DICT KEY="AP"><STREAM KEY="N">
 *      <ARRAY KEY="BBox"><FIXED VAL="0.000000"/>…</ARRAY>
 *      <NAME KEY="Subtype" VAL="Form"/>
 *      <DICT KEY="Resources">…</DICT>
 *      <DATA ENCODING="HEX" MODE="RAW">4d5a…</DATA>
 *    </STREAM></DICT>
 *
 *  A dict entry carries its key in KEY and a scalar its value in VAL; array
 *  elements have no KEY. A stream's bytes are a <DATA> child of the STREAM.
 *
 *  The format is not in ISO 19444-1 — it is Acrobat's, and this reader was
 *  written against a real Acrobat-produced file (see
 *  test/fixtures/xfdf/README.md). Apache PDFBox reads the same shape in
 *  FDFAnnotationStamp; where the two could differ this follows the file.
 *
 *  We do not write this encoding, only read it. */

/** Deep enough for any real appearance; a guard against pathological nesting. */
const MAX_DEPTH = 64;

/** Element name test. Acrobat writes these upper-case, but PDFBox compares
 *  case-insensitively for the root and stream children, so we do too. */
const is = (node: XmlNode, tag: string): boolean =>
  node.name.toUpperCase() === tag;

/** Hex payload → bytes. Returns undefined for anything that is not clean hex,
 *  which fails the whole decode rather than silently truncating a stream. */
function decodeHex(text: string): Uint8Array | undefined {
  const hex = text.replace(/\s+/g, '');
  if (hex.length % 2 !== 0 || /[^0-9A-Fa-f]/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** One element → one PDF object. Returns undefined for an element this
 *  encoding does not define, so the caller can reject the payload. */
function toObject(node: XmlNode, depth: number): PdfObject | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const val = node.attrs.get('VAL') ?? '';
  switch (node.name.toUpperCase()) {
    case 'INT': case 'FIXED': {
      const n = Number(val);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'NAME': return pdfName(val);
    case 'BOOL': return val.toLowerCase() === 'true';
    case 'ARRAY': return toArray(node, depth);
    case 'DICT': return toDict(node, depth);
    case 'STREAM': return toStream(node, depth);
    default: return undefined;
  }
}

function toArray(node: XmlNode, depth: number): PdfArray | undefined {
  const out: PdfArray = [];
  for (const child of node.children) {
    const v = toObject(child, depth + 1);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}

/** Children keyed by their KEY attribute. A child with no KEY is not
 *  addressable in a dict, so it is dropped rather than guessed at. */
function toDict(node: XmlNode, depth: number): PdfDict | undefined {
  const dict: PdfDict = new Map<string, PdfObject>();
  for (const child of node.children) {
    const key = child.attrs.get('KEY');
    if (key === undefined) continue;
    const v = toObject(child, depth + 1);
    if (v === undefined) return undefined;
    dict.set(key, v);
  }
  return dict;
}

/** A STREAM is a dict whose entries are its non-DATA children, plus the bytes
 *  carried by its single <DATA> child. */
function toStream(node: XmlNode, depth: number): PdfStream | undefined {
  const dict: PdfDict = new Map<string, PdfObject>();
  let raw: Uint8Array | undefined;
  let decoded = false;

  for (const child of node.children) {
    if (is(child, 'DATA')) {
      if (raw !== undefined) return undefined;       // two bodies: not this encoding
      const encoding = (child.attrs.get('ENCODING') ?? '').toUpperCase();
      if (encoding === 'HEX') {
        raw = decodeHex(child.text);
      } else if (encoding === 'ASCII') {
        // ASCII data is the *decoded* content, so whatever /Filter says no
        // longer applies to these bytes.
        raw = new TextEncoder().encode(child.text);
        decoded = true;
      }
      if (raw === undefined) return undefined;
      continue;
    }
    const key = child.attrs.get('KEY');
    if (key === undefined) continue;
    if (key === 'Length') continue;                  // restated from the bytes below
    const v = toObject(child, depth + 1);
    if (v === undefined) return undefined;
    dict.set(key, v);
  }

  if (raw === undefined) raw = new Uint8Array(0);
  if (decoded) dict.delete('Filter');
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}

/** Decode an Acrobat <appearance> payload into the /AP /N Form XObject.
 *  Returns undefined for anything that is not this encoding — including a
 *  payload that is this encoding but carries no /N — so the caller can fall
 *  back to regenerating the appearance. */
export function decodeCosXmlAppearance(bytes: Uint8Array): PdfStream | undefined {
  let root: XmlNode;
  try {
    root = parseXml(bytes);
  } catch {
    return undefined;
  }
  if (!is(root, 'DICT') || root.attrs.get('KEY') !== 'AP') return undefined;

  const n = root.children.find((c) => is(c, 'STREAM') && c.attrs.get('KEY') === 'N');
  return n ? toStream(n, 0) : undefined;
}
