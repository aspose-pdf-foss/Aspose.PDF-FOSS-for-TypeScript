import { PdfParseError } from './errors.js';
import { parseXml, writeXml, XmlNode } from './xml.js';
import type { FormData, FormDataField, SkippedAnnot } from './formdata.js';
import { readAnnots, writeAnnots } from './xfdfannot.js';

const XFDF_NS = 'http://ns.adobe.com/xfdf/';

const el = (name: string, attrs: Record<string, string> = {}): XmlNode =>
  ({ name, attrs: new Map(Object.entries(attrs)), children: [], text: '', nodes: [] });

/** Find or create the `<field name="seg">` child of `parent`. */
function fieldChild(parent: XmlNode, seg: string): XmlNode {
  for (const c of parent.children)
    if (c.name === 'field' && c.attrs.get('name') === seg) return c;
  const made = el('field', { name: seg });
  parent.children.push(made);
  return made;
}

/** Serialize form data as an XFDF document. */
export function writeXfdf(data: FormData): Uint8Array {
  const root = el('xfdf', { xmlns: XFDF_NS });
  if (data.file !== undefined) root.children.push(el('f', { href: data.file }));
  if (data.id !== undefined)
    root.children.push(el('ids', { original: data.id[0], modified: data.id[1] }));

  const fields = el('fields');
  for (const f of data.fields) {
    let target = fields;
    for (const seg of f.name.split('.')) target = fieldChild(target, seg);
    for (const v of f.values) {
      const value = el('value');
      value.text = v;
      target.children.push(value);
    }
    if (f.richText !== undefined) {
      const rt = el('value-richtext');
      rt.raw = f.richText; // markup, emitted verbatim
      target.children.push(rt);
    }
  }
  root.children.push(fields);
  if (data.annots !== undefined && data.annots.length > 0)
    root.children.push(writeAnnots(data.annots));
  return new TextEncoder().encode(writeXml(root));
}

/** Walk nested <field> elements, emitting an entry for each one that has a
 *  value. Elements that only nest children are containers, not fields. */
function walkFields(node: XmlNode, path: string, out: FormDataField[]): void {
  for (const child of node.children) {
    if (child.name !== 'field') continue;
    const seg = child.attrs.get('name') ?? '';
    const full = path === '' ? seg : `${path}.${seg}`;
    const values: string[] = [];
    let richText: string | undefined;
    for (const c of child.children) {
      if (c.name === 'value') values.push(c.text);
      else if (c.name === 'value-richtext') richText = c.raw ?? c.text;
    }
    if (values.length > 0 || richText !== undefined) {
      const entry: FormDataField = { name: full, type: 'unknown', values };
      if (richText !== undefined) entry.richText = richText;
      out.push(entry);
    }
    walkFields(child, full, out);
  }
}

/** Parse an XFDF document into the format-neutral model. */
export function readXfdf(bytes: Uint8Array): FormData {
  const root = parseXml(bytes);
  if (root.name !== 'xfdf')
    throw new PdfParseError(`XFDF: root element is <${root.name}>, expected <xfdf>`);

  const data: FormData = { fields: [] };
  const f = root.children.find((c) => c.name === 'f');
  const href = f?.attrs.get('href');
  if (href !== undefined) data.file = href;

  const ids = root.children.find((c) => c.name === 'ids');
  const orig = ids?.attrs.get('original');
  const mod = ids?.attrs.get('modified');
  if (orig !== undefined && mod !== undefined) data.id = [orig, mod];

  const fields = root.children.find((c) => c.name === 'fields');
  if (fields !== undefined) walkFields(fields, '', data.fields);

  const annotSkips: SkippedAnnot[] = [];
  const annots = readAnnots(root, annotSkips);
  if (annots.length > 0) data.annots = annots;
  if (annotSkips.length > 0) data.annotSkips = annotSkips;
  return data;
}
