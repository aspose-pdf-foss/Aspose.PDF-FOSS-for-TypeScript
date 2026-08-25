import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isStream, isString, name } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { encodeDest, parseDest, resolvePageDest, type OutlineView } from './outline.js';
import { decodeStream } from './filters.js';

/** A GoTo action: jump to a page in this document. */
export type GoToAction = { type: 'goto'; page: number; view?: OutlineView };
/** A URI action: open an external URL. */
export type UriAction = { type: 'uri'; uri: string };
/** A SubmitForm action: send the form's field values to `url`. */
export type SubmitAction = {
  type: 'submit';
  url: string;
  /** Fully-qualified field names. Omit to submit every field. */
  fields?: string[];
  /** Treat `fields` as an exclusion list (/Flags IncludeExclude). */
  exclude?: boolean;
  /** Wire format. Default 'fdf'. */
  format?: 'fdf' | 'html' | 'xfdf' | 'pdf';
};
/** A ResetForm action: clear the named fields, or every field. */
export type ResetAction = { type: 'reset'; fields?: string[]; exclude?: boolean };
/** A JavaScript action. */
export type JavaScriptAction = { type: 'javascript'; script: string };

/** Any action this library models, for an annotation's /A. */
export type PdfAction =
  GoToAction | UriAction | SubmitAction | ResetAction | JavaScriptAction;

// SubmitForm /Flags, PDF 32000-1 table 237, commented with the 1-based
// specification bit — bit N is 1 << (N - 1), and an off-by-one here silently
// selects a different behaviour rather than failing.
const SUBMIT_INCLUDE_EXCLUDE = 1 << 0; // bit 1
const SUBMIT_EXPORT_FORMAT = 1 << 2;   // bit 3  (HTML)
const SUBMIT_XFDF = 1 << 5;            // bit 6
const SUBMIT_PDF = 1 << 8;             // bit 9
// ResetForm /Flags, table 239.
const RESET_INCLUDE_EXCLUDE = 1 << 0;  // bit 1

function pdfText(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}

function fieldNames(fields: unknown): PdfObject[] | undefined {
  if (fields === undefined) return undefined;
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string'))
    throw new TypeError('action.fields must be an array of strings');
  return fields.map((f) => pdfText(f as string));
}

/** Build the /A dict for `a`. Validates everything before returning, so a
 *  caller that lets this throw has allocated nothing. */
export function encodeAction(doc: Document, a: PdfAction): PdfDict {
  switch (a?.type) {
    case 'goto': {
      const p = a.page;
      if (!Number.isInteger(p) || p < 1 || p > doc.Pages.length)
        throw new RangeError(`action page ${String(p)} out of range 1..${doc.Pages.length}`);
      return new Map<string, PdfObject>([
        ['S', name('GoTo')], ['D', encodeDest(doc.pageRef(p), a.view)],
      ]);
    }
    case 'uri': {
      if (typeof a.uri !== 'string' || a.uri.length === 0)
        throw new TypeError('action.uri must be a non-empty string');
      return new Map<string, PdfObject>([['S', name('URI')], ['URI', pdfText(a.uri)]]);
    }
    case 'submit': {
      if (typeof a.url !== 'string' || a.url.length === 0)
        throw new TypeError('action.url must be a non-empty string');
      const names = fieldNames(a.fields);
      let flags = 0;
      if (a.exclude) flags |= SUBMIT_INCLUDE_EXCLUDE;
      switch (a.format ?? 'fdf') {
        case 'fdf': break;
        case 'html': flags |= SUBMIT_EXPORT_FORMAT; break;
        case 'xfdf': flags |= SUBMIT_XFDF; break;
        case 'pdf': flags |= SUBMIT_PDF; break;
        default: throw new TypeError("action.format must be 'fdf', 'html', 'xfdf' or 'pdf'");
      }
      // A URL needs the /FS /URL file-specification form, not a bare string.
      const fs: PdfDict = new Map<string, PdfObject>([['FS', name('URL')], ['F', pdfText(a.url)]]);
      const d: PdfDict = new Map<string, PdfObject>([['S', name('SubmitForm')], ['F', fs]]);
      if (names) d.set('Fields', names);
      if (flags !== 0) d.set('Flags', flags);
      return d;
    }
    case 'reset': {
      const names = fieldNames(a.fields);
      const d: PdfDict = new Map<string, PdfObject>([['S', name('ResetForm')]]);
      if (names) d.set('Fields', names);
      if (a.exclude) d.set('Flags', RESET_INCLUDE_EXCLUDE);
      return d;
    }
    case 'javascript': {
      if (typeof a.script !== 'string' || a.script.length === 0)
        throw new TypeError('action.script must be a non-empty string');
      return new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', pdfText(a.script)]]);
    }
    default:
      throw new TypeError(
        "action.type must be 'goto', 'uri', 'submit', 'reset' or 'javascript'",
      );
  }
}

