import { PdfParseError, rethrowLimit } from './errors.js';
import type { FieldType } from './formfield.js';
import type { FormData, FormDataField } from './formdata.js';

/** The field types a JSON entry may state. `pushbutton`, `signature` and
 *  `unknown` are absent: none carries a value, and the export never writes one. */
const JSON_TYPES: ReadonlySet<string> = new Set<FieldType>(['text', 'checkbox', 'radio', 'choice']);

/** Serialize form data as JSON (2srz.1). Unlike FDF and XFDF the format has
 *  types, so each field carries its TYPED value -- a checkbox a boolean, a
 *  radio group its export, a multi-select choice an array -- beside its type
 *  and, where it offers any, its options. `indent` is `JSON.stringify`'s. */
export function writeFormJson(data: FormData, indent?: number): string {
  const fields = data.fields.map((f) => {
    const o: Record<string, unknown> = { name: f.name, type: f.type, value: f.value ?? f.values[0] ?? '' };
    if (f.options !== undefined) o.options = f.options;
    if (f.richText !== undefined) o.richText = f.richText;
    return o;
  });
  const root: Record<string, unknown> = {};
  if (data.file !== undefined) root.file = data.file;
  if (data.id !== undefined) root.id = data.id;
  root.fields = fields;
  return JSON.stringify(root, null, indent);
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(msg: string): never {
  throw new PdfParseError(`form JSON: ${msg}`);
}

/** One entry's value, checked for KIND only: whether the field accepts it is
 *  the `Field.Value` setter's question, answered per field at import. */
function readValue(v: unknown, where: string): string | string[] | boolean {
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && v.every((e) => typeof e === 'string')) return v as string[];
  return fail(`${where}: "value" must be a string, a boolean or an array of strings`);
}

/** Parse form JSON into the format-neutral model. The STRUCTURE is checked in
 *  full before anything is returned, so a malformed file is refused whole and
 *  no field of it reaches the document. */
export function readFormJson(src: string | Uint8Array): FormData {
  let text = typeof src === 'string' ? src : new TextDecoder().decode(src);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (caught) { rethrowLimit(caught);
    return fail(`not valid JSON (${(caught as Error).message})`);
  }
  if (!isPlain(root)) fail('the root must be an object');
  if (!Array.isArray(root.fields)) fail('"fields" must be an array');

  const data: FormData = { fields: [] };
  if (root.file !== undefined) {
    if (typeof root.file !== 'string') fail('"file" must be a string');
    data.file = root.file;
  }
  if (root.id !== undefined) {
    const id = root.id;
    if (!Array.isArray(id) || id.length !== 2 || !id.every((e) => typeof e === 'string'))
      fail('"id" must be an array of two strings');
    data.id = [id[0] as string, id[1] as string];
  }

  root.fields.forEach((e, i) => {
    const where = `fields[${i}]`;
    if (!isPlain(e)) fail(`${where} must be an object`);
    if (typeof e.name !== 'string' || e.name === '') fail(`${where}: "name" must be a non-empty string`);
    let type: FieldType = 'unknown';
    if (e.type !== undefined) {
      if (typeof e.type !== 'string' || !JSON_TYPES.has(e.type))
        fail(`${where}: "type" must be one of text, checkbox, radio, choice`);
      type = e.type as FieldType;
    }
    if (!('value' in e)) fail(`${where}: "value" is missing`);
    const value = readValue(e.value, where);
    const entry: FormDataField = {
      name: e.name, type, value,
      values: typeof value === 'boolean' ? [] : Array.isArray(value) ? value : [value],
    };
    if (e.richText !== undefined) {
      if (typeof e.richText !== 'string') fail(`${where}: "richText" must be a string`);
      entry.richText = e.richText;
    }
    // `options` describes the source form; the target's own options decide.
    data.fields.push(entry);
  });
  return data;
}
