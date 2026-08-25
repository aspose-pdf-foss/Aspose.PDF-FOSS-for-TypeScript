/** The Flow element protocol, and the argument validators every element shares.
 *
 *  Its own module so that flowblock.ts can implement the protocol without
 *  importing flow.ts, which imports flowblock.ts back for the builders. This
 *  file imports nothing from either — the same split fieldstyle.ts and
 *  bordersides.ts already make. */

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { ClearSide } from './floatstack.js';

/** Which side's floats an element must clear before it places. */
export type FlowClear = ClearSide;

/** Inputs for a non-destructive {@link FlowElement.measure}. @internal */
export interface MeasureContext {
  width: number;
  availHeight: number;
}

/** Where an element is being placed. `top` is the current column pen (PDF user
 *  space, decreasing downward); `availHeight = top - contentBottom`. @internal */
export interface PlaceContext {
  doc: Document;
  page: Page;
  x: number;
  top: number;
  width: number;
  availHeight: number;
  /** The gap the engine inserts between two consecutive elements, over and above
   *  their own `spaceAfter`/`spaceBefore`. A decorating element that must paint
   *  across that gap (a quote bar) cannot otherwise know it. Optional: a caller
   *  that inserts no such gap may omit it, and an element must read it as 0. */
  paragraphSpacing?: number;
  /** When the flow is tagged, the grouping element under which this element
   *  appends its `/Hn` or `/P` on first draw. Absent for an untagged flow. */
  structParent?: StructElement;
}

/** Outcome of {@link FlowElement.place}. @internal */
export interface PlaceResult {
  /** Vertical space consumed in this column. */
  usedHeight: number;
  /** Overflow to continue in the next column/page, or `null` if fully placed
   *  (or discarded). */
  remainder: FlowElement | null;
  /** Whether anything was painted. */
  drew: boolean;
}

/** A unit of flow content. */
export interface FlowElement {
  place(ctx: PlaceContext): PlaceResult;
  /** Non-destructive dry-run of {@link place}: predict the vertical space the
   *  element would consume and whether it fully fits, without drawing. */
  measure?(ctx: MeasureContext): { usedHeight: number; fits: boolean };
  /** True only for headings — the elements eligible for keep-with-next. */
  readonly keepWithNextEligible?: boolean;
  /** Per-element override of the flow keep-with-next policy; `undefined` inherits
   *  the flow default. Meaningful only when {@link keepWithNextEligible}. */
  readonly keepWithNext?: boolean;
  /** Points to reserve above this element; treated as 0 when absent. */
  readonly spaceBefore?: number;
  /** Points to reserve below this element; treated as 0 when absent. */
  readonly spaceAfter?: number;
  /** Side(s) whose floats this element clears before placing; treated as none
   *  when absent. Continuations never carry it. */
  readonly clear?: FlowClear;
}

/** Validate an optional non-negative finite number, defaulting when absent.
 *  @internal */
export function nonNegative(v: number | undefined, dflt: number, name: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`${name} must be a non-negative finite number`);
  return n;
}

/** Validate an optional `clear` option. @internal */
export function normalizeClear(v: FlowClear | undefined): FlowClear | undefined {
  if (v === undefined) return undefined;
  if (v !== 'left' && v !== 'right' && v !== 'both')
    throw new TypeError("clear must be 'left', 'right', or 'both'");
  return v;
}

/** Validate the two spacing options every block-level element accepts. @internal */
export function normalizeSpacing(
  o: { spaceBefore?: number; spaceAfter?: number },
): { spaceBefore: number; spaceAfter: number } {
  return {
    spaceBefore: nonNegative(o.spaceBefore, 0, 'spaceBefore'),
    spaceAfter: nonNegative(o.spaceAfter, 0, 'spaceAfter'),
  };
}
