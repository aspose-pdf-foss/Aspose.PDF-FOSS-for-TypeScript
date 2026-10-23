import { PdfParseError, rethrowLimit } from './errors.js';
import { LoadLimits } from './loadlimits.js';
import { parseXml, writeXml, type XmlNode } from './xml.js';
import type { FormData, FormDataField } from './formdata.js';

/** Acrobat's namespace for the attribute that carries a field name XML cannot
 *  spell as an element name. */
const XFDF_TRANSITION_NS = 'http://ns.adobe.com/xfdf-transition/';

/** XML 1.0 forbids these outright; a field value holding one would make the
 *  whole file unparseable, so they are dropped from what is written. */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const NAME_START = /[A-Za-z_\p{L}]/u;
const NAME_CHAR = /[A-Za-z0-9_\-\p{L}\p{N}\p{M}]/u;

/** One name segment as an element name: every character XML does not admit
 *  becomes `_`, a segment not starting with a letter or `_` gains a leading
 *  `_`, and so does one starting with `xml`, which XML reserves. Undefined
 *  when the segment is already a valid name. */
export function xmlElementName(seg: string): string | undefined {
  let out = '';
  for (const ch of seg) out += NAME_CHAR.test(ch) ? ch : '_';
  if (out === '' || !NAME_START.test(out[0]!) || /^xml/i.test(out)) out = `_${out}`;
  return out === seg ? undefined : out;
}

const el = (name: string, attrs: Record<string, string> = {}): XmlNode =>
  ({ name, attrs: new Map(Object.entries(attrs)), children: [], text: '', nodes: [] });

/** The segment an element stands for: its `xfdf:original`, else its name. */
const segOf = (n: XmlNode): string => n.attrs.get('original') ?? n.name;

/** Find or create the container element for `seg` under `parent`. */
function container(parent: XmlNode, seg: string): XmlNode {
  for (const c of parent.children) if (segOf(c) === seg && c.children.length > 0) return c;
  const made = segElement(seg);
  parent.children.push(made);
  return made;
}

function segElement(seg: string): XmlNode {
  const mangled = xmlElementName(seg);
  return mangled === undefined ? el(seg) : el(mangled, { 'xfdf:original': seg });
}

/** A field's values as XML text (2srz.2): a radio group writes its EXPORT, or
 *  `Off` when nothing is selected, where FDF and XFDF write its appearance
 *  state; a checkbox writes its on-state name or `Off`, as Acrobat does. */
function textsOf(f: FormDataField): string[] {
  if (f.type === 'radio' && typeof f.value === 'string') return [f.value === '' ? 'Off' : f.value];
  return f.values.length > 0 ? f.values : [''];
}

/** Serialize form data as Acrobat's AcroForm XML: a `<fields>` root holding
 *  one element per name segment, the XFA datasets shape, a terminal field's
 *  value as its element's text. A multi-select field repeats its element once
 *  per selected value. */
export function writeFormXml(data: FormData): Uint8Array {
  const root = el('fields', { 'xmlns:xfdf': XFDF_TRANSITION_NS });
  for (const f of data.fields) {
    const segs = f.name.split('.');
    let parent = root;
    for (const seg of segs.slice(0, -1)) parent = container(parent, seg);
    for (const t of textsOf(f)) {
      const leaf = segElement(segs[segs.length - 1]!);
      leaf.text = t.replace(NOT_XML, '');
      parent.children.push(leaf);
    }
  }
  return new TextEncoder().encode(writeXml(root));
}

/** Walk the tree: an element with child elements is a container, one without
 *  is a terminal field, and sibling terminals naming the same field are one
 *  multi-valued entry, in document order. */
function walk(node: XmlNode, path: string, out: FormDataField[]): void {
  const leaves = new Map<string, FormDataField>();
  for (const c of node.children) {
    const full = path === '' ? segOf(c) : `${path}.${segOf(c)}`;
    if (c.children.length > 0) { walk(c, full, out); continue; }
    const seen = leaves.get(full);
    if (seen !== undefined) { seen.values.push(c.text); continue; }
    const entry: FormDataField = { name: full, type: 'unknown', values: [c.text] };
    leaves.set(full, entry);
    out.push(entry);
  }
}

/** Parse AcroForm XML into the format-neutral model. The root element's name
 *  is not checked -- Acrobat writes `<fields>`, and a datasets-shaped file
 *  from elsewhere names its own -- so only text that is not XML is refused. */
export function readFormXml(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): FormData {
  let root: XmlNode;
  try {
    root = parseXml(bytes, limits);
  } catch (caught) { rethrowLimit(caught);
    throw new PdfParseError(`form XML: ${(caught as Error).message}`);
  }
  const data: FormData = { fields: [], radioExports: true };
  walk(root, '', data.fields);
  return data;
}
