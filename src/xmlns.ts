/** A namespace-resolved view of an XML document (`m2fp.3`).
 *
 *  `parseXml` either strips prefixes or keeps them verbatim, and resolves
 *  neither. This resolves both — each element gets its namespace URI and local
 *  name, each attribute is keyed by `(namespace, local)` — through a
 *  per-element `xmlns` scope, so a producer binding `w` to another prefix, or
 *  declaring it on an inner element, reads identically.
 *
 *  **Invariant:** an UNPREFIXED attribute has NO namespace (Namespaces in XML
 *  6.2); only elements take the default namespace. `wp:extent cx` and
 *  `a:latin typeface` are read as `('', 'cx')`.
 *
 *  **Invariant:** Markup Compatibility (ECMA-376 Part 3) is applied at build
 *  when the caller names the namespaces it understands. An
 *  `mc:AlternateContent` becomes the children of its first `mc:Choice` whose
 *  `Requires` prefixes all resolve to understood namespaces, else of its
 *  `mc:Fallback`, else nothing — SPLICED into the parent; an element or
 *  attribute in an `mc:Ignorable` namespace that is not understood is dropped
 *  with its subtree — unless `mc:ProcessContent` (in scope on it or an
 *  ancestor) names it, by `prefix:local` or `prefix:*`, in which case its
 *  CHILDREN are spliced in its place. An `mc:MustUnderstand` naming a namespace
 *  not understood is `PdfParseError`: the producer said the content cannot be
 *  read without it (`m2fp.9`). A consumer never sees MC markup.
 *
 *  A leaf over `xml.js`, `loadlimits.js` and `errors.js`; it knows no
 *  vocabulary. `xmprdf.ts` keeps its own RDF-specific binding. Recursion is
 *  bounded by `parseXml`'s `maxNestingDepth`. */
import { parseXml, type XmlNode } from './xml.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError } from './errors.js';

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

export interface NsElement {
  /** Namespace URI, canonicalized; '' when the element is in no namespace. */
  readonly ns: string;
  readonly local: string;
  /** Keyed `${ns} ${local}`; an unprefixed attribute has ns ''. */
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly NsElement[];
  /** The concatenated direct text content, verbatim. */
  readonly text: string;
}

export interface NsOptions {
  /** Map a declared namespace URI to the one the caller compares against. */
  canon?: (uri: string) => string;
  /** Apply Markup Compatibility, understanding these namespaces. */
  understood?: ReadonlySet<string>;
}

type Scope = ReadonlyMap<string, string>;

const splitQ = (q: string): [string, string] => {
  const c = q.indexOf(':');
  return c < 0 ? ['', q] : [q.slice(0, c), q.slice(c + 1)];
};

export function nsAttr(el: NsElement | undefined, ns: string, local: string): string | undefined {
  return el?.attrs.get(`${ns} ${local}`);
}
export function nsChild(el: NsElement | undefined, ns: string, local: string): NsElement | undefined {
  return el?.children.find((c) => c.ns === ns && c.local === local);
}
export function nsChildren(el: NsElement | undefined, ns: string, local: string): NsElement[] {
  return el ? el.children.filter((c) => c.ns === ns && c.local === local) : [];
}
/** The first descendant with this name, depth first, `el` itself excluded. */
export function nsFind(el: NsElement | undefined, ns: string, local: string): NsElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) {
    if (c.ns === ns && c.local === local) return c;
    const d = nsFind(c, ns, local);
    if (d) return d;
  }
  return undefined;
}

export function parseNsXml(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults, opts: NsOptions = {}): NsElement {
  const root = parseXml(bytes, limits, { qnames: true });
  const out = new Builder(opts.canon ?? ((u) => u), opts.understood).convert(root, new Map([['xml', XML_NS]]), new Set(), new Set());
  if (out.length !== 1) throw new PdfParseError('XML: markup compatibility removed the root element');
  return out[0];
}

class Builder {
  constructor(private readonly canon: (u: string) => string, private readonly understood?: ReadonlySet<string>) {}

  private scopeOf(node: XmlNode, parent: Scope): Scope {
    let scope: Map<string, string> | undefined;
    for (const [k, v] of node.attrs) {
      if (k !== 'xmlns' && !k.startsWith('xmlns:')) continue;
      scope ??= new Map(parent);
      scope.set(k === 'xmlns' ? '' : k.slice(6), this.canon(v));
    }
    return scope ?? parent;
  }

  convert(node: XmlNode, parentScope: Scope, parentIgnorable: ReadonlySet<string>, parentProcess: ReadonlySet<string>): NsElement[] {
    const scope = this.scopeOf(node, parentScope);
    const [pfx, local] = splitQ(node.name);
    const ns = scope.get(pfx) ?? '';
    const mc = this.understood;
    let ignorable = parentIgnorable;
    let process = parentProcess;
    if (mc) {
      for (const [k, v] of node.attrs) {
        const [ap, al] = splitQ(k);
        if (ap === '' || scope.get(ap) !== MC_NS) continue;
        const tokens = v.split(/\s+/).filter((t) => t !== '');
        if (al === 'Ignorable') {
          const next = new Set(ignorable);
          for (const t of tokens) { const u = scope.get(t); if (u) next.add(u); }
          ignorable = next;
        } else if (al === 'ProcessContent') {
          const next = new Set(process);
          for (const t of tokens) { const [tp, tl] = splitQ(t); const u = scope.get(tp); if (u) next.add(`${u} ${tl}`); }
          process = next;
        } else if (al === 'MustUnderstand') {
          for (const t of tokens) {
            const u = scope.get(t);
            if (u === undefined || !mc.has(u)) throw new PdfParseError(`XML: markup compatibility requires a namespace this reader does not understand (${u ?? t})`);
          }
        }
      }
      if (ns === MC_NS && local === 'AlternateContent') return this.alternate(node, scope, ignorable, process);
      if (ns !== '' && ignorable.has(ns) && !mc.has(ns)) {
        return process.has(`${ns} ${local}`) || process.has(`${ns} *`)
          ? node.children.flatMap((c) => this.convert(c, scope, ignorable, process)) : [];
      }
    }
    const attrs = new Map<string, string>();
    for (const [k, v] of node.attrs) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      const [ap, al] = splitQ(k);
      const ans = ap === '' ? '' : scope.get(ap) ?? '';
      if (mc && ans !== '' && ignorable.has(ans) && !mc.has(ans)) continue;
      attrs.set(`${ans} ${al}`, v);
    }
    const children = node.children.flatMap((c) => this.convert(c, scope, ignorable, process));
    return [{ ns, local, attrs, children, text: node.text }];
  }

  private alternate(node: XmlNode, scope: Scope, ignorable: ReadonlySet<string>, process: ReadonlySet<string>): NsElement[] {
    const understood = this.understood!;
    let fallback: { node: XmlNode; scope: Scope } | undefined;
    for (const c of node.children) {
      const cs = this.scopeOf(c, scope);
      const [cp, cl] = splitQ(c.name);
      if (cs.get(cp) !== MC_NS) continue;
      if (cl === 'Choice') {
        const req = (c.attrs.get('Requires') ?? '').split(/\s+/).filter((t) => t !== '');
        if (req.every((t) => { const u = cs.get(t); return u !== undefined && understood.has(u); }))
          return c.children.flatMap((g) => this.convert(g, cs, ignorable, process));
      } else if (cl === 'Fallback' && !fallback) fallback = { node: c, scope: cs };
    }
    return fallback ? fallback.node.children.flatMap((g) => this.convert(g, fallback!.scope, ignorable, process)) : [];
  }
}
