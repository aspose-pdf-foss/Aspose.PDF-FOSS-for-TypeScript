/** An inline formatting context's content, lowered to the TextRun model.
 *
 *  Invariant: a PURE LEAF over cssprop.js, textdecor.js, mdstyle.js,
 *  preformat.js and htmldom.js — all for types or pure functions. No
 *  Document, no Page, no PDF object module, no `node:` import.
 *
 *  Invariant: it adds NO wrapping engine. CLAUDE.md's rule is that there is
 *  ONE, `layoutRuns` in layout.ts, and that a second wrapper lets a box
 *  measure one way and paint another. So an IFC lowers to TextRun[] and
 *  layoutRuns wraps it — which also inherits justification, per-line leading
 *  and runlink.ts's link-rect geometry for free.
 *
 *  Invariant: `resolveFamily` is INJECTED. ComputedStyle.fontFamily is a list
 *  of family NAMES and TextRun.font is an AuthoringFont; turning one into the
 *  other needs Document.LoadFontByName, which this module may not import.
 *  zch2.5 supplies the real resolver.
 *
 *  Invariant: adjacent pieces of identical style MERGE into one run. A run per
 *  DOM node gives layoutRuns three runs for `a<span>b</span>c` where one is
 *  right, and moves bytes against the plain-string path. The merge key folds
 *  in the LINK DESTINATION, because `[a](x)[b](y)` styles identically on both
 *  sides and merging would point the whole phrase at the second URI — output
 *  that renders perfectly and links wrongly. mdruns.ts records the same rule. */

import type { HtmlElement, HtmlNode } from './htmldom.js';
import type { ComputedStyle, UnsupportedDeclaration } from './cssprop.js';
import type { Color } from './cssvalue.js';
import { fixedPx } from './cssvalue.js';
import type { TextRun } from './textdecor.js';
import type { ResolvedFamily } from './mdstyle.js';
import { faceFor } from './mdstyle.js';
import { preformat } from './preformat.js';
import type { NotRendered } from './htmlreport.js';
import { elementPolicy, selectedOptionText } from './htmlreport.js';

export type FamilyResolver = (families: string[]) => ResolvedFamily;

export interface AtomicInline {
  /** 'svg' is an inline <svg>, rendered through the SVG importer (zch2.12).
   *  It is an atomic rather than a box kind because an <svg> is display:inline
   *  by DEFAULT and so never reaches cssbox.ts's boxFor. */
  kind: 'image' | 'svg';
  el: HtmlElement;
  style: ComputedStyle;
  /** The index of the run this sits BEFORE; `runs.length` means at the end. */
  beforeRun: number;
}

export interface InlineContent { runs: TextRun[]; atomics: AtomicInline[] }

/** Tabs expand to this many columns under `pre`. CSS's `tab-size` initial. */
const TAB_WIDTH = 8;

/** The `vertical-align` values zch2.11 implements, and only for an ATOMIC.
 *  `middle` is absent: CSS defines it against half the x-height, which the AFM
 *  tables do not expose. */
const ATOMIC_ALIGNS: readonly string[] = ['baseline', 'top', 'bottom'];

/** fontmatch.ts's bold slot is `weight >= 600`, so a family shipping Semibold
 *  and no 700 still has a bold face. One rule, not two. */
const BOLD_AT = 600;

function rgbOf(c: Color): [number, number, number] {
  return [c.rgb[0], c.rgb[1], c.rgb[2]];
}

/** Apply CSS white-space processing to one text node's data. */
function processText(data: string, ws: ComputedStyle['whiteSpace']): string {
  if (ws === 'pre' || ws === 'pre-wrap') return preformat(data, TAB_WIDTH);
  if (ws === 'pre-line') {
    // Spaces and tabs collapse; newlines survive as hard breaks.
    return data.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
  }
  // normal and nowrap: every run of whitespace becomes one space. `nowrap`
  // differs only in whether a line may BREAK there, which is layoutRuns'
  // question and not this module's.
  return data.replace(/\s+/g, ' ');
}

/** The styling in force at a point in the inline tree. */
interface State {
  style: ComputedStyle;
  link: string | undefined;
}

/** A run's identity. Two adjacent pieces merge when these agree. */
function keyOf(r: TextRun): string {
  return JSON.stringify([
    r.font, r.fontSize, r.color, r.underline, r.strikethrough,
    r.background, r.link,
  ]);
}

