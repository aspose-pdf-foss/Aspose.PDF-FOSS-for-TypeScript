/** The stack of open elements and the list of active formatting elements
 *  (HTML Standard §13.2.4.2 and §13.2.4.3).
 *
 *  Invariant: its own module because these are PURE LIST ALGORITHMS, testable
 *  from hand-built element lists with no parser and no document — the split
 *  floatstack.ts makes against floatbox.ts. It must not import htmltree.ts:
 *  the stacks are operated BY the insertion modes and know nothing about them.
 *
 *  Invariant: nothing here throws. */

import type { HtmlElement } from './htmldom.js';

/** FOUR scopes, not five. The HTML Standard has REMOVED "select scope" along
 *  with the two "in select" insertion modes (customizable select), and moved
 *  `select` into the DEFAULT scope's terminator list instead — which is a
 *  reversal, since the old select scope was inverted. The vendored WPT corpus
 *  is written against the current spec and is what settles this; the design
 *  and plan for zch2.1.2 both described the older five. */
export type ScopeKind = 'default' | 'listItem' | 'button' | 'table';

/** §13.2.4.2's "particular element in scope" terminators. The MathML and SVG
 *  entries are zch2.1.3's, since nothing here creates a foreign element. */
/** A scope terminator, as `ns:name`. Keying on the PAIR is not tidiness: an
 *  SVG `title` terminates a scope and so does an HTML `<title>`, but MathML
 *  `mi` does and an HTML `<mi>` does not. A name-only test is wrong in both
 *  directions, and what it breaks is the adoption agency's choice of furthest
 *  block — a mis-nested tree that still renders. */
const BASE_SCOPE = [
  'html:applet', 'html:caption', 'html:html', 'html:table', 'html:td', 'html:th',
  'html:marquee', 'html:object', 'html:select', 'html:template',
  'math:mi', 'math:mo', 'math:mn', 'math:ms', 'math:mtext', 'math:annotation-xml',
  'svg:foreignObject', 'svg:desc', 'svg:title',
];

const SCOPE_STOPPERS: Record<ScopeKind, string[]> = {
  default: BASE_SCOPE,
  listItem: [...BASE_SCOPE, 'html:ol', 'html:ul'],
  button: [...BASE_SCOPE, 'html:button'],
  table: ['html:html', 'html:table', 'html:template'],
};

export class OpenElements {
  readonly items: HtmlElement[] = [];

  get current(): HtmlElement | undefined {
    return this.items[this.items.length - 1];
  }

  push(el: HtmlElement): void {
    this.items.push(el);
  }

  pop(): HtmlElement | undefined {
    return this.items.pop();
  }

  /** Pops THROUGH the first match from the top, not up to it.
   *
   *  Matches an HTML element only. Every spec call site reads "until an HTML
   *  element with the same tag name has been popped" — and the difference is
   *  not academic: `<td><svg><td>` puts an SVG `td` above the HTML one, so a
   *  name-only match stops at the wrong element and strands the whole SVG
   *  subtree on the stack. That is what namespace-sensitivity.dat is for. */
  popUntilName(name: string): void {
    for (;;) {
      const el = this.items.pop();
      if (el === undefined || (el.ns === 'html' && el.name === name)) return;
    }
  }

  popUntilOneOf(names: string[]): void {
    for (;;) {
      const el = this.items.pop();
      if (el === undefined || (el.ns === 'html' && names.includes(el.name))) return;
    }
  }

  popUntilElement(el: HtmlElement): void {
    for (;;) {
      const top = this.items.pop();
      if (top === undefined || top === el) return;
    }
  }

  remove(el: HtmlElement): void {
    const at = this.items.indexOf(el);
    if (at >= 0) this.items.splice(at, 1);
  }

  contains(el: HtmlElement): boolean {
    return this.items.includes(el);
  }

  containsName(name: string): boolean {
    return this.items.some((e) => e.ns === 'html' && e.name === name);
  }

