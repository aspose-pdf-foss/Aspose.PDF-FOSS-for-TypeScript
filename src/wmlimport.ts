/** The three `AddDocx` entry points' one implementation (`m2fp.5`) — the wiring
 *  and nothing else, `htmlflow.ts`'s shape: open the package, supply fonts and
 *  image bytes, hand the width down. The only module of the DOCX import that
 *  touches a Document.
 *
 *  **Invariant:** THE CALLER MUST PLACE WITH `paragraphSpacing: 0` — Word's
 *  spacing is carried on each element, and the engine ADDS paragraphSpacing
 *  between every pair. Word COLLAPSES adjacent spacing to max(after, before)
 *  (test/spacing-oracle.test.ts), which wmlflow.ts emits as
 *  spaceBefore = max(0, before - previousAfter). */
import type { Document } from './document.js';
import type { FamilyResolver } from './cssinline.js';
import type { FlowElement, Compromise } from './flowelement.js';
import { openDocx, type OpenedDocx } from './wmlread.js';
import { wmlElements, type DocxSkipped, type DocxNoteOptions, type WmlFlowEnv } from './wmlflow.js';
import { documentFamilyResolver } from './cssfont.js';

export type { DocxSkipped } from './wmlflow.js';

export interface DocxFlowOptions {
  /** Override the font bridge. Default: the document's registered families,
   *  then a generic chosen by the DOCX font table's w:family. */
  resolveFamily?: FamilyResolver;
  /** Placement-time compromises (`'squeezed'`, `'overflow'`,
   *  `'image:scaled-to-fit'`), for a Flow whose AddDocx returns before Render.
   *  doc.AddDocx and page.AddDocx fold them into `skipped` themselves. */
  onSkipped?: (s: DocxSkipped) => void;
}
export interface DocxFlowResult { skipped: DocxSkipped[] }
export interface AddDocxResult extends DocxFlowResult { usedHeight: number; remainder: FlowElement[] }
/** An opened package, so doc.AddDocx reads its page geometry once and hands the
 *  same package to its flow. @internal */
export interface OpenedDocxSource { opened: OpenedDocx }

export function checkDocxOptions(o: DocxFlowOptions): void {
  if (o.resolveFamily !== undefined && typeof o.resolveFamily !== 'function')
    throw new TypeError('resolveFamily must be a function');
  if (o.onSkipped !== undefined && typeof o.onSkipped !== 'function')
    throw new TypeError('onSkipped must be a function');
}

export function openDocxSource(doc: Document, bytes: Uint8Array): OpenedDocxSource {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('the DOCX source must be a Uint8Array');
  return { opened: openDocx(bytes, doc.loadLimits) };
}

export function docxElements(
  doc: Document, src: Uint8Array | OpenedDocxSource, width: number, options: DocxFlowOptions = {},
): { segments: FlowElement[][]; skipped: DocxSkipped[]; notes: DocxNoteOptions; cited: boolean } {
  checkDocxOptions(options);
  const { opened } = src instanceof Uint8Array ? openDocxSource(doc, src) : src;
  const resolver = options.resolveFamily ?? documentFamilyResolver(doc);
  const env: WmlFlowEnv = {
    family: (name) => {
      const generic = name === undefined ? 'serif' : opened.fontClass(name) ?? 'sans-serif';
      const family = resolver(name === undefined ? [generic] : [name, generic]);
      return { family, resolved: name !== undefined && typeof family.regular !== 'string' };
    },
    image: (part) => opened.readPart(part),
  };
  const out = wmlElements(opened.doc, width, env);
  if (options.onSkipped !== undefined) reportCompromises(out.segments.flat(), options.onSkipped);
  return out;
}

const COMPROMISE: Readonly<Record<Compromise, string>> = {
  squeezed: 'squeezed', overflow: 'overflow', scaled: 'image:scaled-to-fit',
};

/** A one-shot report per element and kind — mdflow.ts's reportCompromises,
 *  in DocxSkipped's shape. The kind is stated EXPLICITLY as degraded: these
 *  drew, and kindOf would call 'image:scaled-to-fit' dropped by its prefix. */
function reportCompromises(elements: FlowElement[], sink: (s: DocxSkipped) => void): void {
  for (const el of elements) {
    if (el.onCompromise !== undefined) continue;
    const done = new Set<Compromise>();
    el.onCompromise = (how) => {
      if (done.has(how)) return;
      done.add(how);
      sink({ name: COMPROMISE[how], count: 1, kind: 'degraded' });
    };
  }
}
