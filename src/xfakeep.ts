/**
 * XFA adhesion and keep intact (`164g.14`; XFA 3.3 p. 291-292, 311-314,
 * 357-358), as Adobe Reader 26.1 applies them -- probes t55-t72 in
 * `test/fixtures/xfa-adobe/`.
 *
 * **Invariant: one owner for the keep vocabulary.** The root loop and
 * `placeSplit` in `xfapage.ts` both ask these, so the two cannot disagree
 * about whether two siblings adhere.
 *
 * **Invariant: a pure leaf over `xfaflow.js` TYPES that never throws.**
 */
import type { LayoutNode } from './xfaflow.js';

/** The layouts a subform splits BETWEEN its children (164g.8, 164g.12). */
const FLOWED: ReadonlySet<string> = new Set(['tb', 'lr-tb', 'table']);

const concealed = (n: LayoutNode): boolean => n.presence === 'hidden' || n.presence === 'inactive';

/** R1, R7: `a` adheres to the sibling `b` after it when `a` states keep next or
 *  `b` keep previous -- "In all three cases the effect is the same" (p. 312,
 *  t55 = t56). `pageArea` is no adhesion: Adobe does not support it (p. 312's
 *  note, t64). The enumeration is matched exactly. */
export function adheres(a: LayoutNode, b: LayoutNode): boolean {
  return a.keep?.next === 'contentArea' || b.keep?.previous === 'contentArea';
}

/** R6: the index of the sibling after `sibs[i]` that it adheres to, skipping
 *  hidden and inactive siblings, which take no space (t63); undefined when
 *  there is none or it does not adhere. Only siblings adhere (p. 314, t62). */
export function nextAdhering(sibs: readonly LayoutNode[], i: number): number | undefined {
  for (let j = i + 1; j < sibs.length; j++) {
    if (concealed(sibs[j])) continue;
    return adheres(sibs[i], sibs[j]) ? j : undefined;
  }
  return undefined;
}

/** R8, and it overrules p. 291: a FLOWED subform's `keep intact="pageArea"`
 *  splits exactly as `none`, across pages included (t66-t68). A positioned one
 *  does not -- Adobe splits a positioned subform only when it states `none`
 *  (164g.11, t71). */
export function intactSplits(n: LayoutNode): boolean {
  const v = n.keep?.intact ?? 'none';
  return v === 'none' || (v === 'pageArea' && FLOWED.has(n.layout ?? 'position'));
}
