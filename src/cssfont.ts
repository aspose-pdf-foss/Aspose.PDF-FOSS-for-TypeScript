/** The CSS `font-family` list to the four faces TextRun.font needs.
 *
 *  This is the seam every module below deferred to zch2.5. cssbox.ts,
 *  cssinline.ts, cssresolve.ts and cssflow.ts all take `resolveFamily` as an
 *  ARGUMENT and each records the same reason: ComputedStyle.fontFamily is a
 *  list of NAMES and TextRun.font is an AuthoringFont, and bridging them needs
 *  Document.LoadFontByName, which a pure leaf may not import. This module is
 *  where that import is finally allowed, and it is the ONLY module in the CSS
 *  stack permitted it.
 *
 *  Invariant: LoadFontFamily is REUSED rather than reimplemented, and it fits
 *  exactly. It already takes a string[] and walks the family chain, and it
 *  already returns { regular, bold?, italic?, boldItalic? } — structurally
 *  identical to MarkdownFontFamily, which is no coincidence: its own
 *  documentation says the result is ready to hand to
 *  AddMarkdown({ style: { font } }). Feeding it to mdstyle.resolveFamily keeps
 *  ONE owner for the rule that an unstated face falls back to `regular`.
 *
 *  Invariant: a generic keyword is NEVER offered to LoadFontFamily — no
 *  installed family is called `serif` — and the FIRST generic in the list
 *  wins, since a later one is a lower-priority fallback the author listed
 *  behind it.
 *
 *  Invariant: the resolver is memoized per DOCUMENT, and its answers memoized
 *  per family list. buildBoxes asks once per element, so a document of 500
 *  paragraphs asks 500 times for the same list. Per document rather than
 *  globally because a resolver closes over that document's registered folders
 *  — sharing one would leak one document's fonts into another.
 *
 *  Note: a plain <p> renders in TIMES, not Helvetica. The UA sheet declares
 *  `html { font-family: serif }` (cssua.ts) and font-family inherits, so
 *  `serif` is what an unstyled document computes. Browser-correct, and it will
 *  read as a regression to anyone comparing against zch2.4's tests, which all
 *  used a stub resolver returning Helvetica for every list.
 *
 *  Note: an unresolvable named family in a list with NO generic falls back to
 *  sans-serif. `font-family: Garamond` alone admits no principled answer, and
 *  the alternative is a name-to-class lookup table that can never be complete
 *  — the shape rebuild.ts already rejects for identifying /Info. Stated rather
 *  than guessed at, and asserted directly so it stays a decision. */

import type { Document } from './document.js';
import type { FamilyResolver } from './cssinline.js';
import type { ResolvedFamily } from './mdstyle.js';
import type { AuthoringFont } from './stamp.js';
import { resolveFamily } from './mdstyle.js';

/** CSS generic family keywords, to the Standard-14 face that stands in.
 *
 *  `cursive` and `fantasy` are deliberately absent: neither has a Standard-14
 *  analogue, and mapping one would be a guess dressed as a rule. They fall to
 *  the default with every other unmatched name. */
const GENERIC: Record<string, AuthoringFont> = {
  serif: 'Times-Roman',
  'ui-serif': 'Times-Roman',
  'sans-serif': 'Helvetica',
  'ui-sans-serif': 'Helvetica',
  'system-ui': 'Helvetica',
  monospace: 'Courier',
  'ui-monospace': 'Courier',
};

/** Where an unresolvable list with no generic lands. See the note above. */
const DEFAULT_FACE: AuthoringFont = 'Helvetica';

/** One resolver per document, so repeated AddHtml calls share a warm memo. */
const byDocument = new WeakMap<Document, FamilyResolver>();

function resolveList(doc: Document, families: string[]): ResolvedFamily {
  const named: string[] = [];
  let generic: AuthoringFont | undefined;
  for (const f of families) {
    const g = GENERIC[f.toLowerCase()];
    if (g !== undefined) { generic ??= g; continue; }
    named.push(f);
  }
  if (named.length > 0) {
    const fam = doc.LoadFontFamily(named);
    if (fam !== undefined) return resolveFamily(fam);
  }
  return resolveFamily(generic ?? DEFAULT_FACE);
}

/** The default font bridge for `doc`: registered families first, then the
 *  Standard-14 generics. Memoized per document and per family list. */
export function documentFamilyResolver(doc: Document): FamilyResolver {
  const already = byDocument.get(doc);
  if (already !== undefined) return already;
  const memo = new Map<string, ResolvedFamily>();
  const resolver: FamilyResolver = (families: string[]): ResolvedFamily => {
    // NUL joins rather than a space, and that is not pedantry: under a space
    // ['Alpha', 'Sans'] and ['Alpha Sans'] key IDENTICALLY — a two-family
    // chain and one two-word family, which resolve differently.
    const key = families.join('\u0000');
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const out = resolveList(doc, families);
    memo.set(key, out);
    return out;
  };
  byDocument.set(doc, resolver);
  return resolver;
}
