/** Markdown inlines to {@link TextRun}s.
 *
 *  Pure: no Document, no PDF objects, no layout. It turns an emphasis tree into
 *  the flat run list gl6o.3.1 made the Flow text engine carry. */

import type { MdInline } from './mdast.js';
import type { TextRun } from './textdecor.js';
import { faceFor, type ResolvedFamily, type ResolvedMarkdownStyle } from './mdstyle.js';

/** The block a run list is being built for: a heading and a paragraph select
 *  faces from different families and scale inline code differently. */
export interface RunContext {
  family: ResolvedFamily;
  /** The block's own font size, which an inline code span scales against. */
  fontSize: number;
}

/** The styling in force at a point in the inline tree. */
interface InlineState {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  /** The destination in force, or undefined outside a link. */
  link: string | undefined;
}

const START: InlineState = {
  bold: false, italic: false, code: false, strike: false, link: undefined,
};

/** A key identifying a state, so adjacent pieces of identical style merge into
 *  one run rather than one run per AST node.
 *
 *  The destination is part of that identity: `[a](x)[b](y)` styles identically
 *  on both sides, so a key that ignored it would merge the two into one run and
 *  point the whole phrase at the second URI — output that renders perfectly and
 *  links wrongly. */
const stateKey = (s: InlineState): string =>
  `${+s.bold}${+s.italic}${+s.code}${+s.strike} ${s.link ?? ''}`;

/** The run properties a state implies.
 *
 *  Every property the state does NOT change is left unset, so it inherits the
 *  block's. Plain text therefore yields a run with nothing but `text` — the
 *  closest a run list gets to the string path, and what keeps an ordinary
 *  Markdown paragraph from restating the paragraph's own font on every run. */
function runProps(
  s: InlineState, style: ResolvedMarkdownStyle, ctx: RunContext,
): Omit<TextRun, 'text'> {
  const r: Omit<TextRun, 'text'> = {};
  if (s.code) {
    r.font = style.code.font;
    r.fontSize = ctx.fontSize * style.code.sizeRatio;
    if (style.code.inlineBackground !== false) r.background = style.code.inlineBackground;
    if (style.code.color !== undefined) r.color = style.code.color;
  } else {
    const face = faceFor(ctx.family, s.bold, s.italic);
    if (face !== ctx.family.regular) r.font = face;
  }
  if (s.strike) r.strikethrough = true;
  if (s.link !== undefined) {
    r.color = style.link.color;
    if (style.link.underline) r.underline = true;
    // An empty destination (CommonMark accepts `[text]()`) styles but does not
    // link: a /URI pointing nowhere is worse than no annotation at all.
    // `inlineRuns` names it in `skipped`.
    if (s.link !== '') r.link = s.link;
  }
  return r;
}

/** Map `nodes` to runs. Anything that cannot be rendered names itself in
 *  `skipped` and still contributes its text where it has any — the rule
 *  svgdraw.ts sets for content it cannot draw fully. */
export function inlineRuns(
  nodes: MdInline[], style: ResolvedMarkdownStyle, ctx: RunContext, skipped: string[],
): TextRun[] {
  const out: TextRun[] = [];
  let lastKey: string | undefined;

  const push = (text: string, s: InlineState): void => {
    if (text === '') return;
    const k = stateKey(s);
    if (k === lastKey) { out[out.length - 1].text += text; return; }
    out.push({ text, ...runProps(s, style, ctx) });
    lastKey = k;
  };

  const walk = (ns: MdInline[], s: InlineState): void => {
    for (const n of ns) {
      switch (n.type) {
        case 'text': push(n.value, s); break;
        // A soft break is a space: the wrapping engine decides where the line
        // actually ends. A hard break is a newline, which layoutRuns already
        // treats as a paragraph boundary.
        case 'softbreak': push(' ', s); break;
        case 'linebreak': push('\n', s); break;
        case 'emph': walk(n.children, { ...s, italic: true }); break;
        case 'strong': walk(n.children, { ...s, bold: true }); break;
        case 'strikethrough': walk(n.children, { ...s, strike: true }); break;
        case 'code': push(n.value, { ...s, code: true }); break;
        case 'link':
          if (n.destination === '') skipped.push('link');
          walk(n.children, { ...s, link: n.destination });
          break;
        // An image reached inline (rather than alone in its paragraph, which
        // mdflow.ts lifts to a block) renders as its alt text: an inline raster
        // at line height is a layout feature nothing here needs.
        case 'image':
          skipped.push(`image:${n.destination}`);
          walk(n.children, s);
          break;
        case 'html_inline': skipped.push('html_inline'); break;
      }
    }
  };

  walk(nodes, START);
  return out;
}

/** The characters of `nodes` with all styling dropped — an image's alt text, and
 *  a heading's plain form. */
export function plainText(nodes: MdInline[]): string {
  let s = '';
  const walk = (ns: MdInline[]): void => {
    for (const n of ns) {
      switch (n.type) {
        case 'text': s += n.value; break;
        case 'code': s += n.value; break;
        case 'softbreak': case 'linebreak': s += ' '; break;
        case 'emph': case 'strong': case 'strikethrough':
        case 'link': case 'image':
          walk(n.children); break;
        case 'html_inline': break;
      }
    }
  };
  walk(nodes);
  return s;
}
