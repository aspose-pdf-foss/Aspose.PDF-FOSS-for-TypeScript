// Catalog-level actions: /OpenAction and the /Names /JavaScript tree — what the
// DOCUMENT does, as opposed to what activating an annotation does, which is
// annotation.ts's /A. Both halves are small, both write to the catalog, and
// neither has anything the other lacks, so they share a module rather than
// making a two-file feature with nothing in either file.
//
// Nothing here re-derives the action grammar: encodeAction and
// parseStandaloneAction in actions.ts are the one owner, which is what gives
// this module the /JS stream read for free.
import type { Document } from './document.js';
import { PdfObject, isDict, isName } from './types.js';
import { encodeAction, parseStandaloneAction, type PdfAction } from './actions.js';
import { decodeDest, encodeDest, type PageDest } from './outline.js';
import {
  collectNameTree, removeNameTreeEntry, upsertNameTreeEntry,
} from './nametree.js';

/** What a document does when it is opened: go to a view, or run an action.
 *  32000-1 table 28 permits either.
 *
 *  Discriminated on `kind` rather than `type` because {@link PdfAction} already
 *  uses `type`, and nesting two of them one level apart reads badly. */
export type OpenAction =
  | { kind: 'dest'; dest: PageDest }
  | { kind: 'action'; action: PdfAction };

/** Read the catalog /OpenAction; undefined when absent, or present in a form
 *  this library does not model.
 *
 *  **The discriminator is `/S`, and it must be tested FIRST.** Three shapes
 *  arrive and two of them are dicts: a bare array is a destination,
 *  `<< /D [...] >>` is a destination, and `<< /S /GoTo /D [...] >>` is an
 *  action. `decodeDest` already accepts the middle form, and a GoTo action
 *  carries /D too, so a dict alone decides nothing.
 *
 *  This is the one rule here that is silently wrong when wrong: a GoTo action
 *  mis-read as a destination resolves to the SAME page, so every page-number
 *  assertion passes while the reported kind is wrong and a read-modify-write
 *  rewrites the producer's action dict as a bare array. */
export function readOpenAction(doc: Document): OpenAction | undefined {
  const v = doc.resolve(doc.catalog().get('OpenAction'));
  if (isDict(v) && isName(doc.resolve(v.get('S')))) {
    const action = parseStandaloneAction(doc, v);
    return action ? { kind: 'action', action } : undefined;
  }
  const dest = decodeDest(doc, v, (o) => doc.pageNumberOf(o));
  return dest ? { kind: 'dest', dest } : undefined;
}

/** Write /OpenAction as a bare destination array. */
export function setOpenDestination(doc: Document, dest: PageDest): void {
  const p = dest.page;
  if (!Number.isInteger(p) || p < 1 || p > doc.Pages.length)
    throw new RangeError(`open destination page ${String(p)} out of range 1..${doc.Pages.length}`);
  doc.catalog().set('OpenAction', encodeDest(doc.pageRef(p), dest.view));
}

/** Write /OpenAction as a direct action dict. `encodeAction` validates — it
 *  already range-checks a goto page and rejects an unknown type, and a second
 *  copy of those checks is how two entry points come to disagree about a page
 *  number. */
export function setOpenAction(doc: Document, action: PdfAction): void {
  const dict = encodeAction(doc, action);
  doc.catalog().set('OpenAction', dict);
}

/** Delete /OpenAction. A no-op when absent. */
export function removeOpenAction(doc: Document): void {
  doc.catalog().delete('OpenAction');
}

/** One entry of the document-level JavaScript name tree. */
export interface DocumentJavaScript {
  /** The name-tree key. Viewers run every entry at open, in name order. */
  name: string;
  /** The script text. */
  script: string;
}

/** Every entry of /Root /Names /JavaScript, sorted by name — matching
 *  `GetNamedDestinations`.
 *
 *  Entries are read through `parseStandaloneAction`, never by reaching for /JS
 *  directly: that function is the one owner of the action grammar, and it is
 *  what makes a stream /JS readable here.
 *
 *  32000-1 §7.7.4 requires these values to be JavaScript actions. An entry that
 *  parses as anything else has no script to report and {@link DocumentJavaScript}
 *  admits nothing else, so it is SKIPPED while its siblings are still returned. */
export function readDocumentJavaScripts(doc: Document): DocumentJavaScript[] {
  const names = doc.resolve(doc.catalog().get('Names'));
  if (!isDict(names)) return [];
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get('JavaScript') ?? null, collected);
  const out: DocumentJavaScript[] = [];
  for (const [key, value] of collected) {
    const a = parseStandaloneAction(doc, value);
    if (a?.type === 'javascript') out.push({ name: key, script: a.script });
  }
  return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** Upsert `key` → a JavaScript action carrying `script`.
 *
 *  The action is built BEFORE the tree is touched, so `encodeAction`'s rejection
 *  of an empty script leaves the document byte-identical. */
export function setDocumentJavaScript(doc: Document, key: string, script: string): void {
  if (typeof key !== 'string' || key === '')
    throw new TypeError('document JavaScript name must be a non-empty string');
  const value = encodeAction(doc, { type: 'javascript', script });
  upsertNameTreeEntry(doc, 'JavaScript', key, value);
}

/** Remove `key` from the tree, pruning the empty containers. False when absent. */
export function removeDocumentJavaScript(doc: Document, key: string): boolean {
  return removeNameTreeEntry(doc, 'JavaScript', key) !== undefined;
}
