import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfRef, PdfStream, isArray, isDict, isRef, isStream, isString, name,
} from './types.js';
import { num } from './pagecontent.js';
import { enc, serializeString } from './serialize.js';
import { encodeWinAnsi } from './encoding.js';
import { measure, type StdFont } from './metrics.js';
import { resolveDA } from './da.js';
import { decodePdfText } from './metadata.js';
import { widgetGeom, mkOps, buildAppearanceXObject } from './appearance.js';
import type { BuiltImage } from './imageembed.js';

/** Where a push button's icon sits relative to its caption — all seven layouts
 *  PDF 32000-1 table 189 defines. The specification names each one after the
 *  *caption*; these names put the icon first, so every member reads the same
 *  way round. */
export type ButtonIconPosition =
  | 'caption-only' | 'icon-only'
  | 'icon-above-caption' | 'icon-below-caption'
  | 'icon-left-of-caption' | 'icon-right-of-caption'
  | 'caption-over-icon';

/** Every supported position, for validation and exhaustive tests. */
export const BUTTON_POSITIONS: readonly ButtonIconPosition[] = [
  'caption-only', 'icon-only', 'icon-above-caption', 'icon-below-caption',
  'icon-left-of-caption', 'icon-right-of-caption', 'caption-over-icon',
];

/** The /MK /TP value for each position (table 189). */
export const TP_FOR: Record<ButtonIconPosition, number> = {
  'caption-only': 0,
  'icon-only': 1,
  'icon-above-caption': 2,     // the specification calls this "caption below the icon"
  'icon-below-caption': 3,     // "caption above the icon"
  'icon-left-of-caption': 4,   // "caption to the right of the icon"
  'icon-right-of-caption': 5,  // "caption to the left of the icon"
  'caption-over-icon': 6,
};

/** Where the icon and caption go, in form space (origin at the box's lower-left),
 *  each as [x, y, w, h]. An absent region means that element is not drawn. */
export interface ButtonRegions {
  icon?: [number, number, number, number];
  caption?: [number, number, number, number];
}

/** Lay out a push button's face. Pure: box size and mode in, rectangles out,
 *  which is what makes the seven modes testable without reading content
 *  streams. */
export function buttonRegions(
  pos: ButtonIconPosition, w: number, h: number, inset: number,
): ButtonRegions {
  const x = inset;
  const y = inset;
  const bw = Math.max(0, w - 2 * inset);
  const bh = Math.max(0, h - 2 * inset);
  const whole: [number, number, number, number] = [x, y, bw, bh];
  // A caption strip across the box, capped so a tall button does not give the
  // caption more room than it can use. The icon takes what is left.
  const capH = Math.min(bh * 0.3, 14);
  // The icon's column in a side-by-side layout: a square at most, and never
  // more than half the width, so the caption always keeps a usable box.
  const icoW = Math.min(bh, bw * 0.5);
  switch (pos) {
    case 'caption-only':
      return { caption: whole };
    case 'icon-only':
      return { icon: whole };
    case 'caption-over-icon':
      return { icon: whole, caption: whole };
    case 'icon-above-caption':
      return {
        icon: [x, y + capH, bw, bh - capH],
        caption: [x, y, bw, capH],
      };
    case 'icon-below-caption':
      return {
        icon: [x, y, bw, bh - capH],
        caption: [x, y + bh - capH, bw, capH],
      };
    case 'icon-left-of-caption':
      return {
        icon: [x, y, icoW, bh],
        caption: [x + icoW, y, bw - icoW, bh],
      };
    case 'icon-right-of-caption':
      return {
        icon: [x + bw - icoW, y, icoW, bh],
        caption: [x, y, bw - icoW, bh],
      };
  }
}

/** What a push button's three appearance streams draw. */
export interface PushButtonFace {
  caption: string;
  rolloverCaption: string;
  downCaption: string;
  /** Already-built image XObject; omit for a caption-only button. */
  icon?: BuiltImage;
  position: ButtonIconPosition;
}

/** How much the pressed state darkens the face. */
const DOWN_DARKEN = 0.85;
/** Resource name the icon is registered under inside the appearance streams. */
const ICON_KEY = 'BtnIco';

/** Ops drawing `text` centred in [x, y, w, h] at `size`, in `color`. */
function centredCaption(
  text: string, rect: [number, number, number, number],
  std: StdFont, size: number, color: [number, number, number],
): string {
  if (text === '') return '';
  const [x, y, w, h] = rect;
  const bytes = encodeWinAnsi(text);
  const tw = measure(std, bytes, size);
  const tx = x + Math.max(0, (w - tw) / 2);
  const ty = y + Math.max(0, (h - size) / 2) + size * 0.2;
  const [r, g, b] = color;
  return `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n` +
    `${num(tx)} ${num(ty)} Td\n${serializeString(bytes)} Tj\nET\n`;
}

