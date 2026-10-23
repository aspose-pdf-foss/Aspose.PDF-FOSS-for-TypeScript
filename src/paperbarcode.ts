// Paper forms barcodes (2srz.4): a text field that draws as a 2D barcode of
// the form's data. This module holds the Document: creating such a field and
// refreshing its content. The /PMD dictionary and Acrobat's script are
// pmd.ts's, the symbol and its geometry barcodemodel.ts's, and drawing it
// appearance.ts's, where every path that redraws a field passes.
import type { Document } from './document.js';
import { isArray, isDict, isName, isString, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { rethrowLimit } from './errors.js';
import type { MatrixBarcode } from './barcode.js';
import { readFieldMdpLock, isLocked } from './siglock.js';
import { readDocMdpLevel } from './docmdp.js';
import { collectFormData } from './formdata.js';
import { writeFormJson } from './formjson.js';
import { createField, type FieldInit } from './formcreate.js';
import { ChoiceField, TextField, type Field } from './formfield.js';
import { parseOptions } from './choiceopt.js';
import { barcodeWidgetStream, drawBarcodeAppearance, matrixFor, widgetGeom, widgetsOf } from './appearance.js';
import { placementMatrix, type Matrix } from './text.js';
import type { AnnotAppearance } from './annotappearance.js';
import { barcodeModel } from './barcodemodel.js';
import type { QrEcc } from './qr.js';
import { buildTabScript, encodePmd, joinTabDelimited, parseBarcodeScript, readPmd, type PaperMetadata } from './pmd.js';

/** Options for Form.AddBarcodeField / Page.AddBarcodeField. */
export interface BarcodeFieldInit extends FieldInit {
  /** Default 'pdf417', the symbology Acrobat defaults to. */
  symbology?: 'pdf417' | 'datamatrix' | 'qr';
  /** PDF417 error-correction level 0..8 (/PMD /ECC). Default: by data length. */
  ecLevel?: number;
  /** PDF417 data columns 1..30 (/PMD /nCodeWordCol). */
  columns?: number;
  /** QR error-correction level (/PMD /ECC 0..3). Default 'M'. */
  ecc?: QrEcc;
  /** What the barcode holds. 'tab' (default): Acrobat's tab-delimited form
   *  data, with Acrobat's own calculation script, so Acrobat Pro recomputes
   *  it too. 'json': `doc.ExportJson` of the carried fields -- no script, so
   *  only this library keeps it current. 'value': the field's own value. */
  encoding?: 'tab' | 'json' | 'value';
  /** The fields carried ('tab', 'json'). Default every field that exists now
   *  except signature fields, push buttons and other barcode fields; a field
   *  added later is not carried, as in Acrobat. */
  fields?: readonly string[];
  /** 'tab' only: a header row of field names first. Default false. */
  fieldNames?: boolean;
  /** Flate-compress the content inside the symbol (/PMD /DataPrep 1). */
  compress?: boolean;
  /** 'value' only: the initial value. */
  value?: string;
}

const QR_ECC: readonly QrEcc[] = ['L', 'M', 'Q', 'H'];

export { drawBarcodeAppearance };

function checkInit(doc: Document, init: BarcodeFieldInit): { pmd: PaperMetadata; encoding: 'tab' | 'json' | 'value'; fields: string[] } {
  const symbology = init.symbology ?? 'pdf417';
  if (symbology !== 'pdf417' && symbology !== 'datamatrix' && symbology !== 'qr')
    throw new RangeError(`symbology must be 'pdf417', 'datamatrix' or 'qr'`);
  const encoding = init.encoding ?? 'tab';
  if (encoding !== 'tab' && encoding !== 'json' && encoding !== 'value')
    throw new RangeError(`encoding must be 'tab', 'json' or 'value'`);
  if (init.compress !== undefined && typeof init.compress !== 'boolean') throw new TypeError('compress must be a boolean');
  if (init.fieldNames !== undefined && typeof init.fieldNames !== 'boolean') throw new TypeError('fieldNames must be a boolean');
  if (init.fieldNames && encoding !== 'tab') throw new RangeError("fieldNames applies to encoding 'tab' only");
  if (init.value !== undefined && encoding !== 'value') throw new RangeError("value applies to encoding 'value' only");
  if (init.value !== undefined && typeof init.value !== 'string') throw new TypeError('value must be a string');
  if (init.fields !== undefined && encoding === 'value') throw new RangeError("fields does not apply to encoding 'value'");
  if (init.ecc !== undefined && symbology !== 'qr') throw new RangeError("ecc applies to symbology 'qr'; PDF417 takes ecLevel");
  if ((init.ecLevel !== undefined || init.columns !== undefined) && symbology !== 'pdf417')
    throw new RangeError("ecLevel and columns apply to symbology 'pdf417'");
  if (init.columns !== undefined && !(Number.isInteger(init.columns) && init.columns >= 1 && init.columns <= 30))
    throw new RangeError('columns must be an integer 1..30');
  let ecc: number | undefined;
  if (symbology === 'qr' && init.ecc !== undefined) {
    ecc = QR_ECC.indexOf(init.ecc);
    if (ecc < 0) throw new RangeError("ecc must be 'L', 'M', 'Q' or 'H'");
  } else if (symbology === 'pdf417') ecc = init.ecLevel;
  const pmd: PaperMetadata = {
    symbology: symbology === 'pdf417' ? 'PDF417' : symbology === 'qr' ? 'QRCode' : 'DataMatrix',
    ...(ecc === undefined ? {} : { ecc }),
    ...(init.columns === undefined ? {} : { nCodeWordCol: init.columns }),
    dataPrep: init.compress ? 1 : 0,
  };
  encodePmd(pmd); // validates ecLevel's range
  const all = doc.Form.Fields;
  const existing = new Set(all.map((f) => f.FullName));
  // The default carries the fields a reader of the form fills in: not a
  // signature field (its value is no probed shape, so it would stop every
  // refresh), not a push button (the script skips one anyway), and not another
  // paper barcode (a second barcode of one form would hold the first's content
  // beside the data). A list the caller states is taken as stated.
  const fields = init.fields === undefined
    ? all.filter((f) => f.Type !== 'signature' && f.Type !== 'pushbutton' && !f.Dict.has('PMD')).map((f) => f.FullName)
    : [...init.fields];
  for (const f of fields) {
    if (typeof f !== 'string') throw new TypeError('fields must be strings');
    if (init.fields !== undefined && !existing.has(f)) throw new RangeError(`no field named '${f}'`);
  }
  return { pmd, encoding, fields };
}

/** Create a barcode field. Validates everything before allocating, so a
 *  rejected call leaves the document byte-identical. */
export function addBarcodeField(doc: Document, init: BarcodeFieldInit): TextField {
  const { pmd, encoding, fields } = checkInit(doc, init);
  const value = encoding === 'value' ? init.value ?? '' : '';
  const model = barcodeModel(value, pmd); // a value too large for the symbol throws here, before anything exists

  const actions = encoding === 'tab'
    ? { ...init.actions, calculate: { type: 'javascript' as const, script: buildTabScript({ fields, fieldNames: init.fieldNames ?? false }) } }
    : init.actions;
  const c = createField(doc, { ...init, actions }, {
    ft: 'Tx',
    entries: [
      ['V', { kind: 'string', bytes: encodePdfText(value) }], ['PMD', encodePmd(pmd)],
      ...(encoding === 'json' ? [[JSON_KEY, fields.map(pdfText)] as [string, PdfObject]] : []),
    ],
    buildAP: (d, dict) => drawBarcodeAppearance(d, dict, pmd, value, model),
  });
  if (encoding === 'tab') appendCalculationOrder(doc, c.acro, c.dict);
  return new TextField(doc, c.acro, c.dict, c.partial, c.fullName, 'text', c.ff, null);
}

/** Append the field to /AcroForm /CO: Acrobat runs a calculate script only for
 *  a field listed there. */
function appendCalculationOrder(doc: Document, acro: PdfDict, dict: PdfDict): void {
  const ref = refOf(doc, dict);
  if (ref === undefined) return;
  const co = doc.resolve(acro.get('CO'));
  if (isArray(co)) co.push(ref);
  else acro.set('CO', [ref]);
}

function refOf(doc: Document, dict: PdfDict): PdfRef | undefined {
  for (const [ref, obj] of doc.objectEntries()) if (obj === dict) return ref;
  return undefined;
}

const pdfText = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** The field-dict key naming the fields a `json` barcode carries. Acrobat has
 *  no JSON encoding and writes no script for one, so without this key a json
 *  barcode reopened later is indistinguishable from a `value` one. */
const JSON_KEY = 'JSONBarcode';

// --- Refresh ----------------------------------------------------------------------

/** Why a barcode's content was not recomputed. */
export type BarcodeSkipReason = 'xml-encoding' | 'unrecognised-script' | 'locked' | 'unprobed-value' | 'too-large';

/** What `Form.RefreshBarcodes()` did. */
export interface BarcodeRefreshReport {
  /** Barcode fields whose content or appearance was rewritten. */
  readonly updated: readonly string[];
  /** Barcode fields left as they were, and why. `detail` names the carried
   *  field an `unprobed-value` stopped at. */
  readonly notRecomputed: readonly { field: string; reason: BarcodeSkipReason; detail?: string }[];
}

/** A value Acrobat's script reads as a NUMBER, and so prints as one: an
 *  optional sign, digits, and an optional fraction with digits after the point
 *  -- or the fraction alone. Settled by the Reader probes `numbers`,
 *  `numbers2` and `misc`: `1.`, `1e-7`, `0x1F`, `Infinity` and ` 42 ` are not
 *  numbers; `+5`, `-.5`, `00` and `0.0000001` are. */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const asAcrobat = (s: string): string => (NUMERIC.test(s) ? String(Number(s)) : s);

/** What `+=` of Acrobat's `field.value` appends for `field`, or undefined for
 *  a shape no probe settled. Probe names cite test/fixtures/paper-barcode. */
export function acrobatFieldValue(doc: Document, field: Field): string | undefined {
  const raw = doc.resolve(field.Dict.get('V'));
  switch (field.Type) {
    case 'text': {
      if (field instanceof TextField && (field.RichText || field.FileSelect)) return undefined; // unprobed
      // `format`: a format script does not change the value. `misc`: a
      // password contributes its plaintext; a comb is ordinary text.
      return asAcrobat(isString(raw) ? decodePdfText(raw.bytes) : '');
    }
    case 'checkbox': // `buttons`, `misc`: the export name, or Off
      // With /Opt the state name is an index (164g.39) and `value` answers
      // the export, as `Field.Value` does: unprobed, as for a radio group.
      if (field.Dict.has('Opt')) return undefined;
      return asAcrobat(isName(raw) ? raw.name : 'Off');
    case 'radio': { // `buttons`, `misc`: the selected export, or Off
      if (field.Dict.has('Opt')) return undefined; // exports in /Opt: unprobed
      const v = field.Value;
      return asAcrobat(typeof v === 'string' && v !== '' && v !== 'Off' ? v : 'Off');
    }
    case 'choice':
      // Unprobed: a display that differs from its export (which one does
      // `value` answer?), and a multi-select list holding ONE selection as a
      // string rather than an array.
      if (parseOptions(doc, field.Dict).some((o) => o.display !== undefined)) return undefined;
      if (field instanceof ChoiceField && field.MultiSelect && !isArray(raw) && raw !== null) return undefined;
      // `choices`, `numbers2`: a selection stored as an array joins its items
      // raw with commas (Array.toString); a single one is a value like text.
      if (isArray(raw)) {
        const items = raw.map((o) => doc.resolve(o));
        if (!items.every(isString)) return undefined;
        return items.map((s) => decodePdfText(s.bytes)).join(',');
      }
      return asAcrobat(isString(raw) ? decodePdfText(raw.bytes) : '');
    default:
      return undefined; // signature, unknown: unprobed
  }
}

/** Fold line breaks as Acrobat does when a script sets a field's value:
 *  `multiline`, every break (CRLF, CR, LF) becomes CR; otherwise each becomes
 *  one space. Probes `header`, `linebreaks`, `multiline`. */
const foldBreaks = (s: string, multiline: boolean): string => s.replace(/\r\n|\r|\n/g, multiline ? '\r' : ' ');

/** Is `fullName` frozen by a signature in `doc`: a field lock naming it, a
 *  lock imposing no-changes, or a no-changes certification. */
function lockedBySignature(doc: Document, fullName: string): boolean {
  const resolve = (o: PdfObject | undefined) => doc.resolve(o ?? null);
  for (const sig of doc.Signatures) {
    if (!sig.isSigned) continue;
    const lock = readFieldMdpLock(sig.valueDict, resolve);
    if (lock !== undefined && (isLocked(lock, fullName) || lock.permissions === 'no-changes')) return true;
    if (readDocMdpLevel(sig.valueDict, resolve) === 1) return true;
  }
  return false;
}

type Skip = { field: string; reason: BarcodeSkipReason; detail?: string };

/** What a refresh would do for one barcode field, decided WITHOUT writing
 *  anything, so the refresh and a render (which must not mutate) cannot
 *  disagree about it. `redraw` is set when the refresh would install `content`. */
interface BarcodeState {
  readonly field: Field;
  readonly pmd: PaperMetadata;
  readonly current: string;
  readonly skips: readonly Skip[];
  readonly redraw?: { readonly content: string; readonly model: MatrixBarcode | undefined };
}

/** Does any object carry a /PMD key. A cheap scan, so a document with no paper
 *  barcode never builds its field tree on Save -- a tree deeper than
 *  `maxNestingDepth` would refuse a Save that has nothing to refresh. */
function hasPaperBarcode(doc: Document): boolean {
  if (!doc.catalog().has('AcroForm')) return false;
  for (const [, o] of doc.objectEntries()) if (isDict(o) && o.has('PMD')) return true;
  return false;
}

/** The content each barcode should hold, and what a refresh would write. */
function barcodeStates(doc: Document): BarcodeState[] {
  if (!hasPaperBarcode(doc)) return [];
  const out: BarcodeState[] = [];
  const fields = doc.Form.Fields;
  let sorted: Field[] | undefined; // built on first use: most forms carry no tab barcode
  for (const f of fields) {
    if (f.Type !== 'text') continue;
    const pmdDict = doc.resolve(f.Dict.get('PMD'));
    const pmd = isDict(pmdDict) ? readPmd(pmdDict, (o) => doc.resolve(o)) : undefined;
    if (pmd === undefined) continue;
    const raw = doc.resolve(f.Dict.get('V'));
    const current = isString(raw) ? decodePdfText(raw.bytes) : '';
    const skips: Skip[] = [];
    const skip = (reason: BarcodeSkipReason, detail?: string) =>
      skips.push({ field: f.FullName, reason, ...(detail === undefined ? {} : { detail }) });

    let content = current;
    const calc = f.Actions.calculate;
    const jsonFields = doc.resolve(f.Dict.get(JSON_KEY));
    if (calc !== undefined && calc.type === 'javascript') {
      const parsed = parseBarcodeScript(calc.script);
      if (parsed === undefined) { skip('unrecognised-script'); }
      else if (parsed.encoding === 'xml') { skip('xml-encoding'); }
      else {
        const { fields: carried, fieldNames, exclude } = parsed.params;
        const carriedSet = carried === null ? null : new Set(carried);
        sorted ??= [...fields].sort((a, b) => (a.FullName < b.FullName ? -1 : a.FullName > b.FullName ? 1 : 0));
        const entries: { name: string; value: string }[] = [];
        let unprobed: string | undefined;
        for (const g of sorted) {
          if (carriedSet !== null && !carriedSet.has(g.FullName)) continue;
          // The barcode never carries itself: under `aFields: null` with no
          // `strXclField` the script reads its own previous value, so the
          // content would grow on every refresh until it no longer fit.
          if (g.Dict === f.Dict || g.FullName === exclude || g.Type === 'pushbutton') continue;
          const v = acrobatFieldValue(doc, g);
          if (v === undefined) { unprobed = g.FullName; break; }
          entries.push({ name: g.FullName, value: v });
        }
        if (unprobed !== undefined) skip('unprobed-value', unprobed);
        else content = foldBreaks(joinTabDelimited(entries, fieldNames), f instanceof TextField && f.Multiline);
      }
    } else if (isArray(jsonFields)) {
      const names = new Set(jsonFields.map((o) => doc.resolve(o)).filter(isString).map((s) => decodePdfText(s.bytes)));
      const data = collectFormData(doc, { includeEmpty: true }, true);
      data.fields = data.fields
        .filter((d) => names.has(d.name) && d.name !== f.FullName)
        .map(({ options: _options, ...rest }) => rest);
      content = writeFormJson({ fields: data.fields });
    }

    const drawn = widgetsOf(doc, f.Dict).every((w) => doc.resolve(w.get('AP')) !== null);
    const same = content === current && drawn;
    if (!same && lockedBySignature(doc, f.FullName)) { skip('locked'); out.push({ field: f, pmd, current, skips }); continue; }
    // The symbol is built even when nothing changed: a /V the symbol cannot
    // hold leaves the OLD symbol drawn, and that must be reported, not taken
    // for a barcode that is current.
    let model: MatrixBarcode | undefined;
    try { model = barcodeModel(content, pmd); } catch (caught) {
      rethrowLimit(caught);
      if (!(caught instanceof RangeError)) throw caught;
      skip('too-large');
      out.push({ field: f, pmd, current, skips });
      continue;
    }
    out.push({ field: f, pmd, current, skips, ...(same ? {} : { redraw: { content, model } }) });
  }
  return out;
}

/** Recompute every barcode field's content and redraw what changed. Touches
 *  nothing -- no write, no markModified -- for a barcode whose content already
 *  matches and whose widgets are all drawn. */
export function refreshBarcodeFields(doc: Document): BarcodeRefreshReport {
  const updated: string[] = [];
  const notRecomputed: Skip[] = [];
  for (const s of barcodeStates(doc)) {
    notRecomputed.push(...s.skips);
    if (s.redraw === undefined) continue;
    const { content, model } = s.redraw;
    if (content !== s.current) s.field.Dict.set('V', pdfText(content));
    drawBarcodeAppearance(doc, s.field.Dict, s.pmd, content, model);
    doc.markModified();
    updated.push(s.field.FullName);
  }
  notRecomputed.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return { updated, notRecomputed };
}

/** The appearance a refresh WOULD install for each barcode widget whose
 *  stored one is stale, built inline and never written: a render draws what
 *  `Save` would write without mutating the document (a spurious
 *  `markModified` turns a later Sign into a full rewrite). Keyed by widget
 *  dict; a widget absent from the map draws its stored appearance. */
export function pendingBarcodeAppearances(doc: Document): Map<PdfDict, AnnotAppearance> {
  const out = new Map<PdfDict, AnnotAppearance>();
  for (const s of barcodeStates(doc)) {
    if (s.redraw === undefined) continue;
    for (const w of widgetsOf(doc, s.field.Dict)) {
      const g = widgetGeom(doc, w);
      const rect = doc.resolve(w.get('Rect'));
      if (g === undefined || !isArray(rect)) continue;
      const r = rect.map((o) => doc.resolve(o));
      if (r.length < 4 || !r.slice(0, 4).every((v) => typeof v === 'number')) continue;
      const stream = barcodeWidgetStream(g, s.redraw.model);
      const place = placementMatrix([0, 0, g.w, g.h], matrixFor(g) as Matrix, r.slice(0, 4) as number[]);
      if (place !== undefined) out.set(w, { entry: stream, stream, place });
    }
  }
  return out;
}
