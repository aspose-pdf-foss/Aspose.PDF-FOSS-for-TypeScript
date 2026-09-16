/** The vocabulary every PDF/UA rule shares: which part is being validated, the
 *  context a rule reads, the rule signature itself, and how a rule cites its
 *  clause.
 *
 *  **Invariant, and it is FORCED rather than tidy.** This lived in
 *  `structvalidate.ts` until `q7hc.4.2`, which added a second rules module
 *  (`uaannot.ts`, clauses 8.9 and 8.10). `structvalidate.ts` must import that
 *  module's rules BY VALUE to append them to `RULES`, and that module must
 *  import `uaClause` BY VALUE to cite its clauses — which is a 2-cycle, and
 *  `test/import-cycles.test.ts` asserts the exact set of those. Extracting the
 *  shared vocabulary to a leaf both import is the move `structtype.ts` and
 *  `numbertree.ts` each already made, for exactly this reason.
 *
 *  **Invariant:** a near-LEAF. `Document`, `StructElement`, `StructTreeRoot`,
 *  `PdfDict` and `ValidationIssue` arrive as TYPES only. It gained two VALUE
 *  imports in `q7hc.4.4` — `validatectx.js` and `metadata.js` — for the two
 *  helpers below; neither imports back, so it still closes no edge, and
 *  `test/import-cycles.test.ts` is the fence. @internal */
import type { Document } from './document.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { isString, type PdfDict, type PdfObject } from './types.js';
import type { ValidationIssue } from './validation.js';
import { type Ctx } from './validatectx.js';
import { decodePdfText } from './metadata.js';

/** Which part of ISO 14289 to validate against: 1 (PDF/UA-1) or 2 (PDF/UA-2,
 *  the PDF 2.0 sibling). */
export type PdfUaPart = 1 | 2;

export interface WalkedNode {
  element: StructElement;
  parentType: string | null;
  /** The parent ELEMENT, not just its type — the MathML rule needs the parent's
   *  NAMESPACE, which a type string cannot supply. */
  parent: StructElement | null;
}

/** PDF/UA run context: the document, its catalog, the target part, and the tree
 *  walk every structure rule shares. */
export interface UaCtx {
  doc: Document;
  catalog: PdfDict;
  part: PdfUaPart;
  tree: StructTreeRoot;
  nodes: WalkedNode[];
}

export type Rule = (ctx: UaCtx) => ValidationIssue[];

/** The ISO clause to cite for this part. Each rule states its own numbers,
 *  because the same test is numbered differently in the two standards —
 *  `partClause`'s rule in pdfavalidate.ts, for pdfavalidate.ts's reason. */
export function uaClause(part: PdfUaPart, cl: { 1?: string; 2?: string }): string {
  return `ISO 14289-${part} §${part === 1 ? cl[1] : cl[2]}`;
}

/** A `validatectx.Ctx` over this run, so the shared object and font walks can
 *  be reused. Memoized on the `UaCtx`, so `enumerateFonts` and the all-objects
 *  scan are each walked once per validation however many rules ask.
 *
 *  **Invariant:** it lives HERE, in the vocabulary every PDF/UA rule module
 *  shares, because THREE now need it — `uafont.ts`, `uatext.ts` and
 *  `uadoc.ts` — and none may import another. Three copies is how three rule
 *  modules come to disagree about which objects a document has. */
const CTX = new WeakMap<UaCtx, Ctx>();
export function vctx(ctx: UaCtx): Ctx {
  let c = CTX.get(ctx);
  if (c === undefined) {
    c = {
      doc: ctx.doc, catalog: ctx.catalog,
      R: (o: PdfObject | undefined) => ctx.doc.resolve(o),
      cache: new Map<string, unknown>(),
    };
    CTX.set(ctx, c);
  }
  return c;
}

/** A PDF string entry's text, or `undefined` when the key is absent or holds
 *  something that is not a string.
 *
 *  **Invariant:** it decodes through `metadata.ts`'s `decodePdfText`, the one
 *  owner of the PDFDocEncoding/UTF-16 rule — CLAUDE.md records `structns.ts`
 *  reusing it for exactly this reason. Decoding by hand here would be a second
 *  reading of the same bytes, and the two would differ on every UTF-16 value.
 *
 *  Here rather than in a rule module for `vctx`'s reason: `uatext.ts` and
 *  `uadoc.ts` both ask it and neither may import the other. */
export function textOf(ctx: UaCtx, o: PdfObject | undefined): string | undefined {
  const v = ctx.doc.resolve(o);
  return isString(v) ? decodePdfText(v.bytes) : undefined;
}
