/** The HTML node model behind tree construction (HTML Standard §13.2.6).
 *
 *  Invariant: MUTABLE, with parent pointers — deliberately not an immutable AST
 *  like mdast.ts. The adoption agency algorithm relocates live nodes, and
 *  zch2.2's selector matching needs ancestor and sibling traversal.
 *
 *  Invariant: a pure leaf. No Document, no PDF object, no `node:` import, and
 *  nothing here throws — the rule htmltoken.ts already follows. */

export interface HtmlDocument {
  kind: 'document';
  children: HtmlNode[];
  parent: null;
  quirks: boolean;
}

export interface HtmlDoctype {
  kind: 'doctype';
  name: string;
  publicId: string;
  systemId: string;
  parent: HtmlNode | null;
}

/** The three namespaces tree construction can produce. A three-value union
 *  rather than a namespace URI: every comparison in the parser is against one
 *  of three constants, and the html5lib serializer wants the short spelling
 *  anyway, so a URI would be a long string compare everywhere plus a map back
 *  to `svg`/`math` at the end. */
export type HtmlNamespace = 'html' | 'svg' | 'math';

export interface HtmlElement {
  kind: 'element';
  ns: HtmlNamespace;
  name: string;
  attrs: Map<string, string>;
  children: HtmlNode[];
  /** Present on a `template` element and nothing else. */
  content?: HtmlFragment;
  parent: HtmlNode | null;
}

export interface HtmlText {
  kind: 'text';
  data: string;
  parent: HtmlNode | null;
}

export interface HtmlComment {
  kind: 'comment';
  data: string;
  parent: HtmlNode | null;
}

/** `<?target data?>`. Added to the HTML syntax by whatwg/html#12118 (merged
 *  2026-06-25); before that these bytes made a bogus comment, and they still
 *  do for every target the spec refuses. A PI may appear wherever a comment
 *  may, which is why tree construction routes it through the same fourteen
 *  branches. */
export interface HtmlProcessingInstruction {
  kind: 'pi';
  target: string;
  data: string;
  parent: HtmlNode | null;
}

/** A template's content. A real node rather than a second children array on
 *  the element, for three reasons in order of what they cost when ignored:
 *  a template's content is NOT part of the document, so CSS must not match
 *  into it and zch2.2's traversal must not walk it — a separate node makes
 *  that structural rather than a rule every consumer has to remember;
 *  appendChild/insertBefore/removeChild need a real parent object to point at,
 *  or each would need a template special case; and it is the DOM's own shape,
 *  so the serializer's `content` line is a transcription rather than a
 *  synthesis. */
export interface HtmlFragment {
  kind: 'fragment';
  children: HtmlNode[];
  parent: HtmlNode | null;
}

export type HtmlNode =
  HtmlDocument | HtmlDoctype | HtmlElement | HtmlText | HtmlComment
  | HtmlProcessingInstruction | HtmlFragment;

/** A node that can hold children. */
export type HtmlParent = HtmlDocument | HtmlElement | HtmlFragment;

/** Any node but the document, which is never anybody's child. */
export type HtmlChild =
  HtmlDoctype | HtmlElement | HtmlText | HtmlComment | HtmlProcessingInstruction;

export function createDocument(): HtmlDocument {
  return { kind: 'document', children: [], parent: null, quirks: false };
}

/** `ns` defaults to `'html'`, and that default is the FENCE rather than a
 *  convenience: every call site written before namespaces existed keeps
 *  meaning exactly what it meant, so the WPT cases that were green staying
 *  green is evidence the change is inert. */
export function createElement(
  name: string,
  attrs?: Map<string, string>,
  ns: HtmlNamespace = 'html',
): HtmlElement {
  return {
    kind: 'element',
    ns,
    name,
    attrs: attrs ?? new Map<string, string>(),
    children: [],
    parent: null,
  };
}

export function createText(data: string): HtmlText {
  return { kind: 'text', data, parent: null };
}

export function createComment(data: string): HtmlComment {
  return { kind: 'comment', data, parent: null };
}

export function createProcessingInstruction(
  target: string,
  data: string,
): HtmlProcessingInstruction {
  return { kind: 'pi', target, data, parent: null };
}

export function createFragment(): HtmlFragment {
  return { kind: 'fragment', children: [], parent: null };
}

export function createDoctype(name: string, publicId: string, systemId: string): HtmlDoctype {
  return { kind: 'doctype', name, publicId, systemId, parent: null };
}

/** Remove a node from its parent, if it has one. An unparented node is a
 *  no-op rather than an error: the adoption agency reaches this with nodes it
 *  has already detached. */
export function removeChild(child: HtmlChild): void {
  const parent = child.parent;
  if (parent === null) return;
  if (parent.kind !== 'document' && parent.kind !== 'element'
    && parent.kind !== 'fragment') return;
  const at = parent.children.indexOf(child);
  if (at >= 0) parent.children.splice(at, 1);
  child.parent = null;
}

/** Append, DETACHING from the current parent first. A node reachable from two
 *  parents is a cycle that hangs the serializer rather than failing an
 *  assertion — a far worse failure than a wrong tree. */
export function appendChild(parent: HtmlParent, child: HtmlChild): void {
  removeChild(child);
  parent.children.push(child);
  child.parent = parent;
}

/** Insert before a reference child, detaching for the same reason. If `ref` is
 *  not a child of `parent` this appends, which is the recovery the spec's
 *  "appropriate place for inserting a node" already implies. */
export function insertBefore(parent: HtmlParent, child: HtmlChild, ref: HtmlNode): void {
  removeChild(child);
  const at = parent.children.indexOf(ref);
  if (at < 0) parent.children.push(child);
  else parent.children.splice(at, 0, child);
  child.parent = parent;
}

export function childrenOf(n: HtmlNode): HtmlNode[] {
  return n.kind === 'document' || n.kind === 'element' || n.kind === 'fragment'
    ? n.children : [];
}
