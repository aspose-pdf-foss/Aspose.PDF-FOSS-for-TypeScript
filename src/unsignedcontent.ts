import type { Document } from './document.js';
import type { Change, SignatureReport } from './sigverify.js';
import { signatureRevisionEnd, type SignatureField } from './signature.js';
import { isArray, isDict, isName, isRef, isStream, type PdfDict, type PdfObject } from './types.js';
import { equalPdfObjects } from './docmdp.js';
import { rethrowLimit } from './errors.js';

/** A changed annotation or widget in the current revision. */
export interface UnsignedAnnotationChange {
  /** Current 1-based page number, when attached to a page. */
  page?: number;
  /** Indirect object number, when the annotation has one. */
  object?: number;
  /** PDF annotation subtype, without the leading slash. */
  subtype: string;
  /** Full AcroForm field name, for widgets with a named owner. */
  field?: string;
}

/** Post-signing changes attributed to content in the current revision. */
export interface UnsignedContentSummary {
  /** Affected page numbers in current document order, starting at 1. */
  pages: number[];
  /** Changed annotations other than form widgets. */
  annotations: UnsignedAnnotationChange[];
  /** Changed widget annotations, including their field names when known. */
  widgets: UnsignedAnnotationChange[];
  /** Sorted, distinct full names of changed fields and owners of changed widgets. */
  fields: string[];
}

/** Attribute changes only for the latest signed byte extent. Field order and
 *  timestamps claimed by a signer have no bearing on revision order. */
export async function attachUnsignedContentSummary(
  doc: Document, signatures: readonly SignatureField[], reports: SignatureReport[], length: number,
  openSignedRevision: (end: number) => Document | Promise<Document>,
): Promise<void> {
  let latest: SignatureReport | undefined;
  let end = 0;
  for (let i = 0; i < signatures.length; i++) {
    const signedEnd = signatureRevisionEnd(signatures[i].byteRange, length);
    if (signedEnd === undefined || signedEnd <= end) continue;
    end = signedEnd;
    latest = reports[i];
  }
  if (latest?.integrity === 'valid' && latest.signature === 'valid') {
    let previous: Document | undefined;
    if (latest.modifications.length > 0) {
      try { previous = await openSignedRevision(end); }
      catch (caught) { rethrowLimit(caught); }
    }
    latest.unsignedContent = summarize(doc, latest.modifications, (num) => previous?.getObject(num));
  }
}

function children(value: PdfObject): Iterable<PdfObject> | undefined {
  if (isArray(value)) return value;
  if (isDict(value)) return value.values();
  if (isStream(value)) return value.dict.values();
  return undefined;
}

const PAGE_INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
const PAGE_OWN_ATTRIBUTES = ['TrimBox', 'BleedBox', 'ArtBox', 'UserUnit'];
const FIELD_INHERITED = ['FT', 'Ff', 'V'];
const INHERITED_KEYS = [...PAGE_INHERITED, ...FIELD_INHERITED, 'T'];
// Attachment links and field values get their own attribution. A revised
// page or reply target should not make all annotations pointing to it dirty.
const ANNOTATION_LINKS = new Set(['P', 'Parent', 'Popup', 'IRT']);
const WIDGET_FIELD_KEYS = new Set(['Kids', 'T', 'FT', 'Ff', 'V', 'DV', 'Opt']);

