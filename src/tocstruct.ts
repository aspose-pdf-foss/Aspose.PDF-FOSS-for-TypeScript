// The /TOC + /TOCI structure subtree behind `page.AddTOC({ tagged: true })`
// (issue 1gg0.5). Structure only: no measurement, no painting. tocrender.ts
// calls beginRow before a row's stamps and finishRow after its link annotation,
// which is why this is its own module — threading a level stack through
// paintRow would blur "where the ink goes".
import type { Document } from './document.js';
import type { Annotation } from './annotation.js';
import type { StructElement } from './struct.js';

/** The last child of `e` whose structure type is `type`, if any. */
function lastChildOfType(e: StructElement, type: string): StructElement | undefined {
  const kids = e.Children;
  for (let i = kids.length - 1; i >= 0; i--) if (kids[i].Type === type) return kids[i];
  return undefined;
}

export interface TocTaggerOptions {
  /** Whether rows carry link annotations; when false no /Link element is made
   *  and a row's content is tagged into its /Reference directly. */
  links: boolean;
  /** Element to append the /TOC under; a /TOC element is reused rather than
   *  nested. Default: the structure tree root. */
  structParent?: StructElement;
}

export class TocTagger {
  /** The root /TOC element this tagger fills. */
  readonly toc: StructElement;

  /** Open /TOC elements, shallowest first: stack[i] is the TOC at depth i + 1. */
  private readonly stack: StructElement[];
  /** lastTOCI[i] is the most recent /TOCI appended to stack[i], if any. */
  private readonly lastTOCI: (StructElement | undefined)[] = [];
  /** The element the current row's content is tagged into. */
  private current: StructElement | undefined;

  constructor(doc: Document, private readonly opts: TocTaggerOptions) {
    const parent = opts.structParent;
    // A /TOC parent is continuation, not nesting: a manual-pagination loop hands
    // back the previous call's element so a three-page TOC is one TOC.
    const reuse = parent !== undefined && parent.Type === 'TOC';
    this.toc = reuse ? parent : (parent ?? doc.CreateStructTree()).Append('TOC');
    this.stack = [this.toc];
    if (reuse) this.resumeDepth();
  }

  /** Rebuild the level stack a previous call left open in a reused /TOC (issue
   *  1gg0.16), so a continuation whose first row is level 2+ reopens the nested
   *  /TOC instead of attaching at depth 1 beside it.
   *
   *  The state is recoverable from the tree, which is why nothing has to be
   *  serialized into AddTOCResult: a nested /TOC is only ever created under the
   *  *last* /TOCI of its parent, so descending that spine replays exactly the
   *  stack (and the lastTOCI at each level) the previous call ended with. */
  private resumeDepth(): void {
    const seen = new Set<number>();
    if (this.toc.Ref !== undefined) seen.add(this.toc.Ref.num);
    for (let toc = this.toc; ;) {
      const toci = lastChildOfType(toc, 'TOCI');
      if (toci === undefined) return;
      this.lastTOCI[this.stack.length - 1] = toci;
      const nested = lastChildOfType(toci, 'TOC');
      // Refless: it could not be Appended to, and beginRow may only ever push
      // elements it can hang a /TOCI from. Already seen: a reused /TOC can come
      // from a document we did not author, whose /K may be cyclic — without this
      // the descent never terminates.
      if (nested?.Ref === undefined || seen.has(nested.Ref.num)) return;
      seen.add(nested.Ref.num);
      this.stack.push(nested);
      toc = nested;
    }
  }

  /** Open the row's subtree at `level` and return the element its content is
   *  tagged into: the /Link when links are on, else the /Reference. */
  beginRow(level: number): StructElement {
    // A row descends at most one level, and only when the current depth has a
    // /TOCI to hang the child /TOC from — so a 1 -> 3 jump, or a TOC whose first
    // row is level 3, clamps rather than inventing empty intermediate TOCIs.
    const open = this.stack.length;
    const maxDepth = open + (this.lastTOCI[open - 1] ? 1 : 0);
    const d = Math.min(Math.max(level, 1), maxDepth);
    if (d === open + 1) {
      this.stack.push(this.lastTOCI[open - 1]!.Append('TOC'));
    } else if (d < open) {
      this.stack.length = d;
      this.lastTOCI.length = d;   // drop stale deeper TOCIs
    }
    const toci = this.stack[d - 1].Append('TOCI');
    this.lastTOCI[d - 1] = toci;
    const reference = toci.Append('Reference');
    this.current = this.opts.links ? reference.Append('Link') : reference;
    return this.current;
  }

  /** Attach the row's link annotation (an OBJR) to the element beginRow opened. */
  finishRow(annotation: Annotation): void {
    if (this.current === undefined) throw new Error('finishRow before beginRow');
    this.current.AddAnnotation(annotation);
  }
}
