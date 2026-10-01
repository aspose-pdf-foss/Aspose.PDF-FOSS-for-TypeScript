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
  /** The factor an enclosing paragraph indent was squeezed by (`insetScale`),
   *  which the text's first-line indent must scale by too — a hanging line
   *  reaches back by the left room actually GRANTED, not the room stated.
   *  Absent means 1. */
  indentScale?: number;
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
  /** See {@link MeasureContext.indentScale}. Absent means 1. */
  indentScale?: number;
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
   *  element would consume and whether it fully fits, without drawing.
   *
   *  `fits` means NOTHING IS LEFT OVER, and deliberately not "and something
   *  was drawn". An element with nothing to draw — text whose every character
   *  the resolved face cannot encode is the everyday case — reports
   *  `{ usedHeight: 0, fits: true }`, which the engine reads as "discard".
   *  Conflating that with "did not fit here" makes it ask for another column,
   *  and at a column start there is none, so the whole render throws
   *  (zch2.13). A caller that needs "drew something" must test `usedHeight`
   *  itself, as the keep-with-next lookahead does. */
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
  /** Float this element instead of placing it in flow. The engine paints
   *  `content` and narrows the channel; `place()` is then reached ONLY on the
   *  degrade path, when the float cannot fit an empty column. */
  readonly float?: { side: 'left' | 'right'; content: FloatContent };
  /** Last resort before the engine gives up: return a replacement that fits
   *  `availHeight` at `width`, or `undefined` when this element cannot be
   *  scaled (`zch2.16`).
   *
   *  Asked ONLY where the alternative is refusing the document — at a column
   *  start, or at the top of an otherwise-empty rect. It must NOT be consulted
   *  during ordinary placement: a tall image near a column FOOT has to move to
   *  the next column, not shrink to the gap it happens to find, or a picture's
   *  size depends on what precedes it. */
  shrinkToFit?(width: number, availHeight: number): FlowElement | undefined;
  /** The engine had to compromise to place this element at all (`zch2.16`):
   *  `'scaled'` when it was shrunk to fit, `'overflow'` when it was drawn past
   *  the column bottom, `'squeezed'` when a decorator around it could not
   *  afford its own indents and scaled them down (`rfba`).
   *
   *  `'squeezed'` is fired by the DECORATOR, from `place()` and never from
   *  `measure()` — the engine measures speculatively, many times per element.
   *  A decorator forwards `onCompromise` to what it wraps, so every level of a
   *  deep nest fires the same callback and the consumer's one-shot turns them
   *  into one record.
   *
   *  NOT readonly, and that is deliberate: `cssflow.ts` assigns it after
   *  construction, because the builders are shared with Markdown and
   *  hand-built flows and must not grow an HTML-shaped option. The engine
   *  fires it on the ORIGINAL element before swapping in a replacement, so a
   *  replacement need not carry it. */
  onCompromise?: (how: Compromise) => void;
}

/** What the flow engine needs of a floated thing: how wide a band it excludes,
 *  how tall it is, and how to paint it.
 *
 *  Invariant: FOUR REQUIRED members, and `FloatingBox` satisfies every one of
 *  them UNEDITED — that is what lets a CSS float join the existing float branch
 *  instead of adding a second one. A required edit to `FloatingBox` means this
 *  seam is wrong. `splitPaint` is the one OPTIONAL member: `FloatingBox`
 *  declines it and keeps its documented refusal to split. */
