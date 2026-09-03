/** What of a piece of text the resolved face cannot draw (zch2.14).
 *
 *  Invariant: a PURE LEAF. Value imports are `encoding.js` and
 *  `embeddedfont.js`; `AuthoringFont`, `TextRun` and `FontDriver` arrive as
 *  types, which is what textdecor.ts already does. No Document, no Page, no
 *  PDF object module, no `node:` import — so every rule below is testable
 *  from a string and a font with no PDF built. It never throws.
 *
 *  Invariant: the per-character question goes through each owner's OWN
 *  predicate — EmbeddedFont.probe and encodeWinAnsi — never a reach-through
 *  to font.sfnt.cmapLookup, which stamp.ts does and a leaf should not.
 *
 *  Invariant: STRUCTURE characters are excluded, and this is the whole
 *  feature rather than a detail. Measured: encodeWinAnsi drops \n, \r and \t,
 *  so `a\nb` probes 2 of 3 codepoints — without the exclusion every code
 *  block and every hard-broken paragraph in every document carries a report.
 *
 *  Invariant: a SHAPED block gets the all-or-nothing answer only. A shaper
 *  legitimately consumes joiners and format characters (ZWJ, ZWNJ, the bidi
 *  marks), so a per-character scan reports loss where the shaper did its job.
 *
 *  Note the DIFFERENCE from `drawsNothing`, and it is why they are two
 *  functions rather than one. `coverageOf` answers "what did the author ask
 *  for that will not appear", so it skips structure. `drawsNothing` answers
 *  the painter's question, "will any bytes be emitted", for which a lone
 *  newline IS nothing. Collapsing them sends an empty line to the painter. */

import { EmbeddedFont } from './embeddedfont.js';
import { encodeWinAnsi } from './encoding.js';
import type { AuthoringFont } from './stamp.js';
import type { TextRun } from './textdecor.js';
import type { FontDriver } from './layout.js';

/** Characters the layout engine consumes as structure rather than ink. */
const STRUCTURE = new Set(['\n', '\r', '\t']);

/** Cap on `lost`, so a page of Cyrillic does not become a report field. */
const LOST_CAP = 32;

/** What a face will not draw of the text it was given. */
export interface Undrawable {
  /** The DISTINCT undrawable characters, in first-appearance order, capped. */
  lost: string;
  /** True when NOTHING drew: the block is blank, not merely thinner. */
  all: boolean;
}

/** Can `font` draw this single character? */
function canDraw(font: AuthoringFont, ch: string): boolean {
  return font instanceof EmbeddedFont
    ? font.probe(ch) > 0
    : encodeWinAnsi(ch).length > 0;
}

/** The painter's question: will showing `text` through `driver` emit anything?
 *  Exported so stamp.ts's early returns and this module state it once. */
export function drawsNothing(text: string, driver: FontDriver): boolean {
  return driver.probe(text) === 0;
}

/** What `content` asks for that its face(s) cannot draw, or `undefined` when
 *  every character draws. A `TextRun` is judged against its own `font`, falling
 *  back to `blockFont` — the rule resolveRuns already applies, and a second
 *  rule here would report a run against a face it is not drawn in. */
export function coverageOf(
  content: string | TextRun[], blockFont: AuthoringFont, shaped: boolean,
): Undrawable | undefined {
  const parts = typeof content === 'string'
    ? [{ text: content, font: blockFont }]
    : content.map((r) => ({ text: r.text, font: r.font ?? blockFont }));

  let drew = false;
  const seen = new Set<string>();
  const lost: string[] = [];
  for (const p of parts) {
    for (const ch of p.text) {
      if (STRUCTURE.has(ch)) continue;
      if (canDraw(p.font, ch)) { drew = true; continue; }
      if (seen.has(ch)) continue;
      seen.add(ch);
      if (lost.length < LOST_CAP) lost.push(ch);
    }
  }
  if (lost.length === 0) return undefined;
  // A shaped block reports only that it drew nothing at all.
  if (drew && shaped) return undefined;
  return { lost: lost.join(''), all: !drew };
}
