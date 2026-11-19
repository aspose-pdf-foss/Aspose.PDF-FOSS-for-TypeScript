import type { Document } from './document.js';
import { isDict, type PdfArray, type PdfDict } from './types.js';

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
