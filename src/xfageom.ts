/**
 * XFA geometry, as pure arithmetic over numbers and the template's own
 * attribute strings.
 *
 * **Invariant: it imports NOTHING.** No `Document`, no PDF object, no `node:`
 * module -- the split `floatstack.ts`, `booklet.ts`, `tablespan.ts` and
 * `docinfer.ts` each already make, for their reason: geometry that is silently
 * wrong when reversed must be testable from numbers with no PDF built.
 *
 * **Invariant: it never throws.** Every failure is `undefined`, which the
 * caller turns into a geometry-less field plus a report entry.
 */

/** Points per unit, for the units whose conversion is unambiguous.
 *
 *  **`px`, `pc` and `em` are deliberately ABSENT and must stay absent until
 *  someone transcribes the XFA specification's own definition with the clause
 *  cited here.** `pc` is very probably 12pt and `px` very probably depends on
 *  an assumed resolution -- "very probably" is exactly the standard this repo
 *  refuses for a number that silently misplaces every field on a page. `em` is
 *  relative to a font size this leaf has no access to by construction. */
const UNIT_PT: Record<string, number> = {
  in: 72,
  pt: 1,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
};

/** A number, optionally signed, optionally fractional, optionally followed by
 *  a unit. XFA writes `1in`, `-0.5in`, `.25in` and a bare `18` alike. */
const MEASURE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([A-Za-z]*)\s*$/;

/** An XFA measurement in points, or `undefined` when it cannot be read for
 *  certain -- junk, or a unit we decline to guess at. A bare number is points,
 *  which is XFA's own default unit. */
export function measureToPt(s: string | undefined): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = MEASURE.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return undefined;
  const unit = m[2] === '' ? 'pt' : m[2].toLowerCase();
  const scale = UNIT_PT[unit];
  return scale === undefined ? undefined : v * scale;
}

export type XfaAnchor =
  | 'topLeft' | 'topCenter' | 'topRight'
  | 'middleLeft' | 'middleCenter' | 'middleRight'
  | 'bottomLeft' | 'bottomCenter' | 'bottomRight';

export const XFA_ANCHORS: readonly XfaAnchor[] = [
  'topLeft', 'topCenter', 'topRight',
  'middleLeft', 'middleCenter', 'middleRight',
  'bottomLeft', 'bottomCenter', 'bottomRight',
];

/** A box in XFA's frame: origin top-left, y increasing DOWNWARD, in points. */
export interface XfaBox { x: number; y: number; w: number; h: number }

/** How far to move from the stated `x`/`y` to reach the box's TOP-LEFT corner.
 *
 *  `anchorType` says what `x`/`y` NAMES, so the corner is always found by
 *  moving back from it -- every delta is zero or negative, never positive.
 *  `undefined` for a value outside the nine, which degrades the field. */
export function anchorShift(
  anchor: string | undefined, w: number, h: number,
): { dx: number; dy: number } | undefined {
  const a = anchor ?? 'topLeft';
  if (!(XFA_ANCHORS as readonly string[]).includes(a)) return undefined;
  const dx = a.endsWith('Center') ? -w / 2 : a.endsWith('Right') ? -w : 0;
  const dy = a.startsWith('middle') ? -h / 2 : a.startsWith('bottom') ? -h : 0;
  return { dx, dy };
}

/** An XFA box to an annotation `/Rect` in default user space.
 *
 *  `/Rotate` needs no handling: an annotation rect is in UNROTATED default user
 *  space and the viewer applies the page rotation, which is the rule this
 *  library already states for annotation coordinates. */
export function rectFromBox(
  box: XfaBox, crop: readonly number[],
): [number, number, number, number] {
  const llx = crop[0] + box.x;
  const ury = crop[3] - box.y;
  return [llx, ury - box.h, llx + box.w, ury];
}

/** A `<pageArea>`'s `<medium>`: the page size the form was authored for. */
export interface XfaMedium { short?: string; long?: string; orientation?: string }

/** How far a declared medium may differ from the page's CropBox and still be
 *  believed, on either axis.
 *
 *  One point is tight enough that a unit error cannot pass -- the smallest of
 *  them moves an A4 edge by tens of points -- and loose enough to absorb a
 *  producer's rounding of `8.5in` to three decimal places. */
export const MEDIUM_TOLERANCE_PT = 1;

/** A medium's page box in points, `undefined` when either measurement is
 *  absent or a unit we decline to guess at. `orientation="landscape"` swaps
 *  short and long, which is the only reason the attribute is read. */
