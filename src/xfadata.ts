/**
 * The XFA `datasets` packet as values by data path, and the rule that joins a
 * template field to a datum.
 *
 * **Invariant: pure, over `xml.js` alone**, and it never throws.
 *
 * **Invariant: the data path is SOM-SHAPED** -- occurrence indices included,
 * built by the same per-name sibling ordinal `xfatemplate.ts` uses. That is
 * what makes the implicit join a Map lookup on the field's own name rather
 * than a second path grammar that could disagree with the first.
 */
import type { XmlNode } from './xml.js';
import type { XfaField } from './xfatemplate.js';

export type XfaValues = ReadonlyMap<string, string | string[]>;

/** A leaf's value: repeated `<value>` children are an array (a multi-select
 *  list box), anything else is the element's own text. */
function leafValue(el: XmlNode): string | string[] {
  const vs = el.children.filter((c) => c.name === 'value');
  if (vs.length > 1) return vs.map((v) => v.text);
  if (vs.length === 1) return vs[0].text;
  return el.text;
}

function collect(el: XmlNode, path: readonly string[], out: Map<string, string | string[]>): void {
  const counts = new Map<string, number>();
  for (const c of el.children) {
    const i = counts.get(c.name) ?? 0;
    counts.set(c.name, i + 1);
    const sub = [...path, `${c.name}[${String(i)}]`];
    // A node with element children other than <value> is a CONTAINER, and a
    // container carries no value of its own -- XmlNode.text is the
    // concatenation of a subtree's text, so recording it would invent a datum
    // spanning every field beneath it.
    const containers = c.children.filter((g) => g.name !== 'value');
    if (containers.length === 0) out.set(sub.join('.'), leafValue(c));
    else collect(c, sub, out);
  }
}

/** The `datasets` packet's root to values by SOM-shaped data path. */
export function parseXfaDatasets(root: XmlNode): XfaValues {
  const out = new Map<string, string | string[]>();
  const data = root.name === 'data' ? root : root.children.find((c) => c.name === 'data');
  if (data) collect(data, [], out);
  return out;
}

/** Element local name to the FIRST leaf value of that name (yy09). */
export type XfaGlobals = ReadonlyMap<string, string | string[]>;

/**
 * The index `bind match="global"` searches (yy09): every data VALUE by its
 * element name, the FIRST in document order winning.
 *
 * XFA 3.3 p. 247: the search "treats the Data DOM as though it was completely
 * flattened", and of several matches picks "the one with the same index as the
 * current record number" -- record 0 here, since record mode is not modelled.
 * A data GROUP is not a value and an ATTRIBUTE never binds ("Attributes of
 * global data elements can not bind to fields"); `collect`'s leaf rule gives
 * both for free, and walking the SAME tree in the SAME order is what keeps the
 * two maps from disagreeing about which datum is first.
 */
export function parseXfaGlobals(root: XmlNode): XfaGlobals {
  const out = new Map<string, string | string[]>();
  const walk = (el: XmlNode): void => {
    for (const c of el.children) {
      if (c.children.some((g) => g.name !== 'value')) walk(c);
      else if (!out.has(c.name)) out.set(c.name, leafValue(c));
    }
  };
  const data = root.name === 'data' ? root : root.children.find((c) => c.name === 'data');
  if (data) walk(data);
  return out;
}

/** Supply `[0]` for any path step that states no occurrence index, so an
 *  explicit `<bind ref>` written in SOM's abbreviated form still resolves. */
function indexed(path: string): string {
  return path.split('.')
    .map((p) => (p.endsWith(']') ? p : `${p}[0]`))
    .join('.');
}

/**
 * `$record`'s data path: the first element child of `<xfa:data>`, read off the
 * first key. That is sound because `collect` walks depth first in document
 * order and every element yields at least one key -- a leaf records itself
 * (an empty one as `''`), a container recurses until it reaches one -- so the
 * first key always begins with the first element. `undefined` for no data.
 */
function recordOf(values: XfaValues): string | undefined {
  const first = values.keys().next();
  // Cut at the first ']', never the first '.': an XML name may contain a dot.
  return first.done ? undefined : first.value.slice(0, first.value.indexOf(']') + 1);
}