function strings(doc: Document, o: PdfObject | undefined): string[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a)) return undefined;
  const out: string[] = [];
  for (const e of a) { const r = doc.resolve(e); if (isString(r)) out.push(decodePdfText(r.bytes)); }
  return out;
}

/** The URL from a SubmitForm /F: a /FS /URL filespec, or a bare string, which
 *  some producers write. */
function urlOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const f = doc.resolve(o);
  if (isString(f)) return decodePdfText(f.bytes);
  if (isDict(f)) {
    const inner = doc.resolve((f as PdfDict).get('F'));
    if (isString(inner)) return decodePdfText(inner.bytes);
  }
  return undefined;
}

/** Parse `annot`'s /A action, or undefined when absent or unmodelled. Takes the
 *  annotation rather than the action dict because a GoTo destination may live
 *  in the annotation's own /Dest. */
export function parseAction(doc: Document, annot: PdfDict): PdfAction | undefined {
  const a = doc.resolve(annot.get('A'));
  if (!isDict(a)) return undefined;
  return parseActionDict(doc, a as PdfDict, annot);
}

/** Parse an action dict that is not an annotation's /A — a field's /AA /F, say.
 *  A GoTo destination then has nowhere to fall back to but the action's own /D,
 *  which the one-key host expresses without giving parseDest a second shape to
 *  understand. */
export function parseStandaloneAction(
  doc: Document, value: PdfObject | undefined,
): PdfAction | undefined {
  const a = doc.resolve(value);
  if (!isDict(a)) return undefined;
  return parseActionDict(doc, a as PdfDict, new Map([['A', a]]));
}

/** The body shared by both: `host` is where a GoTo destination may live besides
 *  the action's own /D. */