export interface FloatContent {
  /** Drawn width; the excluded band is `width + spacing`. */
  readonly width: number;
  /** Gap between the box and the text beside it. */
  readonly spacing: number;
  /** Height at `width`, non-destructively. */
  measure(): number;
  /** Draw at `x` with its TOP edge at `topY`; returns the height drawn. */
  paintAt(page: Page, x: number, topY: number, structParent?: StructElement): number;
  /** Lay out in flow rather than throwing when it cannot fit an EMPTY column.
   *  Only a CSS float sets it: this epic's rule is degrade-and-report, while
   *  `FloatingBox`'s documented contract is to throw. */
  readonly degradeOnOverflow?: boolean;
  /** Paint into a height budget and hand back what did not fit (`zch2.15`).
   *
   *  Only `elementFloat` implements it. `FloatingBox` declines it and never
   *  splits: its border and background have no defined way to continue across
   *  a column, so a split box reads as a fault.
   *
   *  `height` is what was ACTUALLY painted, which after a split differs from
   *  `measure()` — the engine takes the excluded band from it for that reason.
   *  A `height` of 0 means nothing was painted and the call had no effect,
   *  which is what lets the engine fall through to the degrade path. `tail` is
   *  a `FlowElement` already carrying the float marker, ready to enqueue. */
  splitPaint?(
    page: Page, x: number, topY: number, maxHeight: number,
    side: 'left' | 'right', structParent?: StructElement,
  ): { height: number; tail?: FlowElement };
  /** Called when the engine gives up on floating this and places it in flow
   *  instead (`zch2.16`). Only a degradable float can reach a degrade, and only
   *  a CSS float is degradable, so it never fires for a hand-built flow. */
  readonly onDegraded?: () => void;
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

/** How the engine compromised to place an element — see
 *  {@link FlowElement.onCompromise}. */
export type Compromise = 'scaled' | 'overflow' | 'squeezed';

/** The narrowest content column a decorator may leave behind (points).
 *
 *  About one em of body text at the 11pt default: narrower than this and a
 *  column cannot carry a glyph, so there is nothing to be gained by indenting
 *  further. See {@link insetScale}. */
export const MIN_CONTENT_WIDTH = 12;

/** How much of a `total` horizontal inset a `width` can afford, as a factor to
 *  scale every horizontal component by: 1 when there is room, 0 when there is
 *  none (`e1bp`).
 *
 *  **Invariant, and it is the whole of the fix:** a decorator NEVER narrows a
 *  positive width to less than {@link MIN_CONTENT_WIDTH}, and never shifts its
 *  content right without narrowing it by the same amount. Every indent in the
 *  flow layer — a quote, a list item, a list item's further blocks, a code
 *  block's padding, a CSS box's margins and insets — used to subtract with no
 *  floor, and deep nesting then drove the width to zero. That failed TWO ways
 *  from one cause: Markdown threw `rect width and height must be positive`
 *  from inside `stamp.ts` (quote depth 26, list depth 49 on a default A4
 *  flow), and HTML, whose `BoxElement` reads a non-positive width as "nothing
 *  to draw", rendered a BLANK PAGE from depth 8 and said nothing.
 *
 *  **Invariant:** every horizontal component scales by the SAME factor, which
 *  is why this answers with a factor rather than a width. Clamp the width
 *  alone and the content keeps sliding right — off the column, and for a CSS
 *  box off the page — which is the browser's answer (a content box clamps at
 *  zero and its text overflows) and the wrong one here, where ink outside the
 *  region is ink nobody sees. `zch2.16` settled the same question in the
 *  vertical direction: content that cannot fit renders rather than refusing
 *  the document.
 *
 *  Note the scope of that, since the obvious reading overstates it: what stays
 *  inside the column is the BOX. A word wider than the floor still draws past
 *  its right edge, exactly as an over-wide word does in any column — a floored
 *  box only makes it likelier.
 *
 *  Note what the caller is owed: with `width > 0` the result leaves
 *  `width - total * k >= min(width, MIN_CONTENT_WIDTH) > 0`, so a chain of
 *  decorators converges on a narrow column instead of reaching zero. At or
 *  below the floor the factor is 0 — an already-narrow box is never made
 *  narrower, which is what makes that bound hold at every depth rather than
 *  only at the first.
 *
 *  Note, measured, and it covers NOTHING: the first line is a REDUNDANT
 *  DEFENCE and provably cannot be otherwise. `room` is non-negative, so any
 *  `total <= 0` — a zero inset, or the negative margin CSS allows — already
 *  satisfies `total <= room` and takes the same branch, and the division is
 *  never reached with a zero divisor. It stays as the honest spelling of "no
 *  inset, no scaling"; do not cite the suite as covering it. @internal */
export function insetScale(width: number, total: number): number {
  if (!(total > 0)) return 1;
  const room = Math.max(0, width - MIN_CONTENT_WIDTH);
  return total <= room ? 1 : room / total;
}
