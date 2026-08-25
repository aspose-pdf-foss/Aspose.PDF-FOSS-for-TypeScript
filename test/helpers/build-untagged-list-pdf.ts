import { buildSimpleTextPdf } from './build-text-pdf.js';

/** Untagged pages whose list markers are ordinary TEXT at the left edge.
 *
 *  This is the shape a third-party producer emits, and the shape docinfer.ts
 *  exists to read. It is deliberately NOT built with `AddMarkdown`: our own
 *  `flow.ts` draws a bullet and a task box as vector geometry (WinAnsi has no
 *  ballot-box glyph), so a rendering of our own leaves no bullet on the page to
 *  recognise — measuring it would measure our renderer, not the inference.
 *
 *  `\225` is WinAnsi 0x95, U+2022 BULLET. */

/** One `Tj` at (x, y) in 10pt Helvetica. */
function at(x: number, y: number, text: string): string {
  return `BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET\n`;
}

/** A line whose marker and body are separate runs, as a producer lays them out:
 *  the marker at `markerX`, the body at `bodyX`. */
function item(markerX: number, bodyX: number, y: number, marker: string, body: string): string {
  return at(markerX, y, marker) + at(bodyX, y, body);
}

/** Two bullet items at one level. */
export function buildBulletListPdf(): Uint8Array {
  return buildSimpleTextPdf(
    item(50, 65, 250, '\\225', 'alpha')
    + item(50, 65, 236, '\\225', 'beta'));
}

/** Outer / inner / outer, the inner marker indented past the bucket tolerance
 *  (max(3pt, 0.5 x 10pt body) = 5pt; 20pt is comfortably clear of it). */
export function buildNestedListPdf(): Uint8Array {
  return buildSimpleTextPdf(
    item(50, 65, 250, '\\225', 'outer')
    + item(70, 85, 236, '\\225', 'inner')
    + item(50, 65, 222, '\\225', 'outer again'));
}

/** An ordered list that does not start at one. */
export function buildOrderedListPdf(): Uint8Array {
  return buildSimpleTextPdf(
    item(50, 65, 250, '3.', 'three')
    + item(50, 65, 236, '4.', 'four'));
}

/** A single item whose wrapped continuation is indented to its body x — the
 *  corroboration that distinguishes a one-item list from prose. */
export function buildWrappedItemPdf(): Uint8Array {
  return buildSimpleTextPdf(
    item(50, 65, 250, '\\225', 'a long item that wraps')
    + at(65, 236, 'onto a second line'));
}

/** Prose opening with a year. Nothing corroborates the marker, so it must stay
 *  a paragraph — `1990. It was a good year` is the case the rule exists for. */
export function buildYearProsePdf(): Uint8Array {
  return buildSimpleTextPdf(
    at(50, 250, '1990. It was a good year for the industry')
    + at(50, 236, 'and nothing at all happened that autumn.'));
}