/**
 * The value a template field takes from the data.
 *
 * `match="none"` is deliberately unbound and binds NOTHING even when a datum
 * matches by name -- binding it anyway puts the wrong answer in the box. An
 * explicit `<bind ref>` outranks the implicit name match, and one that resolves
 * to nothing binds nothing rather than silently falling back: the form stated
 * where this field's data lives, and it is not there.
 */
export function bindFieldValue(
  field: XfaField, values: XfaValues, globals?: XfaGlobals,
): string | string[] | undefined {
  if (field.bindMatch === 'none') return undefined;
  if (field.bindRef !== undefined && field.bindRef !== '') {
    // '$data.' and '$.' name the data root, which is what the paths in
    // `values` are already relative to. '$record.' does NOT (c3jq): with
    // record processing off it is the OUTER data element -- XFA 3.3 p. 91-92,
    // "$record would be set to $data.Receipt" -- so it resolves under that
    // element. Record mode, where $record advances per record, is not modelled.
    const root = /^\$(?:data)?\./.exec(field.bindRef);
    if (root) return values.get(indexed(field.bindRef.slice(root[0].length)));
    if (field.bindRef.startsWith('$record.')) {
      const record = recordOf(values);
      if (record === undefined) return undefined;
      return values.get(`${record}.${indexed(field.bindRef.slice('$record.'.length))}`);
    }
    return values.get(indexed(field.bindRef));
  }
  // The DATA path, never the SOM name: an unnamed container is transparent to
  // data binding and has no element in the datasets packet (fdq3).
  const own = values.get(field.dataPath);
  if (own !== undefined || field.bindMatch !== 'global' || globals === undefined) return own;
  // yy09, XFA 3.3 p. 246-247: a global field that does not match directly takes
  // a global datum of its name, shared by every global field so named.
  // STATED DIVERGENCE: p. 247 says that "in non-record mode ... marking a field
  // as global has no effect", and no vendored form enables record mode (no
  // config <record>, p. 531). Read literally, all 175 of the corpus's global
  // fields would bind nothing -- yet Designer stores each such datum once,
  // under the outermost data group, and pdf.js 6.3.289
  // (_findDataByNameToConsume) applies the flattened search regardless. We do
  // the same. Record mode itself is not modelled.
  return field.dataName === undefined ? undefined : globals.get(field.dataName);
}

/** How many data children of each name sit at each data path (164g.2). */
export interface XfaDataGroups {
  /** No data document, or an `<xfa:data>` with no children: the merge is EMPTY
   *  (XFA 3.3 p. 339-340), and a repeating subform takes its `initial`. */
  readonly empty: boolean;
  /** How many children named `name` the data node at `path` holds; 0 when
   *  `path` names no data node. `path` is SOM-shaped, `''` for the data root. */
  count(path: string, name: string): number;
}

/**
 * The `datasets` packet's data groups, for instantiating repeating subforms.
 *
 * **Invariant (164g.2): it counts ELEMENTS, empty ones included.** OPM 1644's
 * repeating `Header` rows bind to `<Header xfa:dataNode="dataGroup"></Header>`,
 * which has no value, so `parseXfaDatasets`' leaf map cannot see how many there
 * are. Paths are keyed exactly as that function keys them -- per name among
 * siblings -- so a template instance's data path `...Header[k]` is the path its
 * fields bind by.
 */
export function parseXfaDataGroups(root: XmlNode | undefined): XfaDataGroups {
  const counts = new Map<string, Map<string, number>>();
  const data = root === undefined ? undefined
    : root.name === 'data' ? root : root.children.find((c) => c.name === 'data');
  const visit = (el: XmlNode, path: string): void => {
    const here = new Map<string, number>();
    counts.set(path, here);
    for (const c of el.children) {
      const i = here.get(c.name) ?? 0;
      here.set(c.name, i + 1);
      visit(c, `${path === '' ? '' : `${path}.`}${c.name}[${String(i)}]`);
    }
  };
  if (data) visit(data, '');
  return {
    empty: data === undefined || data.children.length === 0,
    count: (path, name) => counts.get(path)?.get(name) ?? 0,
  };
}
