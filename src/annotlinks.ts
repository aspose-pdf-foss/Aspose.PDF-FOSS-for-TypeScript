import type { Document } from './document.js';
import { isDict, isName, type PdfArray, type PdfDict, type PdfObject } from './types.js';

export function isAnnotationDict(doc: Document, object: PdfObject | undefined): object is PdfDict {
  if (!isDict(object) || !isName(doc.resolve(object.get('Subtype')))) return false;
  const type = doc.resolve(object.get('Type'));
  return type === null || (isName(type) && type.name === 'Annot');
}

export function replyParentDict(doc: Document, dict: PdfDict): PdfDict | undefined {
  const parent = doc.resolve(dict.get('IRT'));
  return isAnnotationDict(doc, parent) ? parent : undefined;
}

export function hasReplyCycle(doc: Document, reply: PdfDict, parent: PdfDict): boolean {
  const seen = new Set([reply]);
  for (let ancestor: PdfDict | undefined = parent; ancestor; ancestor = replyParentDict(doc, ancestor)) {
    if (seen.has(ancestor)) return true;
    seen.add(ancestor);
  }
  return false;
}

export function clearReplyLink(annotation: PdfDict): void {
  annotation.delete('IRT');
  annotation.delete('RT');
}

/** A surviving reply must not keep a removed annotation reachable from /Root. */
export function unlinkRemovedReplyParents(doc: Document, annots: PdfArray, removed: ReadonlySet<PdfDict>): void {
  for (const entry of annots) {
    const reply = doc.resolve(entry);
    if (!isDict(reply) || !reply.has('IRT')) continue;
    const parent = doc.resolve(reply.get('IRT'));
    if (isDict(parent) && removed.has(parent)) clearReplyLink(reply);
  }
}
