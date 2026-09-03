/** The two things HTML says about a node that the DOM inherits rather than
 *  the cascade computes: its natural LANGUAGE and its writing DIRECTION.
 *
 *  Its own module, and not part of cssselect.ts, for three reasons. These are
 *  HTML semantics rather than selector matching; `nodeDirection` needs
 *  bidi.js, where cssselect.ts is today a leaf over htmldom.js and
 *  cssparse.js alone; and both are drivable from a hand-built DOM, so every
 *  rule below is testable without a stylesheet.
 *
 *  Invariant, and the issue this closes was filed on the opposite belief:
 *  NEITHER IS A CSS PROPERTY. `zch2.2.5` recorded that `:lang()` and `:dir()`
 *  "need the inherited lang, which is the cascade's rather than the selector
 *  engine's", and that is wrong — `lang` and `dir` are HTML ATTRIBUTES
 *  inherited through the DOM, and ComputedStyle carries neither among its 43
 *  longhands. So this walks parent pointers, the cascade is not involved at
 *  all, and `matches()` needed no new parameter.
 *
 *  Invariant: an EMPTY `lang=""` means "unknown", not "the empty language".
 *  It must neither be reported nor inherited past — a document that sets
 *  `lang=""` on a quotation inside an English page is saying it does not know
 *  that quotation's language, and reporting `en` there would be a claim the
 *  document declined to make.
 *
 *  Invariant: `dir=auto` is RESOLVED rather than defaulted. Defaulting it to
 *  ltr gives a plausible wrong answer for every Arabic or Hebrew document
 *  that uses it — the failure mode this repo dislikes most — and the machinery
 *  already exists: bidi.paragraphLevel implements UAX #9 P2/P3, the
 *  first-strong rule, which is exactly what HTML's auto state calls for.
 *
 *  Invariant: the auto scan SKIPS a descendant that states its own `dir`.
 *  That text is governed by its own direction, so letting it decide the
 *  ancestor's inverts both — and it is the everyday shape, since `dir=auto`
 *  is used precisely where a subtree of known direction is embedded in text
 *  of unknown direction. */

import type { HtmlElement, HtmlNode } from './htmldom.js';
import { paragraphLevel } from './bidi.js';

/** Elements whose text is not content and must not steer the auto scan. */
const NON_TEXT = new Set(['script', 'style']);

/** The nearest `lang` in scope, or undefined when nothing states one.
 *
 *  `xml:lang` is deliberately not consulted: it only arises in foreign
 *  content, which nothing in this epic renders. */
export function nodeLanguage(el: HtmlElement): string | undefined {
  for (let n: HtmlNode | null = el; n !== null; n = n.parent) {
    if (n.kind !== 'element') break;
    const v = n.attrs.get('lang');
    // A stated-but-empty lang means UNKNOWN and stops the walk, rather than
    // falling through to an ancestor that would answer confidently.
    if (v !== undefined) return v.trim() === '' ? undefined : v.trim();
  }
  return undefined;
}

/** Split a language tag or range into lowercased subtags. */
const subtags = (s: string): string[] => s.toLowerCase().split('-');

/** Does `tag` match `range` under RFC 4647 §3.3.2 extended filtering?
 *
 *  The rule Selectors 4 cites for `:lang()`. Two halves are easy to get
 *  wrong and each renders plausibly: the match must fall on a SUBTAG
 *  BOUNDARY, so `:lang(en)` matches `en-US` and not `english` — which a
 *  `startsWith` gets backwards — and a SINGLETON subtag may never be skipped,
 *  because a one-character subtag begins an extension and skipping past one
 *  matches across a boundary that means something. */
export function langMatches(tag: string, range: string): boolean {
  if (tag.trim() === '') return false;
  const t = subtags(tag);
  const r = subtags(range);

  // Step 2: the first subtags must be equal, unless the range's is a wildcard.
  if (r[0] !== '*' && r[0] !== t[0]) return false;

  let ti = 1;
  let ri = 1;
  while (ri < r.length) {
    if (r[ri] === '*') { ri += 1; continue; }        // 3.A
    if (ti >= t.length) return false;                // 3.B
    if (t[ti] === r[ri]) { ti += 1; ri += 1; continue; }  // 3.C.iii
    if (t[ti].length === 1) return false;            // 3.C.ii — a singleton
    ti += 1;                                         // 3.C.i — skip and retry
  }
  return true;
}

/** Every code point of the text that decides an `auto` element's direction:
 *  its descendants' text, skipping any subtree that states its own `dir` and
 *  any non-content element. */
function autoText(el: HtmlElement, out: number[]): void {
  for (const c of el.children) {
    if (c.kind === 'text') {
      for (const ch of c.data) out.push(ch.codePointAt(0) as number);
      continue;
    }
    if (c.kind !== 'element') continue;
    if (c.ns === 'html' && NON_TEXT.has(c.name.toLowerCase())) continue;
    // A descendant with its own dir is governed by it, so its text says
    // nothing about this element.
    if (dirAttr(c) !== undefined) continue;
    autoText(c, out);
  }
}

/** The element's own `dir`, normalized, or undefined when it states none or
 *  states something HTML does not define. An unknown value is IGNORED rather
 *  than treated as a direction, so the element inherits. */
function dirAttr(el: HtmlElement): 'ltr' | 'rtl' | 'auto' | undefined {
  const v = el.attrs.get('dir')?.trim().toLowerCase();
  return v === 'ltr' || v === 'rtl' || v === 'auto' ? v : undefined;
}

/** The element's directionality: `dir` where stated, resolved for `auto`,
 *  inherited otherwise, and `ltr` at the root.
 *
 *  `<bdi>` with no `dir` is `auto` — that is what the element is for. */
export function nodeDirection(el: HtmlElement): 'ltr' | 'rtl' {
  for (let n: HtmlNode | null = el; n !== null; n = n.parent) {
    if (n.kind !== 'element') break;
    let d = dirAttr(n);
    if (d === undefined && n.ns === 'html' && n.name.toLowerCase() === 'bdi') d = 'auto';
    if (d === 'ltr' || d === 'rtl') return d;
    if (d === 'auto') {
      const codes: number[] = [];
      autoText(n, codes);
      // UAX #9 P2/P3: the first strong character decides, and no strong
      // character at all gives level 0.
      return paragraphLevel(codes, 'auto') === 1 ? 'rtl' : 'ltr';
    }
  }
  return 'ltr';
}