function runFor(
  text: string, s: State, resolveFamily: FamilyResolver,
  el: HtmlElement | null, unsupported: UnsupportedDeclaration[],
): TextRun {
  const st = s.style;
  const family = resolveFamily(st.fontFamily);
  const run: TextRun = {
    text,
    font: faceFor(family, st.fontWeight >= BOLD_AT, st.fontStyle !== 'normal'),
    fontSize: st.fontSize,
    color: rgbOf(st.color),
  };
  // TextRun.color has no alpha. Flatten and RECORD, rather than dropping the
  // colour or inventing a field every existing caller would have to ignore.
  if (st.color.a < 1) {
    unsupported.push({
      el, property: 'color', value: `alpha ${String(st.color.a)}`,
      reason: 'unparsable-value',
    });
  }
  if (st.textDecorationLine.includes('underline')) run.underline = true;
  if (st.textDecorationLine.includes('line-through')) run.strikethrough = true;
  if (st.textDecorationLine.includes('overline')) {
    unsupported.push({
      el, property: 'text-decoration-line', value: 'overline',
      reason: 'unparsable-value',
    });
  }
  if (st.backgroundColor.a > 0) run.background = { color: rgbOf(st.backgroundColor) };
  if (s.link !== undefined) run.link = s.link;
  return run;
}

/** Does this inline box state padding a browser would paint and we ignore?
 *
 *  The INITIAL value is 0 on every side, so only a stated one reports —
 *  otherwise every element in every document earns a record and the report
 *  stops being read. A percentage resolves against a containing block this
 *  module does not have, so `fixedPx` returning undefined counts as stated:
 *  we ignore it either way. */
function hasInlineBox(st: ComputedStyle): boolean {
  for (const v of [st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft]) {
    const px = fixedPx(v);
    if (px === undefined || px !== 0) return true;
  }
  return false;
}

