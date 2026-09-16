import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, name } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';

/** The PDF 1.7 standard structure namespace (ISO 32000-2 14.8.6). */
export const PDF17_NS = 'http://iso.org/pdf/ssn';
/** The PDF 2.0 standard structure namespace. */
export const PDF20_NS = 'http://iso.org/pdf2/ssn';
/** The MathML namespace. */
export const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';

/** Read a PDF text string (or a name) back as a JS string; undefined otherwise.
 *  `decodePdfText` is metadata.ts's, so the PDFDocEncoding/UTF-16 rule has one
 *  owner rather than a second reading here. */
function textOf(o: PdfObject | undefined): string | undefined {
  if (o === undefined || o === null) return undefined;
  if (isName(o)) return o.name;
  if (typeof o === 'object' && 'kind' in o && o.kind === 'string')
    return decodePdfText(o.bytes);
  return undefined;
}

/** The namespace URI an element's /NS names, or undefined when it states none.
 *
 *  **Invariant, and the whole reason this module exists:** `/NS` is TWO
 *  DIFFERENT KEYS. On a structure element it is a REFERENCE TO A NAMESPACE
 *  DICTIONARY; inside that dictionary it is THE URI STRING ITSELF. One owner,
 *  or two readers come to disagree about which of the two they are holding —
 *  and BOTH readings produce a plausible answer rather than an error. */
export function namespaceUriOf(doc: Document, elemDict: PdfDict): string | undefined {
  const nsDict = doc.resolve(elemDict.get('NS'));
  if (!isDict(nsDict)) return undefined;
  return textOf(doc.resolve(nsDict.get('NS')));
}

/** The live /Namespaces array on the structure tree root, created if absent. */
function namespacesArray(doc: Document, rootDict: PdfDict): PdfObject[] {
  const raw = doc.resolve(rootDict.get('Namespaces'));
  if (isArray(raw)) return raw;
  const arr: PdfObject[] = [];
  rootDict.set('Namespaces', arr);
  return arr;
}

/** Every namespace URI the tree declares, in /Namespaces order. */
export function namespacesOf(doc: Document, rootDict: PdfDict): string[] {
  const raw = doc.resolve(rootDict.get('Namespaces'));
  if (!isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const d = doc.resolve(entry);
    if (!isDict(d)) continue;
    const uri = textOf(doc.resolve(d.get('NS')));
    if (uri !== undefined) out.push(uri);
  }
  return out;
}

/** The ref to `uri`'s namespace dictionary, declaring it when absent.
 *
 *  **Invariant:** idempotent, and it REUSES the existing dictionary. A second
 *  dict for one URI makes two elements that are in the same namespace compare
 *  unequal by ref, which is exactly what ISO 14289-2 8.2.5.2-2 compares. */
export function ensureNamespace(doc: Document, rootDict: PdfDict, uri: string): PdfRef {
  const arr = namespacesArray(doc, rootDict);
  for (const entry of arr) {
    const d = doc.resolve(entry);
    if (isDict(d) && textOf(doc.resolve(d.get('NS'))) === uri) {
      // Already declared. Hand back its ref when it has one; otherwise
      // re-allocate so callers always receive something they can point /NS at.
      if (isRef(entry)) return entry;
      const r = doc.allocObject(d);
      arr[arr.indexOf(entry)] = r;
      return r;
    }
  }
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Namespace')],
    ['NS', { kind: 'string', bytes: encodePdfText(uri) }],
  ]);
  const ref = doc.allocObject(dict);
  arr.push(ref);
  doc.markModified();
  return ref;
}

/** The /RoleMapNS of the namespace `uri`, as role -> mapped role. Only the NAME
 *  form is read; the [name, namespace] array form maps into ANOTHER namespace
 *  and is deliberately not followed here — ISO 14289-2 8.2.4-3's question is
 *  whether a mapping stays inside one namespace. */
export function roleMapNsOf(doc: Document, rootDict: PdfDict, uri: string): Map<string, string> {
  const out = new Map<string, string>();
  const raw = doc.resolve(rootDict.get('Namespaces'));
  if (!isArray(raw)) return out;
  for (const entry of raw) {
    const d = doc.resolve(entry);
    if (!isDict(d) || textOf(doc.resolve(d.get('NS'))) !== uri) continue;
    const rm = doc.resolve(d.get('RoleMapNS'));
    if (!isDict(rm)) continue;
    for (const [k, v] of rm) {
      const mapped = doc.resolve(v);
      if (isName(mapped)) out.set(k, mapped.name);
    }
  }
  return out;
}
