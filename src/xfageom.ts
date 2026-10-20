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
 *  which is XFA's own default unit.
 *
 *  **Rounded to a whole MILLIPOINT, because Adobe lays out in them (164g.35).**
 *  Designer's own `renderCache.bounds` processing instructions are integer
 *  millipoints, each measurement rounded BEFORE the arithmetic: on DD 3218 a
 *  190.5mm draw with 1.0008mm side insets is `534326` = 540000 - 2 x 2837,
 *  and 2.83691pt -> 2837 is ROUNDING (truncation gives 2836). Left in floating
 *  point, the loss of each stated height accumulated down a flow -- 0.0145pt
 *  by the foot of a DD 3218 page, past the 0.01 bound on 55 fields -- and with
 *  it every vendored form's worst residual falls to Adobe's own 0.0005 output
 *  rounding. Half-way values round toward +infinity (`Math.round`); no oracle
 *  separates that from Adobe's tie rule. */
export function measureToPt(s: string | undefined): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = MEASURE.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return undefined;
  const unit = m[2] === '' ? 'pt' : m[2].toLowerCase();
  const scale = UNIT_PT[unit];
  return scale === undefined ? undefined : Math.round(v * scale * 1000) / 1000;
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

/** The four flow layouts, plus the synthetic marker `xfatemplate.ts` pushes for
 *  a repeating `<occur>` subform, whose repeat DIRECTION is not knowable from
 *  the template. Since `164g.1` the first four are laid out by `xfaflow.ts`; repetition is not a layout since 164g.2. `chainIsPositioned` is kept for the flow oracle, which classifies fields by it. */
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

/** A node's own geometry attributes, verbatim from the template. */
export interface XfaRawGeom {
  x?: string; y?: string; w?: string; h?: string;
  anchorType?: string; rotate?: string;
}

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
/** Does this caption take space from its field? A hidden one, one stating no
 *  reserve and one reserving nothing do not. ONE owner, read by `applyCaption`
 *  and by a check button's alignment (164g.34), so the two cannot disagree
 *  about whether a caption is there. An unreadable reserve answers false; the
 *  edit region refuses it on its own. */
export function captionReservesSpace(cap: XfaCaption | undefined): boolean {
  if (!cap || cap.presence === 'hidden' || cap.reserve === undefined) return false;
  const r = measureToPt(cap.reserve);
  return r !== undefined && r > 0;
}