export function mediumSizePt(
  m: XfaMedium | undefined,
): { w: number; h: number } | undefined {
  if (!m) return undefined;
  const s = measureToPt(m.short);
  const l = measureToPt(m.long);
  if (s === undefined || l === undefined) return undefined;
  return m.orientation === 'landscape' ? { w: l, h: s } : { w: s, h: l };
}

/**
 * Does the page the form was authored for match the page we are about to place
 * fields on?
 *
 * **This is the check that makes the rest trustworthy.** It asserts against a
 * number we did not compute, so one comparison catches a unit-conversion error,
 * an orientation swap and a wrong page mapping alike -- the discipline this repo
 * states as *to check an interpreter, assert against something outside it*. An
 * absent or unreadable medium is a refusal, not a pass: without it there is
 * nothing to check against, and placing fields anyway is exactly the guess the
 * design forbids.
 */
export function mediumAgrees(
  m: XfaMedium | undefined, crop: readonly number[],
): boolean {
  const size = mediumSizePt(m);
  if (!size) return false;
  const w = Math.abs(crop[2] - crop[0]);
  const h = Math.abs(crop[3] - crop[1]);
  return Math.abs(size.w - w) <= MEDIUM_TOLERANCE_PT
    && Math.abs(size.h - h) <= MEDIUM_TOLERANCE_PT;
}

/** One ancestor container's own position, as the template spells it. */
export interface XfaOffset { x?: string; y?: string }

/** The four flow layouts, plus the synthetic marker `xfatemplate.ts` pushes for
 *  a repeating `<occur>` subform, whose repeat DIRECTION is not knowable from
 *  the template. Anything not `'position'` degrades, so this list is
 *  documentation rather than the test. */
export const XFA_FLOW_LAYOUTS: readonly string[] = ['tb', 'lr-tb', 'row', 'table', 'occur'];

/**
 * May a field under this ancestor chain be given a rect?
 *
 * **Only when EVERY entry is `position`.** The test is on the whole chain, not
 * the immediate parent: a positioned subform inside a flowed one has no fixed
 * origin of its own, which is precisely the case where a plausible wrong answer
 * is available. An unknown layout is refused for the same reason -- an
 * allowlist, the posture `content.ts`'s `NON_MARKING` takes.
 *
 * Where the chain BEGINS is `xfatemplate.ts`'s decision: at the page origin,
 * not at the root subform that carries the `<pageSet>`. See its module docs.
 */
export function chainIsPositioned(layouts: readonly string[]): boolean {
  return layouts.every((l) => l === 'position');
}

/** The chain's accumulated origin in points, or `undefined` when ANY level is
 *  unreadable -- a partial sum is an approximate rect by another name. */
export function accumulateOrigin(
  offsets: readonly XfaOffset[],
): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  for (const o of offsets) {
    const ox = o.x === undefined ? 0 : measureToPt(o.x);
    const oy = o.y === undefined ? 0 : measureToPt(o.y);
    if (ox === undefined || oy === undefined) return undefined;
    x += ox;
    y += oy;
  }
  return { x, y };
}

/** A field's own geometry attributes, verbatim from the template. */
export interface XfaRawGeom {
  x?: string; y?: string; w?: string; h?: string;
  anchorType?: string; rotate?: string;
}

/**
 * A field's box in the page's XFA frame, or a `reason` naming why it has none.
 *
 * Every refusal is by name, because the caller puts it straight on the report
 * and that report is the first place a caller looks when a converted document
 * is missing a field.
 */
/** A field's `<caption>`, as the template spells it. */
export interface XfaCaption { reserve?: string; placement?: string; presence?: string }

/** Where a caption sits, and so which edge its reserve eats. `left` is XFA's
 *  default. `inline` is deliberately absent: it draws the caption within the
 *  content rather than beside it, and which edge that costs is not something to
 *  guess at -- a field carrying it degrades. */
const CAPTION_EDGE: Record<string, 'left' | 'right' | 'top' | 'bottom'> = {
  left: 'left', right: 'right', top: 'top', bottom: 'bottom',
};

/**
 * Shrink a field's box to its EDIT region -- the field box minus the caption's
 * reserve.
 *
 * **This is what a widget actually covers, and the design missed it.** A
 * `<caption>` is the label drawn beside the input, and LiveCycle's own
 * `/AcroForm` places the widget over the edit region alone. Measured against
 * IRS f1040: `f1_01` is 280.8pt wide with `reserve="68.0156mm"` (192.8pt), and
 * Adobe's rect is exactly 88pt wide. Ignore the reserve and every captioned
 * field is drawn far too wide, overlapping its own label -- a plausible-looking
 * page that is wrong, which is the failure this module exists to refuse.
 *
 * `presence="hidden"` means the caption occupies no space, so it eats nothing;
 * `invisible` is undrawn but still reserved, so it does.
 */
