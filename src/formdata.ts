import type { Document } from './document.js';
import type { Field, FieldType } from './form.js';
import { readRichTextValue, widgetOnState } from './formfield.js';
import { parseOptions, type ChoiceOption } from './choiceopt.js';
import { applyAnnots, collectAnnots, type AnnotData } from './annotdata.js';
import { isArray, isDict, isString } from './types.js';
import { encodePdfText } from './metadata.js';
import { rethrowLimit } from './errors.js';

/** One field's data, format-neutral. Values are always strings — XFDF has no
 *  boolean type, so a checkbox travels as its appearance-state name. */
export interface FormDataField {
  /** Fully-qualified field name, segments joined with '.'. */
  name: string;
  /** Source field type; 'unknown' on the import path, where the format
   *  modules cannot know it and applyFormData resolves it from the form. */
  type: FieldType;
  /** Length > 1 only for multi-select choice. */
  values: string[];
  /** Verbatim XHTML from /RV, when present. */
  richText?: string;
  /** The field's TYPED value, as `Field.Value` reads and writes it: a checkbox
   *  is a boolean and a radio group its export rather than its appearance
   *  state. Only JSON carries it (2srz.1); when present, import hands it to the
   *  setter as is and `values` is not consulted. */
  value?: string | string[] | boolean;
  /** What the field offers: a choice field's `/Opt` entries, a button's
   *  exports. Exported for the reader of the data; import ignores it. */
  options?: ChoiceOption[];
}

export interface FormData {
  fields: FormDataField[];
  /** /F — the file the data was exported from. */
  file?: string;
  /** The originating document's trailer /ID pair, hex-encoded. */
  id?: [string, string];
  /** Annotations carried by the data file, when it has any. */
  annots?: AnnotData[];
  /** Annotations the format module could not read. Surfaced on ImportReport. */
  annotSkips?: SkippedAnnot[];
}

export interface ExportFormDataOptions {
  /** Emit fields whose value is empty or Off. Default false. */
  includeEmpty?: boolean;
  /** Value for the /F source-file reference. Omitted when absent. */
  file?: string;
  /** Include annotations. Default false. */
  annotations?: boolean;
}

/** Options for `ExportJson`: the FDF/XFDF options minus `annotations`, which
 *  the JSON format does not carry, plus the indentation. */
export interface ExportJsonOptions {
  /** Emit fields whose value is empty, unchecked or Off. Default false. */
  includeEmpty?: boolean;
  /** The source-file reference written as `file`. Omitted when absent. */
  file?: string;
  /** Spaces to indent by, as `JSON.stringify` takes them. Default: none. */
  indent?: number;
}

/** Options for the four import methods. */
export interface ImportOptions {
  /** Apply annotations from the data file. Default false. */
  annotations?: boolean;
}

/** An annotation that was applied to the document. */
export interface ImportedAnnot {
  /** 0-based page index the annotation landed on. */
  page: number;
  subtype: string;
  /** /NM, when the annotation carries one. */
  name?: string;
}

/** An annotation that was present in the data file but not applied. */
export interface SkippedAnnot {
  page?: number;
  subtype?: string;
  reason: string;
}

export interface ImportReport {
  /** Fully-qualified names of fields that were set. */
  imported: string[];
  /** Fields present in the data file that were not applied. */
  skipped: { name: string; reason: string }[];
  /** /F from the data file, when present. */
  sourceFile?: string;
  /** /ID from the data file, when present. */
  sourceId?: [string, string];
  /** Annotations applied. Empty unless the import asked for annotations. */
  importedAnnots: ImportedAnnot[];
  /** Annotations present in the data file that were not applied. */
  skippedAnnots: SkippedAnnot[];
}

/** The field types that carry an exportable, settable value. */
export const SETTABLE: ReadonlySet<FieldType> =
  new Set<FieldType>(['text', 'checkbox', 'radio', 'choice']);

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The document's trailer /ID as a hex pair, or undefined. */
function readDocId(doc: Document): [string, string] | undefined {
  const id = doc.resolve(doc.trailer.get('ID'));
  if (!isArray(id) || id.length < 2) return undefined;
  const a = doc.resolve(id[0]);
  const b = doc.resolve(id[1]);
  if (!isString(a) || !isString(b)) return undefined;
  return [hex(a.bytes), hex(b.bytes)];
}

/** A checked checkbox exports as its widget's on-state NAME -- not its
 *  `Options` entry, which is the /Opt export since 164g.39: FDF and XFDF carry
 *  a button's appearance state. */
function checkedState(doc: Document, field: Field): string {
  for (const w of field.Widgets) {
    const s = widgetOnState(doc, w);
    if (s !== undefined) return s;
  }
  return 'Yes';
}

/** True when the value carries no information: empty text/choice, or Off. */
function isEmpty(values: string[]): boolean {
  return values.length === 0 || (values.length === 1 && (values[0] === '' || values[0] === 'Off'));
}

/** What a field offers, as the JSON export spells it: a choice field's `/Opt`
 *  as `ChoiceOption`s (a bare string where there is no display half), a
 *  button's exports. Undefined when the field offers nothing. */