function summarize(
  doc: Document, modifications: readonly Change[], previousObject: (num: number) => PdfObject | undefined,
): UnsignedContentSummary {
  const result: UnsignedContentSummary = { pages: [], annotations: [], widgets: [], fields: [] };
  if (!modifications.length) return result;

  const changed = new Set(modifications.map(({ object }) => object));
  const changedContainers = new Map<PdfObject, number>();
  for (const num of changed) {
    const value = doc.getObject(num);
    if (isDict(value) || isArray(value) || isStream(value)) changedContainers.set(value, num);
  }
  const touched = (value: PdfObject | undefined): boolean =>
    isRef(value) ? changed.has(value.num) : value !== undefined && changedContainers.has(value);

  const checked = new Map<PdfObject, boolean>();
  const touchesGraph = (root: PdfObject | undefined): boolean => {
    const visited = new Set<PdfObject>();
    const refs = new Set<number>();
    const stack: { value: PdfObject; entries: Iterator<PdfObject> }[] = [];
    const visit = (start: PdfObject): boolean => {
      let value = start;
      while (isRef(value)) {
        if (touched(value)) return true;
        if (refs.has(value.num)) return false;
        refs.add(value.num);
        value = doc.resolve(value);
      }
      if (touched(value)) return true;
      const known = checked.get(value);
      if (known !== undefined) return known;
      const entries = children(value);
      if (entries && !visited.has(value)) {
        visited.add(value);
        stack.push({ value, entries: entries[Symbol.iterator]() });
      }
      return false;
    };
    let hit = visit(root ?? null);
    while (!hit && stack.length) {
      const next = stack[stack.length - 1].entries.next();
      if (next.done) stack.pop();
      else hit = visit(next.value);
    }
    // A positive search proves only the active path. An exhausted search
    // proves all visited containers negative, even when some form cycles.
    if (hit) for (const { value } of stack) checked.set(value, true);
    else for (const value of visited) checked.set(value, false);
    return hit;
  };

  const changedKeys = new Map<PdfDict, Set<string>>();
  const changedInheritedKeys = (dict: PdfDict, num: number): Set<string> => {
    const cached = changedKeys.get(dict);
    if (cached) return cached;
    const before = previousObject(num);
    const old = isDict(before) ? before : undefined;
    const keys = new Set<string>();
    for (const key of INHERITED_KEYS) {
      if (!equalPdfObjects(dict.get(key), old?.get(key))) keys.add(key);
    }
    changedKeys.set(dict, keys);
    return keys;
  };
  const fieldValueChanged = (value: PdfObject | undefined): boolean =>
    touched(value) || (isArray(doc.resolve(value)) && touchesGraph(value));

  const inheritsChange = (dict: PdfDict, keys: readonly string[], trackFieldName = false): boolean => {
    const remaining = new Set(keys);
    const seen = new Set<PdfDict>();
    let node: PdfObject = dict;
    while ((remaining.size || trackFieldName) && isDict(node) && !seen.has(node)) {
      seen.add(node);
      const num = changedContainers.get(node);
      const differences = num === undefined ? undefined : changedInheritedKeys(node, num);
      if (trackFieldName && (differences?.has('T') || touched(node.get('T')))) return true;
      for (const key of remaining) {
        if (differences?.has(key)) return true;
        if (!node.has(key)) continue;
        const value = node.get(key);
        if (touched(value) || (key === 'Resources' && touchesGraph(value))
          || (key === 'V' && fieldValueChanged(value))) return true;
        if ((key === 'FT' && !isName(doc.resolve(value)))
          || (key === 'Ff' && typeof doc.resolve(value) !== 'number')) continue;
        remaining.delete(key);
      }
      node = doc.resolve(node.get('Parent'));
    }
    return false;
  };

  const annotationChanged = (dict: PdfDict, widget: boolean): boolean => {
    for (const [key, value] of dict) {
      if (!ANNOTATION_LINKS.has(key) && !(widget && WIDGET_FIELD_KEYS.has(key)) && touched(value)) return true;
    }
    return touchesGraph(dict.get('AP'));
  };

  const subtypeOf = (dict: PdfDict): string => {
    const subtype = doc.resolve(dict.get('Subtype'));
    return isName(subtype) ? subtype.name : '';
  };
  const fields = new Set<string>();
  const owners = new Map<PdfDict, { name: string; changed: boolean }>();
  for (const field of doc.Form.Fields) {
    const changed = touched(field.Dict) || touched(field.Dict.get('Kids')) || touchesGraph(field.Dict.get('Opt'))
      || fieldValueChanged(field.Dict.get('DV')) || inheritsChange(field.Dict, FIELD_INHERITED, true);
    if (changed && field.FullName) fields.add(field.FullName);
    for (const widget of field.Widgets) {
      if (subtypeOf(widget) === 'Widget') owners.set(widget, { name: field.FullName, changed });
    }
  }

  const attachedWidgets = new Set<PdfDict>();
  for (const page of doc.Pages) {
    let changed = touched(page.Dict) || touched(page.Dict.get('Annots'))
      || touchesGraph(page.Dict.get('Contents')) || inheritsChange(page.Dict, PAGE_INHERITED)
      || PAGE_OWN_ATTRIBUTES.some((key) => touched(page.Dict.get(key)));
    const annots = doc.resolve(page.Dict.get('Annots'));
    const seen = new Set<PdfDict>();
    if (isArray(annots)) for (const raw of annots) {
      const ownChange = touched(raw);
      if (ownChange) changed = true;
      const dict = doc.resolve(raw);
      if (!isDict(dict) || seen.has(dict)) continue;
      seen.add(dict);
      const subtype = subtypeOf(dict);
      const widget = subtype === 'Widget';
      if (widget) attachedWidgets.add(dict);
      const owner = owners.get(dict);
      if (owner?.changed) changed = true;
      if (!ownChange && !annotationChanged(dict, widget)) continue;
      changed = true;
      const entry: UnsignedAnnotationChange = { page: page.Number, subtype };
      if (isRef(raw)) entry.object = raw.num;
      if (owner?.name) { entry.field = owner.name; fields.add(owner.name); }
      (widget ? result.widgets : result.annotations).push(entry);
    }
    if (changed) result.pages.push(page.Number);
  }

  const detached = new Map<PdfDict, UnsignedAnnotationChange>();
  for (const [widget, owner] of owners) {
    if (attachedWidgets.has(widget) || (!touched(widget) && !annotationChanged(widget, true))) continue;
    const entry: UnsignedAnnotationChange = { subtype: 'Widget' };
    if (owner.name) { entry.field = owner.name; fields.add(owner.name); }
    detached.set(widget, entry);
    result.widgets.push(entry);
  }
  if (detached.size) for (const [ref, value] of doc.objectEntries()) {
    const entry = isDict(value) ? detached.get(value) : undefined;
    if (entry) entry.object = ref.num;
  }
  result.fields = [...fields].sort();
  return result;
}
