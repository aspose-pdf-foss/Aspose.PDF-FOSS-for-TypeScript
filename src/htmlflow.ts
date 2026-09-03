/** The three HTML entry points' one implementation.
 *
 *  This module owns the WIRING and nothing else: it parses when given a
 *  string, supplies a font resolver, and hands the width down. Flow's column
 *  engine and flowplace.ts's rect placer both take the FlowElement[] it
 *  returns, which is what makes three entry points cost one implementation —
 *  mdflow.ts's shape for mdflow.ts's reason.
 *
 *  Invariant: it takes a Document and a WIDTH where markdownElements takes
 *  neither, and both are forced. Fonts come from doc.LoadFontFamily; and
 *  zch2.4 resolves boxes at BUILD time, because three call sites read
 *  spaceBefore before place() ever runs (flowplace.ts:63, flow.ts:1298, and
 *  flow.ts:1330's keep-with-next lookahead), so a gap computed later can never
 *  reach the engine. A Markdown element carries no resolved geometry and is
 *  width-independent until it places.
 *
 *  Invariant: the width is POSITIONAL rather than an option, so that no caller
 *  of the three entry points passes one at all — flow supplies its
 *  columnWidth, page supplies rect[2], and doc builds a Flow and delegates. A
 *  width in the shared options bag could be passed twice and disagree.
 *
 *  Invariant: the option bag is HtmlFlowOptions, NOT HtmlOptions — html.ts
 *  already exports that for ToHtml, the opposite direction. mdexport.ts
 *  records the same hazard for MarkdownExportOptions against MarkdownOptions,
 *  and notes the collision is a compile error only because both are exported
 *  from index.ts.
 *
 *  Invariant: THE CALLER MUST PLACE WITH `paragraphSpacing: 0`. zch2.4 puts
 *  the whole collapsed margin in spaceBefore, and flow.ts ADDS
 *  `spaceAfter + paragraphSpacing + spaceBefore`. Measured: both
 *  normalizeFlowOptions and page.AddMarkdown's own option already default it
 *  to 0, so the contract holds for every caller who says nothing. */

import type { Document } from './document.js';
import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import type { UnsupportedDeclaration } from './cssprop.js';
import type { FamilyResolver } from './cssinline.js';
import type { NotRendered } from './htmlreport.js';
import type { FlowElement } from './flowelement.js';
import { parseHtml } from './htmltree.js';
import { elementFloat } from './flowfloat.js';
import { buildSvgForm } from './svgembed.js';
import { lowerHtml } from './cssflow.js';
import { documentFamilyResolver } from './cssfont.js';

/** Options shared by the three `AddHtml` entry points. */
export interface HtmlFlowOptions {
  /** Override the font bridge. Default: the document's registered families
   *  first, then the Standard-14 generics — see cssfont.ts. */
  resolveFamily?: FamilyResolver;
  /** Supply the bytes for an `<img src>`. `data:` URIs are decoded without
   *  this; anything else is the caller's, which is how this library renders
   *  pictures while touching neither `fs` nor the network. Return `undefined`
   *  for a src you cannot resolve: the image is reported in `skipped` and the
   *  rest of the document still renders. Mirrors mdflow.ts's `resolveImage` in
   *  pattern rather than arity — that one takes Markdown's
   *  (destination, title), this one HTML's (src, alt). */
  resolveImage?: (src: string, alt: string) => Uint8Array | undefined;
  /** Called for a construct the engine could only place by compromising —
   *  scaling an over-tall image, drawing an element past the column bottom, or
   *  laying a float out in flow (`zch2.16`). These are PLACEMENT-time facts, so
   *  `doc.AddHtml` and `page.AddHtml` fold them into the `skipped` they return
   *  and a caller needs this only for a `Flow`, whose `AddHtml` returns before
   *  `Render` runs. */
  onNotRendered?: (r: NotRendered) => void;
}

/** What every HTML entry point reports. */
export interface HtmlFlowResult {
  /** Every construct that did not render as the source specified, in report
   *  order. `kind` separates `dropped` (nothing drawn) from `degraded`
   *  (drawn, but not as specified); `describeNotRendered` gives the flat
   *  string form for a caller that only logs.
   *
   *  ORDER is by PHASE, then document order within a phase: everything found
   *  while BUILDING boxes precedes everything found while LOWERING them,
   *  because each walks the whole tree. A single global document order would
   *  need a preorder index on every element carried on every record, for a
   *  guarantee no caller has asked for. */
  skipped: NotRendered[];
  /** Declarations the cascade could not use, for a caller reporting what it
   *  could not render. */
  unsupported: UnsupportedDeclaration[];
}

/** What {@link htmlElements} produced. */
export interface HtmlElements extends HtmlFlowResult {
  /** Ready for a Flow or for `placeElements` — place with
   *  `paragraphSpacing: 0`. */
  elements: FlowElement[];
}

/** What {@link Page.AddHtml} reports. */
export interface AddHtmlResult extends HtmlFlowResult {
  /** Vertical space consumed, from the rect's top edge. */
  usedHeight: number;
  /** Elements that did not fit, ready to pass to `placeElements` — `[]` when
   *  everything fit. */
  remainder: FlowElement[];
}

/** Map an HTML document to flow elements against a containing width in POINTS. */
export function htmlElements(
  doc: Document,
  src: string | HtmlDocument,
  width: number,
  options: HtmlFlowOptions = {},
): HtmlElements {
  if (options.resolveImage !== undefined && typeof options.resolveImage !== 'function')
    throw new TypeError('resolveImage must be a function');
  const root = typeof src === 'string' ? parseHtml(src) : src;
  return lowerHtml(root, {
    width,
    resolveFamily: options.resolveFamily ?? documentFamilyResolver(doc),
    resolveImage: options.resolveImage,
    // The adapter captures this Document. cssflow.ts is a pure leaf and cannot
    // construct one; placeElements needs one and paintAt takes only a Page.
    onNotRendered: options.onNotRendered,
    makeFloat: (els, w, spacing, onDegraded) =>
      elementFloat(doc, els, w, spacing, onDegraded),
    // The importer captures this Document. cssflow.ts is a pure leaf and
    // cannot construct one. Called at BUILD time, so its report reaches the
    // one AddHtml hands back before anything is drawn.
    renderSvg: (markup, size) => {
      try {
        return buildSvgForm(doc, new TextEncoder().encode(markup), size);
      } catch {
        // parseXml throws PdfParseError on markup it cannot read, and the
        // importer throws for a root that is not <svg>. A mapper whose whole
        // contract is that damage is a value must not let either out.
        return undefined;
      }
    },
  });
}

/** The first HTML child element of `nodes` with this tag name. */
function child(nodes: HtmlNode[], name: string): HtmlElement | undefined {
  for (const n of nodes)
    if (n.kind === 'element' && n.ns === 'html' && n.name === name) return n;
  return undefined;
}

/** The document's `<title>` text, or undefined when it has none or it is
 *  blank.
 *
 *  Blank rather than `''` on purpose: `SetMetadata({ title: '' })` would write
 *  an empty `/Info /Title`, which is worse than leaving the document's own
 *  title alone. `<title>` is RCDATA, so its children are text nodes. */
export function documentTitle(root: HtmlDocument): string | undefined {
  const html = child(root.children, 'html');
  const head = html === undefined ? undefined : child(html.children, 'head');
  const title = head === undefined ? undefined : child(head.children, 'title');
  if (title === undefined) return undefined;
  let text = '';
  for (const n of title.children) if (n.kind === 'text') text += n.data;
  text = text.trim();
  return text === '' ? undefined : text;
}