export function inlineContentOf(
  nodes: HtmlNode[],
  parentStyle: ComputedStyle,
  styles: Map<HtmlElement, ComputedStyle>,
  resolveFamily: FamilyResolver,
  unsupported: UnsupportedDeclaration[],
  report: NotRendered[],
): InlineContent {
  const runs: TextRun[] = [];
  const atomics: AtomicInline[] = [];

  /** An atomic is a MERGE BARRIER, and that is not cosmetic. An atomic records
   *  `beforeRun: runs.length`, so the text after it must land in a NEW run —
   *  otherwise `a<img>b` merges into the single run `ab`, whose index 0 the
   *  image then claims to precede, and the picture moves to the front of the
   *  line. The two texts are identically styled precisely when this bites. */
  let barrier = false;

  const push = (text: string, s: State, el: HtmlElement | null): void => {
    if (text === '') return;
    const run = runFor(text, s, resolveFamily, el, unsupported);
    const last = runs[runs.length - 1];
    if (!barrier && last !== undefined && keyOf(last) === keyOf(run)) {
      last.text += text;
      return;
    }
    barrier = false;
    runs.push(run);
  };

  const visit = (n: HtmlNode, s: State): void => {
    if (n.kind === 'text') { push(processText(n.data, s.style.whiteSpace), s, null); return; }
    if (n.kind !== 'element') return;               // comment, doctype

    const st = styles.get(n) ?? s.style;
    if (st.display === 'none') return;              // no box, no text, no margin

    if (n.ns === 'html' && n.name === 'input') {
      // A browser draws the VALUE in the box, and before zch2.7 we drew
      // nothing at all. Two refusals: `hidden` is hidden by definition, and
      // `password` must never reach a content stream — CLAUDE.md records that
      // rule under formfield.ts, because flattening bakes the plaintext into
      // permanent page content where no viewer will ever mask it again. An
      // HTML password value is the same disclosure by a different route.
      const type = (n.attrs.get('type') ?? 'text').toLowerCase();
      const secret = type === 'hidden' || type === 'password';
      report.push({
        el: n, kind: secret ? 'dropped' : 'degraded',
        construct: 'input', detail: type,
      });
      if (secret) return;
      push(n.attrs.get('value') ?? '', { style: st, link: s.link }, n);
      return;
    }
    if (n.ns === 'html' && n.name === 'select') {
      // Its children are never visited, which is how the unselected options
      // are suppressed without a policy entry saying so a second time.
      report.push({ el: n, kind: 'degraded', construct: 'select' });
      push(selectedOptionText(n) ?? '', { style: st, link: s.link }, n);
      return;
    }

    // What HTML says about this element's children. Applied here AND in
    // cssbox.ts's boxFor, because the two walks are separate: an element is
    // inline by default and reaches this one, but `display: block` routes it
    // to the other, and a policy applied in only one is silent for the other.
    // An inline <svg> is ONE atomic: its subtree is rendered by the SVG
    // importer, never walked as content — which is what keeps its <text> out
    // of the paragraph flow, the leak zch2.7 closed by suppressing it.
    if (n.ns === 'svg' && n.name === 'svg') {
      atomics.push({ kind: 'svg', el: n, style: st, beforeRun: runs.length });
      barrier = true;
      return;
    }

    const policy = elementPolicy(n);
    if (policy !== undefined) {
      report.push({ el: n, kind: policy.kind, construct: policy.construct });
      if (policy.content === 'suppress') return;
    }

    if (n.ns === 'html' && n.name === 'br') {
      // layoutRuns breaks on a newline, so a hard break needs no run kind of
      // its own — the rule mdruns.ts already follows.
      push('\n', s, n);
      return;
    }
    if (n.ns === 'html' && n.name === 'img') {
      // TWO rules where the block below has one, and both are needed. An
      // ATOMIC implements baseline/top/bottom (zch2.11), so reporting those
      // for one would be false; a NON-atomic inline still reports every
      // non-baseline value, because for text none of them are implemented.
      // A single widened rule satisfies either fixture alone.
      if (!ATOMIC_ALIGNS.includes(st.verticalAlign)) {
        report.push({
          el: n, kind: 'degraded', construct: 'vertical-align',
          detail: st.verticalAlign,
        });
      }
      atomics.push({ kind: 'image', el: n, style: st, beforeRun: runs.length });
      barrier = true;
      return;
    }

    // Three properties this stack COMPUTES and never reads. They get no
    // backstop from the cascade's unknown-property report, which fires only
    // for a name outside the 43 longhands — so without these they are silent
    // by omission rather than by decision.
    //
    // `visit` is reached only for non-block-level nodes (contentOf routes
    // block-level children to boxFor), so no display check is needed here:
    // whatever arrives is an inline-level box whose padding is ignored.
    if (st.display === 'inline-block')
      report.push({ el: n, kind: 'degraded', construct: 'inline-block' });
    if (st.verticalAlign !== 'baseline') {
      report.push({
        el: n, kind: 'degraded', construct: 'vertical-align',
        detail: st.verticalAlign,
      });
    }
    if (hasInlineBox(st))
      report.push({ el: n, kind: 'degraded', construct: 'inline-box', detail: 'padding' });

    const rawHref = n.ns === 'html' && n.name === 'a' ? n.attrs.get('href') : undefined;
    // A FRAGMENT-only href gets no link. A /URI action pointing at "#intro"
    // is a link that looks clickable and does nothing in a viewer, which is
    // worse than no link — "renders perfectly and links wrongly" is the
    // failure this stack already guards against for merged runs. Resolving
    // one needs an id-to-destination map built after placement.
    //
    // Reported on the CONSTRUCT report rather than on `unsupported`, which is
    // where zch2.6 parked it: a link we declined to make is a construct we did
    // not render, not a declaration we could not parse. zch2.6 recorded that
    // zch2.7 could widen it, and this is that widening.
    const fragment = rawHref !== undefined && rawHref.startsWith('#');
    if (fragment) {
      report.push({
        el: n, kind: 'degraded', construct: 'link', detail: rawHref,
      });
    }
    const href = fragment ? undefined : rawHref;
    const next: State = {
      style: st,
      link: href !== undefined && href !== '' ? href : s.link,
    };
    for (const c of n.children) visit(c, next);
  };

  for (const n of nodes) visit(n, { style: parentStyle, link: undefined });

  // CSS strips whitespace at the start and end of a line. Only the ends of the
  // whole context are knowable here; the interior ones are layoutRuns'.
  //
  // A PLAIN SPACE trim, and that is what makes it safe under `pre`:
  // preformat has already turned a leading run of spaces into U+00A0, which
  // `/^ +/` does not match, so indentation survives a trim that prose needs.
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (first !== undefined) first.text = first.text.replace(/^ +/, '');
  if (last !== undefined) last.text = last.text.replace(/ +$/, '');

  return { runs: runs.filter((r) => r.text !== ''), atomics };
}