function parseActionDict(
  doc: Document, a: PdfDict, annot: PdfDict,
): PdfAction | undefined {
  const s = doc.resolve((a as PdfDict).get('S'));
  if (!isName(s)) return undefined;
  switch (s.name) {
    case 'URI': {
      const u = doc.resolve((a as PdfDict).get('URI'));
      return isString(u) ? { type: 'uri', uri: decodePdfText(u.bytes) } : undefined;
    }
    case 'GoTo': {
      // Resolved here, unlike an outline or link read: the modelled GoTo action
      // carries a page number and has nowhere to put a name, so a dangling name
      // is an unmodelled action rather than a target with no page.
      const pageOf = (o: PdfObject) => doc.pageNumberOf(o);
      const d = resolvePageDest(doc, parseDest(doc, annot, pageOf), pageOf);
      return d ? { type: 'goto', page: d.page, view: d.view } : undefined;
    }
    case 'SubmitForm': {
      const url = urlOf(doc, (a as PdfDict).get('F'));
      if (url === undefined) return undefined;
      const flagsRaw = doc.resolve((a as PdfDict).get('Flags'));
      const flags = typeof flagsRaw === 'number' ? flagsRaw : 0;
      const out: SubmitAction = { type: 'submit', url };
      const names = strings(doc, (a as PdfDict).get('Fields'));
      if (names) out.fields = names;
      if (flags & SUBMIT_INCLUDE_EXCLUDE) out.exclude = true;
      if (flags & SUBMIT_PDF) out.format = 'pdf';
      else if (flags & SUBMIT_XFDF) out.format = 'xfdf';
      else if (flags & SUBMIT_EXPORT_FORMAT) out.format = 'html';
      else out.format = 'fdf';
      return out;
    }
    case 'ResetForm': {
      const out: ResetAction = { type: 'reset' };
      const names = strings(doc, (a as PdfDict).get('Fields'));
      if (names) out.fields = names;
      const flagsRaw = doc.resolve((a as PdfDict).get('Flags'));
      if (typeof flagsRaw === 'number' && (flagsRaw & RESET_INCLUDE_EXCLUDE)) out.exclude = true;
      return out;
    }
    case 'JavaScript': {
      const js = doc.resolve((a as PdfDict).get('JS'));
      if (isString(js)) return { type: 'javascript', script: decodePdfText(js.bytes) };
      // 32000-1 table 217: /JS is a text string OR a text stream. Reading only
      // the string made the whole action vanish, not merely its script — and
      // the stream form is what a producer picks for a large document-level
      // script. Damage costs the action, never the parse: this grammar is one
      // of the layers that ignores what it cannot read.
      if (isStream(js)) {
        try {
          return { type: 'javascript', script: decodePdfText(decodeStream(js)) };
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A field's additional-actions (/AA), PDF 32000-1 table 197. In practice every
 *  one of them is a JavaScript action, but any modelled action encodes.
 *
 *  Distinct from an annotation's /A, which is what *activating* it does: a push
 *  button carries both, and neither key may overwrite the other. */
export interface FieldActions {
  /** /K — fires on each keystroke while the value is being edited. */
  keystroke?: PdfAction;
  /** /F — formats the value for display. */
  format?: PdfAction;
  /** /V — validates the value when it changes. */
  validate?: PdfAction;
  /** /C — recalculates the value when another field changes. */
  calculate?: PdfAction;
}

/** A field-actions update: an action to set, `null` to remove that trigger, and
 *  an absent key to leave it as it is — the same shape `SetStyle` takes. */
export type FieldActionsUpdate = {
  [K in keyof FieldActions]?: FieldActions[K] | null;
};

/** Trigger name to /AA key. The array, rather than a bare object, is what keeps
 *  the write order stable across saves. */
const AA_KEYS: ReadonlyArray<[keyof FieldActions, string]> = [
  ['keystroke', 'K'], ['format', 'F'], ['validate', 'V'], ['calculate', 'C'],
];

/** Read a field's /AA into the typed view. Unmodelled and absent triggers are
 *  simply left out. */
export function parseFieldActions(doc: Document, field: PdfDict): FieldActions {
  const aa = doc.resolve(field.get('AA'));
  const out: FieldActions = {};
  if (!isDict(aa)) return out;
  for (const [prop, key] of AA_KEYS) {
    const a = parseStandaloneAction(doc, (aa as PdfDict).get(key));
    if (a !== undefined) out[prop] = a;
  }
  return out;
}

/** Build the /AA dict for a plain set of triggers, or undefined when none were
 *  given. Validates every action and touches nothing, so a creation path can
 *  call it before it has allocated anything. */
export function encodeFieldActions(doc: Document, a: FieldActions): PdfDict | undefined {
  const aa: PdfDict = new Map<string, PdfObject>();
  for (const [prop, key] of AA_KEYS) {
    const act = a[prop];
    if (act !== undefined) aa.set(key, encodeAction(doc, act));
  }
  return aa.size > 0 ? aa : undefined;
}

/** Apply an update to a field's /AA.
 *
 *  Every action is encoded before the first write, so a rejected trigger leaves
 *  the field untouched — the invariant creation and SetStyle both hold.
 *
 *  Only the four named keys are touched. A merged field/widget dict shares one
 *  /AA with the annotation's own triggers (/E, /X, …), so rewriting it whole
 *  would silently drop them; by the same token /AA is removed only once nothing
 *  at all is left in it. */
export function applyFieldActions(
  doc: Document, field: PdfDict, update: FieldActionsUpdate,
): void {
  const writes: Array<[string, PdfDict | null]> = [];
  for (const [prop, key] of AA_KEYS) {
    const a = update[prop];
    if (a === undefined) continue;
    writes.push([key, a === null ? null : encodeAction(doc, a)]);
  }
  if (writes.length === 0) return;

  let aa = doc.resolve(field.get('AA'));
  if (!isDict(aa)) {
    if (writes.every(([, v]) => v === null)) return;  // nothing to delete from
    aa = new Map<string, PdfObject>();
    field.set('AA', aa);
  }
  for (const [key, v] of writes) {
    if (v === null) (aa as PdfDict).delete(key);
    else (aa as PdfDict).set(key, v);
  }
  if ((aa as PdfDict).size === 0) field.delete('AA');
}