function applyCaption(box: XfaBox, cap: XfaCaption | undefined): XfaBox | { reason: string } {
  if (!cap) return box;
  if (cap.presence === 'hidden') return box;
  if (cap.reserve === undefined) return box;
  const r = measureToPt(cap.reserve);
  if (r === undefined)
    return { reason: `caption reserve="${cap.reserve}" could not be read as a measurement` };
  if (!captionReservesSpace(cap)) return box;

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
  /** The caption takes space from the field (`captionReservesSpace`). */
  captionReserves?: boolean;
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
 * **A LEFT caption that reserves space puts it flush LEFT (164g.34)**, beside
 * the caption -- which the rule above, read for "a caption on the left", got
 * backwards: fw9's left-side cases had no caption at all. DoD DD 3207's yes/no
 * and DD 3019's DPL are the corpus's only three such buttons, and Adobe places
 * all three flush left, 3.9, 39.4 and 7.9pt left of where `right` put them.
 *
 * **Note what the corpus does NOT contain:** a caption placed `top` or
 * `bottom`, and a left caption that reserves nothing (zero, or hidden). They
 * keep the caption-less `right` default, unmeasured.
 *
 * Vertical placement is the field `<para vAlign>`, and both non-default values
 * are in the corpus -- f1040's `c1_1` is `bottom`, everything else `middle`.
 */
export function buttonBox(
  edit: XfaBox, b: XfaButtonSpec,
): XfaBox | { reason: string } {
  // An absent size is XFA 3.3's stated default, 10pt (Template Reference,
  // checkButton: "The default is 10pt"). 17vo read it as "leave the edit
  // region", which no f1040 or fw9 button could contradict; USCIS I-130 and
  // I-765 state no size on 98 buttons and Adobe drew every one 10x10 (164g.3).
  const s = measureToPt(b.size ?? '10pt');
  if (s === undefined)
    return { reason: `checkButton size="${b.size}" could not be read as a measurement` };
  if (s <= 0) return { reason: `checkButton size="${b.size}" is not positive` };
  // A button never grows past the room it is placed in -- it would overlap
  // whatever sits beside it, and the field box is the one bound the template
  // actually states.
  const w = Math.min(s, edit.w);
  const h = Math.min(s, edit.h);

  // A right caption, or a LEFT one that reserves space (164g.34), puts the
  // button flush left; no caption puts it flush right. Top, bottom and a left
  // caption reserving nothing are unmeasured and keep the caption-less answer.
  const placement = b.captionPlacement ?? 'left';
  const flushLeft = placement === 'right' || (placement === 'left' && b.captionReserves === true);
  const hAlign = b.hAlign ?? (flushLeft ? 'left' : 'right');
  const vAlign = b.vAlign ?? 'top';
  const dx = hAlign === 'center' ? (edit.w - w) / 2
    : hAlign === 'right' ? edit.w - w : 0;
  // XFA's y runs DOWNWARD, so `bottom` is the LARGER y.
  const dy = vAlign === 'middle' ? (edit.h - h) / 2
    : vAlign === 'bottom' ? edit.h - h : 0;
  return { x: edit.x + dx, y: edit.y + dy, w, h };
}

/**
 * A field's EDIT region -- its laid-out box minus its caption reserve and its
 * own `<margin>` insets. This is what a widget covers.
 *
 * Their ORDER is not load-bearing and the corpus provably cannot discriminate
 * it: both subtract fixed amounts from named edges, so the resulting rect is
 * the same either way, and f1040 never pairs a caption with an inset on the
 * SAME edge. Only the two refusal guards differ, each testing the room left at
 * its own step, which is the safe direction for both.
 */
export function editRegion(
  box: XfaBox, caption?: XfaCaption, margin?: XfaMargin,
): XfaBox | { reason: string } {
  const edit = applyCaption(box, caption);
  if ('reason' in edit) return edit;
  return applyMargin(edit, margin);
}

/**
 * A field's edit region AND caption region (164g.4), from one function so the
 * two cannot overlap or leave a gap. `edit` is `editRegion`'s answer exactly,
 * refusal included. The caption sits in the nominal content region -- the box
 * less the field's margin (XFA 3.3 p. 50) -- on its `placement` side,
 * `reserve` deep; pdf.js places it the same way (its `Caption` inside the
 * margin-padded field). No caption, a hidden one, or an unstated or zero
 * reserve has no region.
 */
export function fieldRegions(
  box: XfaBox, caption?: XfaCaption, margin?: XfaMargin,
): { edit: XfaBox; caption?: XfaBox } | { reason: string } {
  const edit = editRegion(box, caption, margin);
  if ('reason' in edit) return edit;
  if (!caption || caption.presence === 'hidden' || caption.reserve === undefined) return { edit };
  const r = measureToPt(caption.reserve);
  if (r === undefined || r <= 0) return { edit };
  const content = applyMargin(box, margin);
  if ('reason' in content) return { edit };
  const edge = CAPTION_EDGE[caption.placement ?? 'left'];
  if (edge === 'left') return { edit, caption: { x: content.x, y: content.y, w: r, h: content.h } };
  if (edge === 'right') return { edit, caption: { x: content.x + content.w - r, y: content.y, w: r, h: content.h } };
  if (edge === 'top') return { edit, caption: { x: content.x, y: content.y, w: content.w, h: r } };
  return { edit, caption: { x: content.x, y: content.y + content.h - r, w: content.w, h: r } };
}