function optionsOf(doc: Document, field: Field): ChoiceOption[] | undefined {
  const out: ChoiceOption[] = field.Type === 'choice'
    ? parseOptions(doc, field.Dict).map((o) => (o.display === undefined ? o.export : { export: o.export, display: o.display }))
    : field.Options;
  return out.length > 0 ? out : undefined;
}

/** Read the document's form into the format-neutral model. `typed` also
 *  fills `value` and `options`, which only the JSON format carries -- left
 *  off, FDF and XFDF see exactly the model they always did. */
export function collectFormData(
  doc: Document, opts: ExportFormDataOptions = {}, typed = false,
): FormData {
  const fields: FormDataField[] = [];
  for (const f of doc.Form.Fields) {
    if (!SETTABLE.has(f.Type)) continue; // signature, pushbutton, unknown
    // 164g.39: a radio group travels as its STATE name, which is what `Value`
    // no longer answers once /Opt names an export.
    const v = f.Type === 'radio' ? f.radioState() : f.Value;
    const values = typeof v === 'boolean' ? [v ? checkedState(doc, f) : 'Off']
      : Array.isArray(v) ? v
      : [v];
    if (isEmpty(values) && !opts.includeEmpty) continue;
    const entry: FormDataField = { name: f.FullName, type: f.Type, values };
    const rv = readRichTextValue(doc, f.Dict);
    if (rv !== undefined) entry.richText = rv;
    if (typed) {
      // `v` is a radio group's STATE (above); the typed value is its export.
      entry.value = f.Type === 'radio' ? f.Value : v;
      const options = optionsOf(doc, f);
      if (options !== undefined) entry.options = options;
    }
    fields.push(entry);
  }

  const out: FormData = { fields };
  if (opts.file !== undefined) out.file = opts.file;
  const id = readDocId(doc);
  if (id !== undefined) out.id = id;
  if (opts.annotations) {
    const annots = collectAnnots(doc);
    if (annots.length > 0) out.annots = annots;
  }
  return out;
}

/** True when the catalog has an /AcroForm dictionary at all. */
export function hasAcroForm(doc: Document): boolean {
  return isDict(doc.resolve(doc.catalog().get('AcroForm')));
}

/** The typed value to hand the Field.Value setter, given the live field type. */
function typedValue(type: FieldType, values: string[]): string | string[] | boolean {
  switch (type) {
    case 'checkbox':
      // An absent or empty value is unchecked, not checked.
      return values.length > 0 && values[0] !== 'Off' && values[0] !== '';
    case 'choice':
      // More than one value means multi-select; the setter rejects an array
      // against a single-select field, which becomes a skip.
      return values.length > 1 ? values : values[0] ?? '';
    default:
      return values[0] ?? '';
  }
}

/** Apply form data to the document, reporting what landed and what did not.
 *  Values go through the Field.Value setter, which validates before mutating
 *  and regenerates appearance streams, so a rejected field leaves the
 *  document untouched. */
export function applyFormData(
  doc: Document, data: FormData, opts: ImportOptions = {},
): ImportReport {
  const report: ImportReport = { imported: [], skipped: [], importedAnnots: [], skippedAnnots: [] };
  if (data.file !== undefined) report.sourceFile = data.file;
  if (data.id !== undefined) report.sourceId = data.id;

  if (!hasAcroForm(doc)) {
    for (const e of data.fields) report.skipped.push({ name: e.name, reason: 'document has no form' });
  } else {
    const form = doc.Form;
    for (const e of data.fields) {
      const field = form.Get(e.name);
      if (field === undefined) {
        report.skipped.push({ name: e.name, reason: 'no such field' });
        continue;
      }
      if (!SETTABLE.has(field.Type)) {
        report.skipped.push({ name: e.name, reason: 'field type is not settable' });
        continue;
      }
      // A format that states the type (JSON) is checked against the form: data
      // for a different field of the same name must not be coerced into it.
      if (e.type !== 'unknown' && e.type !== field.Type) {
        report.skipped.push({ name: e.name, reason: `field is ${field.Type}, data is ${e.type}` });
        continue;
      }
      try {
        if (e.value !== undefined) {
          field.Value = e.value;
        } else {
          // 164g.39: a radio's data is a STATE; `Value` takes the export it stands for.
          const typed = typedValue(field.Type, e.values);
          field.Value = field.Type === 'radio' && typeof typed === 'string' ? field.radioValueOfState(typed) : typed;
        }
      } catch (err) { rethrowLimit(err);
        report.skipped.push({ name: e.name, reason: (err as Error).message });
        continue;
      }
      if (e.richText !== undefined)
        field.Dict.set('RV', { kind: 'string', bytes: encodePdfText(e.richText) });
      report.imported.push(e.name);
    }
  }

  // Annotations do not depend on the form: a document can legitimately carry
  // annotations and no AcroForm at all, so this sits outside the branch above.
  if (data.annotSkips !== undefined) report.skippedAnnots.push(...data.annotSkips);
  if (opts.annotations && data.annots !== undefined) applyAnnots(doc, data.annots, report);
  return report;
}
