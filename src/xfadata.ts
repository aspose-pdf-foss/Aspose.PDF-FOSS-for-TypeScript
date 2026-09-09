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

/** Supply `[0]` for any path step that states no occurrence index, so an
 *  explicit `<bind ref>` written in SOM's abbreviated form still resolves. */
function indexed(path: string): string {
  return path.split('.')
    .map((p) => (p.endsWith(']') ? p : `${p}[0]`))
    .join('.');
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
  field: XfaField, values: XfaValues,
): string | string[] | undefined {
  if (field.bindMatch === 'none') return undefined;
  if (field.bindRef !== undefined && field.bindRef !== '') {
    // A leading '$record.' / '$data.' / '$.' names the data root, which is what
    // the paths in `values` are already relative to.
    const ref = field.bindRef.replace(/^\$(?:record|data)?\./, '');
    return values.get(indexed(ref));
  }
  return values.get(field.name);
}