/** The icon XObject's natural size, and which kind it is. A form (what this
 *  builds today) carries the size in /BBox and draws over it; an image carries
 *  /Width and /Height and draws into the unit square. Both are read because a
 *  button written by an earlier release stored the image directly, and
 *  restyling one must still find its size. */
function iconSize(
  doc: Document, iconDict: PdfDict,
): { w: number; h: number; form: boolean } | undefined {
  const bbox = doc.resolve(iconDict.get('BBox'));
  if (isArray(bbox) && bbox.length >= 4) {
    const n = bbox.map((v) => doc.resolve(v));
    if (n.every((v) => typeof v === 'number')) {
      const w = Math.abs((n[2] as number) - (n[0] as number));
      const h = Math.abs((n[3] as number) - (n[1] as number));
      if (w > 0 && h > 0) return { w, h, form: true };
    }
  }
  const iw = doc.resolve(iconDict.get('Width'));
  const ih = doc.resolve(iconDict.get('Height'));
  if (typeof iw !== 'number' || typeof ih !== 'number' || iw <= 0 || ih <= 0) return undefined;
  return { w: iw, h: ih, form: false };
}

/** Ops drawing the icon aspect-fit and centred in [x, y, w, h]. Takes the icon
 *  dict rather than a BuiltImage: the regenerate path has only the object the
 *  previous build allocated. */
function iconOps(
  doc: Document, iconDict: PdfDict, rect: [number, number, number, number],
): string {
  const [x, y, w, h] = rect;
  const size = iconSize(doc, iconDict);
  if (!size) return '';
  const scale = Math.min(w / size.w, h / size.h);
  const dw = size.w * scale;
  const dh = size.h * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  // A form is already its own size, so it is only scaled; an image draws into
  // the unit square, so the same `cm` has to carry the size too.
  const sx = size.form ? scale : dw;
  const sy = size.form ? scale : dh;
  return `q\n${num(sx)} 0 0 ${num(sy)} ${num(dx)} ${num(dy)} cm\n/${ICON_KEY} Do\nQ\n`;
}

/** Resource key the image sits under inside the icon form XObject. */
const ICON_IMAGE_KEY = 'Im0';

/** Wrap an allocated image XObject in the form XObject /MK /I requires
 *  (table 189). The form draws the image over its own /BBox, so every consumer
 *  — our appearance streams and any viewer regenerating the face — places one
 *  object with one natural size. */
function iconForm(doc: Document, imageRef: PdfRef, iw: number, ih: number): PdfStream {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [0, 0, iw, ih]],
    ['Resources', new Map<string, PdfObject>([
      ['XObject', new Map<string, PdfObject>([[ICON_IMAGE_KEY, imageRef]])],
    ])],
  ]);
  const content = `q\n${num(iw)} 0 0 ${num(ih)} 0 0 cm\n/${ICON_IMAGE_KEY} Do\nQ`;
  return { kind: 'stream', dict, raw: enc(content) };
}

/** The /MK /IF icon-fit dict describing what iconOps actually draws: always
 *  scale (/SW /A), proportionally (/S /P), centred (/A [0.5 0.5]). Without it a
 *  viewer that regenerates the face stretches the icon to fill the box. */
function iconFit(): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('IconFit')],
    ['SW', name('A')],
    ['S', name('P')],
    ['A', [0.5, 0.5]],
  ]);
}

/** Build and install a push button's /N, /R and /D appearance streams.
 *  No-op when the widget has no usable geometry.
 *
 *  The three states differ only in caption and face darkness, so they share one
 *  body builder — a viewer picks the stream, and every one must be complete. */
