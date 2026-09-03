/** What an HTML document asked for that we could not fully draw.
 *
 *  Invariant: a PURE LEAF over htmldom.js. It imports nothing else — no
 *  Document, no PDF object module, no `node:` import, and none of its four
 *  consumers (cssbox.ts, cssinline.ts, csstable.ts, cssflow.ts). It never
 *  throws. That is what lets every rule here be tested from a parsed string
 *  with no PDF built at all.
 *
 *  Invariant: it is `html*` rather than `css*` despite the CSS stack being
 *  its only consumer. It is keyed on HTML element names and encodes HTML's
 *  own content models, and it sits beside htmllang.ts — the existing
 *  precedent for an HTML fact as a pure leaf. Naming it cssreport.ts would
 *  say the policy is a CSS one and send the next reader to the cascade.
 *
 *  Invariant: a module of its own rather than a section of cssprop.ts,
 *  because TWO consumers need the policy and neither may import the other.
 *  cssbox.ts must not descend into a block-level <iframe>; cssinline.ts has
 *  its own separate `visit` walk and must not descend into an inline one.
 *  The forcing argument behind colornames.ts, preformat.ts and
 *  bordersides.ts.
 *
 *  Invariant: TWO kinds, not three. A `leaked` kind was considered and
 *  dropped: once the per-element policy is in place nothing leaks knowingly,
 *  so no site could produce one, and a kind nobody emits is a case every
 *  consumer switches on for nothing. */

import type { HtmlElement, HtmlNode } from './htmldom.js';

/** Every construct this stack can report. A closed vocabulary rather than a
 *  free string, so a typo is a compile error and the set can be asserted by
 *  SIZE — a half-filled table is then a red build rather than a silently
 *  unreported element. */
export type Construct =
  // Replaced elements and foreign content.
  | 'iframe' | 'svg' | 'math'
  | 'object' | 'video' | 'audio' | 'canvas'
  // Form controls.
  | 'input' | 'select' | 'textarea' | 'button'
  // Properties computed and not read.
  | 'inline-block' | 'vertical-align' | 'inline-box'
  // Layout constructs.
  | 'float' | 'image' | 'table' | 'table-cell-blocks' | 'link'
  // Content the engine could only place by drawing it past the column bottom.
  // NOT 'text', which means a glyph the resolved face cannot draw and is shared
  // with svgdraw.ts — an overflowing block drew every character perfectly, and
  // filing it under 'text' would send a caller hunting a font problem.
  | 'overflow'
  // Text the resolved face cannot draw. Matches svgdraw.ts's name for the
  // same failure, so the library states one rule across both importers.
  | 'text';

export const CONSTRUCTS: readonly Construct[] = [
  'iframe', 'svg', 'math',
  'object', 'video', 'audio', 'canvas',
  'input', 'select', 'textarea', 'button',
  'inline-block', 'vertical-align', 'inline-box',
  'float', 'image', 'table', 'table-cell-blocks', 'link',
  'overflow',
  'text',
];

/** One thing a document asked for that did not render as specified.
 *
 *  `dropped` means nothing was drawn for it; `degraded` means something was,
 *  but not what the source said. A caller can act on the difference — a
 *  dropped construct may need the source changing, a degraded one may not. */
export interface NotRendered {
  /** null for a construct belonging to no element — an anonymous box. */
  el: HtmlElement | null;
  kind: 'dropped' | 'degraded';
  construct: Construct;
  /** The src, the property name, the declined value. */
  detail?: string;
}

/** What happens to an element's children, and how the element is reported. */
export interface ElementPolicy {
  /** Do this element's children reach the flow? */
  content: 'render' | 'suppress';
  kind: 'dropped' | 'degraded';
  construct: Construct;
}

/** The string form a caller that only logs wants — and exactly the strings
 *  `skipped` carried before zch2.7 made it structured. */
export function describe(r: NotRendered): string {
  return r.detail === undefined ? r.construct : `${r.construct}:${r.detail}`;
}

/** Elements whose children HTML itself treats specially. Keyed by tag name,
 *  HTML namespace only — the two foreign namespaces are answered separately,
 *  below, because a whole SUBTREE is foreign rather than one element.
 *
 *  Note what is NOT here: `input` and `select`, whose text is SELECTED rather
 *  than kept or suppressed, so cssinline.ts owns them outright. An entry for
 *  them would be a second statement about one element that could drift from
 *  the first. */
const HTML_POLICY: Readonly<Record<string, ElementPolicy>> = {
  // "Content that is ignored by conforming user agents" — HTML's own words.
  // Emitting it is a divergence from every browser, not a mercy.
  iframe: { content: 'suppress', kind: 'dropped', construct: 'iframe' },
  // Fallback content a browser DOES render when the thing cannot load.
  // Suppressing it would blank a page whose content sits in <object>.
  object: { content: 'render', kind: 'degraded', construct: 'object' },
  video: { content: 'render', kind: 'degraded', construct: 'video' },
  audio: { content: 'render', kind: 'degraded', construct: 'audio' },
  canvas: { content: 'render', kind: 'degraded', construct: 'canvas' },
  // A textarea's text and a button's caption ARE what a browser draws.
  textarea: { content: 'render', kind: 'degraded', construct: 'textarea' },
  button: { content: 'render', kind: 'degraded', construct: 'button' },
};

/** Asserted so a half-transcribed table is a red build. */
export const HTML_POLICY_SIZE = 7;

/** How an element's content is treated, or undefined for one the table does
 *  not name — whose caller default is `render` with no record. An unknown or
 *  custom element keeps its children and earns nothing, which is what a
 *  browser does. */
export function elementPolicy(el: HtmlElement): ElementPolicy | undefined {
  // By NAMESPACE, because a whole subtree is foreign rather than one element,
  // and because keying on the tag name would fire on an HTML element that
  // merely shares a name with an SVG one.
  // An inline <svg> RENDERS since zch2.12, through the SVG importer, so it is
  // not suppressed here. `svg` stays in the vocabulary: cssflow.ts emits it for
  // whatever the importer itself could not draw.
  if (el.ns === 'math') return { content: 'suppress', kind: 'dropped', construct: 'math' };
  // hasOwnProperty rather than `in`, the rule predefcmap.ts records: the name
  // comes from a document, so `<constructor>` would otherwise find
  // Object.prototype.constructor and be treated as a policy that exists.
  return Object.prototype.hasOwnProperty.call(HTML_POLICY, el.name)
    ? HTML_POLICY[el.name] : undefined;
}

/** The text of the `<option>` a closed `<select>` would show: the one
 *  carrying `selected`, else the first. Undefined when it has none.
 *
 *  Only ONE option, and that is the whole point: emitting every option turns
 *  a three-choice dropdown into three lines of body text — a document that
 *  looks plausible and says something the source does not. */
export function selectedOptionText(el: HtmlElement): string | undefined {
  const options: HtmlElement[] = [];
  const walk = (ns: HtmlNode[]): void => {
    for (const n of ns) {
      if (n.kind !== 'element') continue;
      if (n.ns === 'html' && n.name === 'option') options.push(n);
      else walk(n.children);       // an <optgroup>, or anything else wrapping
    }
  };
  walk(el.children);
  const chosen = options.find((o) => o.attrs.has('selected')) ?? options[0];
  if (chosen === undefined) return undefined;
  let text = '';
  const gather = (ns: HtmlNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'text') text += n.data;
      else if (n.kind === 'element') gather(n.children);
    }
  };
  gather(chosen.children);
  return text.replace(/\s+/g, ' ').trim();
}