function applyCaption(box: XfaBox, cap: XfaCaption | undefined): XfaBox | { reason: string } {
  if (!cap) return box;
  if (cap.presence === 'hidden') return box;
  if (cap.reserve === undefined) return box;
  const r = measureToPt(cap.reserve);
  if (r === undefined)
    return { reason: `caption reserve="${cap.reserve}" could not be read as a measurement` };
  if (r <= 0) return box;

  const edge = CAPTION_EDGE[cap.placement ?? 'left'];
  if (edge === undefined)
    return { reason: `caption placement="${cap.placement ?? ''}" is not one of the four` };

  const horizontal = edge === 'left' || edge === 'right';
  const avail = horizontal ? box.w : box.h;
  // A reserve that swallows the field leaves no edit region to place a widget
  // over. Degrading beats emitting a zero-or-negative rect.
  if (r >= avail)
    return { reason: `caption reserve ${String(r)}pt leaves no room in a ${String(avail)}pt field` };

  if (edge === 'left') return { x: box.x + r, y: box.y, w: box.w - r, h: box.h };
  if (edge === 'right') return { x: box.x, y: box.y, w: box.w - r, h: box.h };
  // XFA's y runs DOWNWARD, so a top caption pushes the edit region down.
  if (edge === 'top') return { x: box.x, y: box.y + r, w: box.w, h: box.h - r };
  return { x: box.x, y: box.y, w: box.w, h: box.h - r };
}

/** A field's `<margin>`, as the template spells it. An absent inset is 0,
 *  which is XFA's own default and is what the corpus shows. */
export interface XfaMargin {
  leftInset?: string; rightInset?: string; topInset?: string; bottomInset?: string;
}

/**
 * Shrink the edit region further by the field's own `<margin>`.
 *
 * **This is the residue the caption rule left, and the corpus names it
 * exactly.** Over all 54 distinct `textEdit` declaration shapes in IRS f1040,
 * our width error was `leftInset + rightInset` and our height error
 * `topInset + bottomInset`, with no exception -- `f1_03` is 36x12 with
 * `rightInset="1.4111mm"` (4pt) and `topInset`/`bottomInset="0.1764mm"` (0.5pt
 * each), and Adobe's widget is 17 x 10.999 once the 15pt caption reserve is
 * also gone.
 *
 * **The `<border>` contributes NOTHING, which is the half the bug report got
 * backwards.** It was filed on the guess that the half-point was "a 1pt border
 * the widget is inset by half of"; it is `topInset` read literally. Measured:
 * edge thickness varies independently across those same 54 rows and moves the
 * rect not at all -- `f2_01` carries a visible `0.3528mm` (1pt) edge and its
 * width and height match Adobe's exactly. Do not add a border inset back
 * without a corpus that shows one.
 */
function applyMargin(box: XfaBox, m: XfaMargin | undefined): XfaBox | { reason: string } {
  if (!m) return box;
  const keys = ['leftInset', 'rightInset', 'topInset', 'bottomInset'] as const;
  const v: number[] = [];
  for (const k of keys) {
    const s = m[k];
    if (s === undefined) { v.push(0); continue; }
    const n = measureToPt(s);
    if (n === undefined)
      return { reason: `margin ${k}="${s}" could not be read as a measurement` };
    v.push(n);
  }
  const [l, r, t, b] = v;
  const w = box.w - l - r;
  const h = box.h - t - b;
  // Insets that swallow the field leave no edit region to place a widget over.
  // Degrading beats emitting a zero-or-negative rect -- the caption's rule.
  if (w <= 0 || h <= 0)
    return {
      reason: `margin insets leave no edit region in a ${String(box.w)}x${String(box.h)}pt field`,
    };
  // XFA's y runs DOWNWARD, so the TOP inset pushes the edit region down.
  return { x: box.x + l, y: box.y + t, w, h };
}

/** What a `<checkButton>` field contributes beyond its box: the button's own
 *  size, and the field `<para>`'s alignment. `captionPlacement` is the caption's
 *  own, defaulting to XFA's `left` when there is no caption at all. */
export interface XfaButtonSpec {
  size?: string;
  hAlign?: string;
  vAlign?: string;
  captionPlacement?: string;
}