  indexOf(el: HtmlElement): number {
    return this.items.indexOf(el);
  }

  /** The element below `el`, or undefined at the bottom. */
  below(el: HtmlElement): HtmlElement | undefined {
    const at = this.items.indexOf(el);
    return at > 0 ? this.items[at - 1] : undefined;
  }

  /** Names an HTML element, which is what every spec call site means by "has
   *  a `p` element in button scope". A foreign element of that name is NOT the
   *  target, or `</p>` inside an SVG subtree would close an SVG `<p>`. */
  hasInScope(name: string, kind: ScopeKind = 'default'): boolean {
    return this.scopeSearch((e) => e.ns === 'html' && e.name === name, kind);
  }

  hasElementInScope(el: HtmlElement, kind: ScopeKind = 'default'): boolean {
    return this.scopeSearch((e) => e === el, kind);
  }

  hasOneOfInScope(names: string[], kind: ScopeKind = 'default'): boolean {
    return this.scopeSearch((e) => e.ns === 'html' && names.includes(e.name), kind);
  }

  private scopeSearch(match: (e: HtmlElement) => boolean, kind: ScopeKind): boolean {
    const stoppers = SCOPE_STOPPERS[kind];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const el = this.items[i] as HtmlElement;
      if (match(el)) return true;
      if (stoppers.includes(`${el.ns}:${el.name}`)) return false;
    }
    return false;
  }
}

/** A marker in the active-formatting list; null is the marker. */
export type FormattingEntry = HtmlElement | null;

/** §13.2.4.3's Noah's Ark clause compares tag name, namespace and attributes.
 *  Nothing here creates a foreign element, so the namespace is constant. */
export function sameFormattingElement(a: HtmlElement, b: HtmlElement): boolean {
  if (a.name !== b.name) return false;
  if (a.attrs.size !== b.attrs.size) return false;
  for (const [k, v] of a.attrs) {
    if (b.attrs.get(k) !== v) return false;
  }
  return true;
}

export class ActiveFormatting {
  readonly items: FormattingEntry[] = [];

  /** Push, applying the Noah's Ark clause: at most three entries with the same
   *  name and attribute set may be in the list after the last marker; on the
   *  fourth, the EARLIEST of them is removed. Miss it and deeply nested
   *  repeated formatting grows the list without bound and still renders — a
   *  correctness rule with no visible symptom. */
  push(el: HtmlElement): void {
    const equal: HtmlElement[] = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const entry = this.items[i];
      if (entry === null || entry === undefined) break;
      if (sameFormattingElement(entry, el)) equal.push(entry);
    }
    if (equal.length >= 3) {
      const earliest = equal[equal.length - 1] as HtmlElement;
      this.remove(earliest);
    }
    this.items.push(el);
  }

  pushMarker(): void {
    this.items.push(null);
  }

  clearToLastMarker(): void {
    for (;;) {
      const entry = this.items.pop();
      if (entry === undefined || entry === null) return;
    }
  }

  remove(el: HtmlElement): void {
    const at = this.items.indexOf(el);
    if (at >= 0) this.items.splice(at, 1);
  }

  replace(oldEl: HtmlElement, newEl: HtmlElement): void {
    const at = this.items.indexOf(oldEl);
    if (at >= 0) this.items[at] = newEl;
  }

  insertAt(index: number, el: HtmlElement): void {
    this.items.splice(index, 0, el);
  }

  contains(el: HtmlElement): boolean {
    return this.items.includes(el);
  }

  indexOf(el: HtmlElement): number {
    return this.items.indexOf(el);
  }

  /** The last entry of this name after the last marker — never past it. */
  lastBetweenMarkerAndEnd(name: string): HtmlElement | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const entry = this.items[i];
      if (entry === null || entry === undefined) return undefined;
      if (entry.name === name) return entry;
    }
    return undefined;
  }
}