export function buildPushButtonAP(
  doc: Document, widget: PdfDict, acro: PdfDict, face: PushButtonFace,
  iconRef?: PdfRef,
): void {
  const g = widgetGeom(doc, widget);
  if (!g) return;
  const da = resolveDA(doc, widget, acro);
  const size = da.size > 0 ? da.size : Math.min(12, g.h * 0.5);

  // The icon is one object shared by all three streams rather than three copies.
  // A caller that already has it allocated (the regenerate path) passes the ref,
  // so restyling a button any number of times never duplicates its image.
  let ref = iconRef;
  if (ref === undefined && face.icon) {
    if (face.icon.smask) face.icon.stream.dict.set('SMask', doc.allocObject(face.icon.smask));
    const img = face.icon.stream.dict;
    const iw = doc.resolve(img.get('Width'));
    const ih = doc.resolve(img.get('Height'));
    const imgRef = doc.allocObject(face.icon.stream);
    ref = (typeof iw === 'number' && typeof ih === 'number' && iw > 0 && ih > 0)
      ? doc.allocObject(iconForm(doc, imgRef, iw, ih))
      : imgRef;
    // Publish it as the widget's icon so a viewer can regenerate the face,
    // alongside the fit rules the appearance streams were drawn with.
    let mk = doc.resolve(widget.get('MK'));
    if (!isDict(mk)) { mk = new Map<string, PdfObject>(); widget.set('MK', mk); }
    (mk as PdfDict).set('I', ref);
    (mk as PdfDict).set('IF', iconFit());
  }
  const resolved = ref === undefined ? undefined : doc.resolve(ref);
  const iconDict = isStream(resolved) ? resolved.dict : undefined;

  const build = (caption: string, darken: number) => {
    const mk = mkOps(doc, widget, g, darken);
    const regions = buttonRegions(face.position, g.w, g.h, mk.inset);
    let body = mk.ops;
    if (regions.icon && iconDict) body += iconOps(doc, iconDict, regions.icon);
    if (regions.caption) body += centredCaption(caption, regions.caption, da.std, size, da.color);
    const stream = buildAppearanceXObject(doc, g, da.std, 'Helv', body);
    if (ref) {
      const res = stream.dict.get('Resources') as PdfDict;
      res.set('XObject', new Map<string, PdfObject>([[ICON_KEY, ref]]));
    }
    return doc.allocObject(stream);
  };

  widget.set('AP', new Map<string, PdfObject>([
    ['N', build(face.caption, 1)],
    ['R', build(face.rolloverCaption, 1)],
    ['D', build(face.downCaption, DOWN_DARKEN)],
  ]));
}

/** A /TP value back to its layout name — the inverse of TP_FOR. */
export const POSITION_FOR_TP: Record<number, ButtonIconPosition> =
  Object.fromEntries(BUTTON_POSITIONS.map((p) => [TP_FOR[p], p]));

/** The icon XObject a previous build registered in the /N stream, so a rebuild
 *  reuses that object instead of embedding the image a second time.
 *
 *  Falls back to /MK /I, which is where the specification says a button's icon
 *  lives. A producer that wrote /MK and left the appearance to the viewer has
 *  no /N to read, and without this fallback the rebuild would decide the button
 *  has no icon and quietly drop it. */
function existingIconRef(doc: Document, widget: PdfDict): PdfRef | undefined {
  const ap = doc.resolve(widget.get('AP'));
  const n = isDict(ap) ? doc.resolve((ap as PdfDict).get('N')) : undefined;
  if (isStream(n)) {
    const res = doc.resolve(n.dict.get('Resources'));
    const xo = isDict(res) ? doc.resolve((res as PdfDict).get('XObject')) : undefined;
    const r = isDict(xo) ? (xo as PdfDict).get(ICON_KEY) : undefined;
    if (isRef(r)) return r;
  }
  const mk = doc.resolve(widget.get('MK'));
  const i = isDict(mk) ? (mk as PdfDict).get('I') : undefined;
  return isRef(i) ? i : undefined;
}

/** Rebuild a push button's three appearance streams from what the document
 *  already holds.
 *
 *  The restyle path has no PushButtonFace: the captions, layout and icon were
 *  supplied at creation and now live only in the dict. Everything needed is
 *  still there — /MK /CA, /RC and /AC, /MK /TP, and the icon in the existing
 *  /N stream's resources. Mirrors annotdraw.ts's regenerateAppearance, which
 *  exists for the same reason. */
export function regeneratePushButtonAP(doc: Document, widget: PdfDict, acro: PdfDict): void {
  const mk = doc.resolve(widget.get('MK'));
  const txt = (k: string): string => {
    const v = isDict(mk) ? doc.resolve((mk as PdfDict).get(k)) : undefined;
    return isString(v) ? decodePdfText(v.bytes) : '';
  };
  const caption = txt('CA');
  const tp = isDict(mk) ? doc.resolve((mk as PdfDict).get('TP')) : undefined;
  const iconRef = existingIconRef(doc, widget);
  let position = POSITION_FOR_TP[typeof tp === 'number' ? tp : 0] ?? 'caption-only';
  // An icon-bearing layout with no icon left would draw nothing at all.
  if (!iconRef && position !== 'caption-only') position = 'caption-only';

  buildPushButtonAP(doc, widget, acro, {
    caption,
    rolloverCaption: txt('RC') || caption,
    downCaption: txt('AC') || caption,
    position,
  }, iconRef);
}