/**
 * A check button's widget within its edit region.
 *
 * **A `<checkButton size>` states the BUTTON's box, which is smaller than the
 * field's.** Measured on both vendored forms: `size="2.8222mm"` is 8pt, and
 * every one of Adobe's 54 button rects across f1040 and fw9 is exactly 8x8
 * where ours was the whole caption-and-margin-reduced field box -- 12x12 for
 * `c1_8`, so a converted checkbox was drawn half again too large.
 *
 * **The HORIZONTAL default is measured, not derived, and it is not one default
 * but two.** No field in either form states `hAlign`, so every observed case is
 * the default: a caption on the RIGHT puts the button flush LEFT, and a caption
 * on the left -- or none at all -- puts it flush RIGHT. What settles that is
 * fw9, where three buttons share `x="14.4"` and all three of Adobe's rects
 * begin at exactly 73.0; of the four pairings only this one makes a
 * caption-right field and a caption-less one land on the same edge, and it then
 * reproduces all 8 of that form's buttons on both axes from one page origin.
 * A stated `hAlign` outranks it, which no vendored field exercises.
 *
 * **Note what the corpus does NOT contain:** a caption placed `top` or
 * `bottom`, and a LEFT caption with a non-zero reserve. Both fall under the
 * `right` default here by the same rule, unmeasured.
 *
 * Vertical placement is the field `<para vAlign>`, and both non-default values
 * are in the corpus -- f1040's `c1_1` is `bottom`, everything else `middle`.
 */
export function buttonBox(
  edit: XfaBox, b: XfaButtonSpec,
): XfaBox | { reason: string } {
  // No size stated is not a size of zero: there is nothing to place, so the
  // edit region stands. Inventing a default is the kind of number this module
  // refuses -- and every field in both corpora states one.
  if (b.size === undefined) return edit;
  const s = measureToPt(b.size);
  if (s === undefined)
    return { reason: `checkButton size="${b.size}" could not be read as a measurement` };
  if (s <= 0) return { reason: `checkButton size="${b.size}" is not positive` };
  // A button never grows past the room it is placed in -- it would overlap
  // whatever sits beside it, and the field box is the one bound the template
  // actually states.
  const w = Math.min(s, edit.w);
  const h = Math.min(s, edit.h);

  const hAlign = b.hAlign ?? (b.captionPlacement === 'right' ? 'left' : 'right');
  const vAlign = b.vAlign ?? 'top';
  const dx = hAlign === 'center' ? (edit.w - w) / 2
    : hAlign === 'right' ? edit.w - w : 0;
  // XFA's y runs DOWNWARD, so `bottom` is the LARGER y.
  const dy = vAlign === 'middle' ? (edit.h - h) / 2
    : vAlign === 'bottom' ? edit.h - h : 0;
  return { x: edit.x + dx, y: edit.y + dy, w, h };
}

export function boxFor(
  own: XfaRawGeom, offsets: readonly XfaOffset[], caption?: XfaCaption,
  margin?: XfaMargin,
): XfaBox | { reason: string } {
  // A rotated field would need the widget /MK /R plus /Matrix dance
  // appearance.ts already documents as its own trap. `rotate="0"` is not a
  // rotation and must not degrade a field.
  if (own.rotate !== undefined && measureToPt(own.rotate) !== 0)
    return { reason: `rotate="${own.rotate}" is not supported` };

  const origin = accumulateOrigin(offsets);
  if (!origin) return { reason: 'an ancestor position could not be read' };

  const keys = ['x', 'y', 'w', 'h'] as const;
  const vals: number[] = [];
  for (const k of keys) {
    const v = measureToPt(own[k]);
    if (v === undefined)
      return { reason: `${k}="${own[k] ?? ''}" could not be read as a measurement` };
    vals.push(v);
  }
  const [x, y, w, h] = vals;

  const shift = anchorShift(own.anchorType, w, h);
  if (!shift) return { reason: `anchorType="${own.anchorType ?? ''}" is not one of the nine` };

  // The caption and the margin are subtracted LAST, from the placed box: the
  // anchor names a point on the FIELD, not on the edit region inside it.
  //
  // Their ORDER is not load-bearing and the corpus provably cannot discriminate
  // it -- both subtract fixed amounts from named edges, so the resulting rect is
  // the same either way, and f1040 never pairs a caption with an inset on the
  // SAME edge. Only the two refusal guards differ, each testing the room left at
  // its own step, which is the safe direction for both.
  const edit = applyCaption(
    { x: origin.x + x + shift.dx, y: origin.y + y + shift.dy, w, h }, caption,
  );
  if ('reason' in edit) return edit;
  return applyMargin(edit, margin);
}
