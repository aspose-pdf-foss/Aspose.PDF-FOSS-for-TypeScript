import type { Page } from './page.js';
import type { Document } from './document.js';
import { fontResources } from './appearance.js';
import { encodeWinAnsi } from './encoding.js';
import { measure } from './metrics.js';
import { appendContent, ensureOwnSubdict, ensureUnsharedResources, freshKey, num, wrapArtifact } from './pagecontent.js';
import { enc, serializeString } from './serialize.js';
import type { Rect } from './text.js';
import { isArray, name, type PdfDict, type PdfObject, type PdfStream } from './types.js';

export const PrinterMarkCornerPosition = {
  TopLeft: 'TopLeft', TopRight: 'TopRight', BottomLeft: 'BottomLeft', BottomRight: 'BottomRight',
} as const;
export type PrinterMarkCornerPosition = keyof typeof PrinterMarkCornerPosition;

export const PrinterMarkSidePosition = { Top: 'Top', Bottom: 'Bottom', Left: 'Left', Right: 'Right' } as const;
export type PrinterMarkSidePosition = keyof typeof PrinterMarkSidePosition;

export const ColorsOfCMYK = { Cyan: 'Cyan', Magenta: 'Magenta', Yellow: 'Yellow', Black: 'Black' } as const;
export type ColorsOfCMYK = keyof typeof ColorsOfCMYK;

export type PrinterMarkKind = 'trim' | 'bleed' | 'registration' | 'colorBar' | 'pageInformation';
export interface PageInformationOptions {
  /** Optional job or file label in printable WinAnsi characters. */
  label?: string;
  /** Optional date and time to print in ISO 8601 format (UTC). */
  timestamp?: Date;
}
export interface PrinterMarksOptions {
  /** Defaults to trim, bleed, registration and colorBar. */
  kinds?: readonly PrinterMarkKind[];
  /** Separate annotations by default, or graphics appended to the page. */
  mode?: 'annotation' | 'content';
  /** Grow the crop to display the new marks. Defaults to true. */
  expandCropBox?: boolean;
  /** Text to include alongside the 1-based page number for pageInformation. */
  pageInformation?: PageInformationOptions;
}

export interface DocumentPrinterMarksOptions extends PrinterMarksOptions {
  /** 1-based page numbers or a range such as '1-3,5'. Defaults to every page. */
  pages?: number[] | string;
}

const ALL_KINDS: readonly PrinterMarkKind[] = ['trim', 'bleed', 'registration', 'colorBar'];
const CHANNELS = Object.values(ColorsOfCMYK);
const STROKE = 0.5;
const BAR_GAP = 26;
const BAR_HEIGHT = 8;
const TINT_STEPS = 10;

interface PrintBoxes {
  media: Rect;
  crop: Rect;
  trim: Rect;
  bleed: Rect;
  usesArtBox: boolean;
  /** Keep the ink outside both the trim and bleed boundaries. */
  protected: Rect;
}

export interface MarkDrawing {
  markName: 'TrimMark' | 'BleedMark' | 'RegistrationTarget' | 'ColorBar' | 'PageInformation';
  rect: Rect;
  body: string;
  contents?: string;
}

function orderedBox(value: number[], label: string): Rect {
  const [x0, y0, x1, y1] = value;
  if (!Array.isArray(value) || value.length !== 4 || ![x0, y0, x1, y1].every(Number.isFinite) ||
      !Number.isFinite(x1 - x0) || !Number.isFinite(y1 - y0) || x0 === x1 || y0 === y1) {
    throw new RangeError(`${label} must be a finite, nonempty rectangle`);
  }
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function printerMarkBoxes(page: Page): PrintBoxes {
  const media = orderedBox(page.MediaBox, 'MediaBox');
  const crop = orderedBox(page.CropBox, 'CropBox');
  const usesArtBox = !hasOwnBox(page, 'TrimBox') && hasOwnBox(page, 'ArtBox');
  const trim = usesArtBox ? orderedBox(page.ArtBox, 'ArtBox') : orderedBox(page.TrimBox, 'TrimBox');
  // A document without a declared bleed has no separate bleed boundary for
  // prepress. Keep it optional, including when the page crop later changes.
  const bleed = hasOwnBox(page, 'BleedBox') ? orderedBox(page.BleedBox, 'BleedBox') : trim;
  return { media, crop, trim, bleed, usesArtBox, protected: union(trim, bleed) };
}

function hasOwnBox(page: Page, key: 'TrimBox' | 'ArtBox' | 'BleedBox'): boolean {
  const doc = page.Document;
  const entry = doc.resolve(page.Dict.get(key));
  return isArray(entry) && entry.length === 4 && entry.every((value) => typeof doc.resolve(value) === 'number');
}

function sameBox(a: number[], b: Rect): boolean {
  return Math.min(a[0], a[2]) === b[0] && Math.min(a[1], a[3]) === b[1] &&
    Math.max(a[0], a[2]) === b[2] && Math.max(a[1], a[3]) === b[3];
}

export function fittedPrinterBoxes(boxes: PrintBoxes, marks: MarkDrawing[], expandCropBox: boolean): PrintBoxes {
  const ink = marks.map((mark) => orderedBox(mark.rect, 'printer mark bounds')).reduce(union);
  const crop = expandCropBox ? union(boxes.crop, ink) : boxes.crop;
  const media = orderedBox(union(union(boxes.media, crop), ink), 'expanded MediaBox');
  return { ...boxes, crop, media };
}

export function applyPrinterBoxes(page: Page, boxes: PrintBoxes): void {
  const { crop, media } = boxes;
  if (!sameBox(page.MediaBox, media)) page.MediaBox = media;
  if (!sameBox(page.CropBox, crop)) page.CropBox = crop;
  // Capture a crop-defined finish before a growing crop can move it.
  // Keep an explicit ArtBox-only finish and each declared BleedBox intact.
  if (!boxes.usesArtBox && !sameBox(page.TrimBox, boxes.trim)) page.TrimBox = boxes.trim;
  const doc = page.Document;
  // The layout may materialize print boxes, and /PrinterMark and the catalog
  // version entry require PDF 1.4. This works for incremental saves too.
  if (/^1\.[0-3]$/.test(doc.headerVersion() ?? '')) doc.catalog().set('Version', name('1.4'));
}

type Segment = [number, number, number, number];

function lines(segments: Segment[], origin: Rect): string {
  const [x, y] = origin;
  return segments.map(([x1, y1, x2, y2]) =>
    `${num(x1 - x)} ${num(y1 - y)} m ${num(x2 - x)} ${num(y2 - y)} l`,
  ).join('\n');
}

export function cornerMark(
  boxes: PrintBoxes, kind: 'trim' | 'bleed', corner: PrinterMarkCornerPosition,
): MarkDrawing {
  if (!Object.hasOwn(PrinterMarkCornerPosition, corner)) throw new RangeError('invalid printer mark corner');
  const isLeft = corner === 'TopLeft' || corner === 'BottomLeft';
  const isTop = corner === 'TopLeft' || corner === 'TopRight';
  const [left, bottom, right, top] = boxes[kind];
  const [outerLeft, outerBottom, outerRight, outerTop] = boxes.protected;
  const dx = isLeft ? -1 : 1;
  const dy = isTop ? 1 : -1;
  const half = STROKE / 2;
  // Align the inside edges of the strokes with the cut. Padding a stroke
  // centered on the cut would put the annotation rectangle inside the trim.
  const x = (isLeft ? left : right) + dx * half;
  const y = (isTop ? top : bottom) + dy * half;
  // Separate the two sets of cuts even if the producer omitted BleedBox.
  const gap = kind === 'trim' ? 4 : 19;
  const length = kind === 'trim' ? 12 : 8;
  const sx = (isLeft ? outerLeft : outerRight) + dx * gap;
  const sy = (isTop ? outerTop : outerBottom) + dy * gap;
  const ex = sx + dx * length;
  const ey = sy + dy * length;
  const rect: Rect = [isLeft ? ex - half : right, isTop ? top : ey - half,
    isLeft ? left : ex + half, isTop ? ey + half : bottom];
  const path = lines([[sx, y, ex, y], [x, sy, x, ey]], rect);
  const dash = kind === 'bleed' ? '[2 2] 0 d\n' : '';
  return {
    markName: kind === 'trim' ? 'TrimMark' : 'BleedMark',
    rect,
    body: `0 0 0 1 K\n${STROKE} w\n${dash}${path}\nS`,
  };
}

/** Circle and crosshair in a ten-point square, with a half-stroke at each edge. */
const TARGET = [
  '/Registration CS 1 SCN', `${STROKE} w`,
  '8.75 5.25 m 8.75 7.183 7.183 8.75 5.25 8.75 c',
  '3.317 8.75 1.75 7.183 1.75 5.25 c',
  '1.75 3.317 3.317 1.75 5.25 1.75 c',
  '7.183 1.75 8.75 3.317 8.75 5.25 c h',
  '0.25 5.25 m 10.25 5.25 l', '5.25 0.25 m 5.25 10.25 l', 'S',
].join('\n');

export function registrationMark(boxes: PrintBoxes, side: PrinterMarkSidePosition): MarkDrawing {
  if (!Object.hasOwn(PrinterMarkSidePosition, side)) throw new RangeError('invalid printer mark side');
  const [left, bottom, right, top] = boxes.trim;
  const [outerLeft, outerBottom, outerRight, outerTop] = boxes.protected;
  const distance = 11;
  const x = side === 'Left' ? outerLeft - distance : side === 'Right' ? outerRight + distance : left + (right - left) / 2;
  const y = side === 'Bottom' ? outerBottom - distance : side === 'Top' ? outerTop + distance : bottom + (top - bottom) / 2;
  const radius = 5.25;
  return { markName: 'RegistrationTarget', rect: [x - radius, y - radius, x + radius, y + radius], body: TARGET };
}

function barMark(rect: Rect, channel: ColorsOfCMYK, horizontal: boolean): MarkDrawing {
  const width = rect[2] - rect[0], height = rect[3] - rect[1];
  const length = horizontal ? width : height;
  const channelIndex = CHANNELS.indexOf(channel);
  if (channelIndex < 0) throw new RangeError('invalid CMYK channel for printer color bar');
  const patches: string[] = [];
  for (let step = 0; step <= TINT_STEPS; step++) {
    const tint = [0, 0, 0, 0];
    tint[channelIndex] = step / TINT_STEPS;
    const start = length * (step / (TINT_STEPS + 1));
    const end = length * ((step + 1) / (TINT_STEPS + 1));
    const patch = horizontal ? [start, 0, end - start, height] : [0, start, width, end - start];
    patches.push(`${tint.map(num).join(' ')} k ${patch.map(num).join(' ')} re f`);
  }
  return { markName: 'ColorBar', rect, body: patches.join('\n') };
}

export function colorBarMark(boxes: PrintBoxes, input: Rect, channel: ColorsOfCMYK): MarkDrawing {
  if (!Array.isArray(input)) throw new TypeError('color bar rectangle must be an array');
  const rect = orderedBox(input, 'color bar rectangle');
  const [x0, y0, x1, y1] = rect;
  const [left, bottom, right, top] = boxes.protected;
  const horizontal = x1 - x0 >= y1 - y0;
  if (x1 <= left || x0 >= right || y1 <= bottom || y0 >= top) return barMark(rect, channel, horizontal);

  // Move the bar along its short axis to clear the protected print area.
  const gap = 2;
  if (horizontal) {
    const below = bottom - y1 - gap, above = top - y0 + gap;
    const dy = -below <= above ? below : above;
    return barMark([x0, y0 + dy, x1, y1 + dy], channel, horizontal);
  }
  const toLeft = left - x1 - gap, toRight = right - x0 + gap;
  const dx = -toLeft <= toRight ? toLeft : toRight;
  return barMark([x0 + dx, y0, x1 + dx, y1], channel, horizontal);
}

export function pageInformationText(page: Page, { label, timestamp }: PageInformationOptions = {}): string {
  if (label !== undefined && typeof label !== 'string') throw new TypeError('page information label must be a string');
  if (timestamp !== undefined && (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())))
    throw new TypeError('page information timestamp must be a valid Date');
  return [label, `Page ${page.Number}`, timestamp?.toISOString()].filter(Boolean).join('  ');
}

export function pageInformationMark(input: Rect, contents: string): MarkDrawing {
  const rect = orderedBox(input, 'page information rectangle');
  const [x0, y0, x1, y1] = rect;
  const bytes = encodeWinAnsi(contents);
  if (bytes.length !== contents.length) throw new RangeError('page information text requires printable WinAnsi characters');
  const width = measure('Helvetica', bytes, 1);
  const size = Math.min(6, (y1 - y0) / 1.25, width > 0 ? (x1 - x0) / width : 6);
  const y = (y1 - y0 - size) / 2 + size * 0.2;
  return { markName: 'PageInformation', rect, contents,
    body: `0 0 0 1 k\nBT /Helv ${num(size)} Tf 0 ${num(y)} Td ${serializeString(bytes)} Tj ET` };
}

export function planPrinterMarks(page: Page, boxes: PrintBoxes, kinds: readonly PrinterMarkKind[] = ALL_KINDS,
  info?: PageInformationOptions): MarkDrawing[] {
  if (!Array.isArray(kinds)) throw new TypeError('kinds must be an array of printer mark kinds');
  const marks: MarkDrawing[] = [];
  for (const kind of new Set(kinds)) {
    switch (kind) {
      case 'trim':
      case 'bleed':
        for (const corner of Object.values(PrinterMarkCornerPosition)) marks.push(cornerMark(boxes, kind, corner));
        break;
      case 'registration':
        for (const side of Object.values(PrinterMarkSidePosition)) marks.push(registrationMark(boxes, side));
        break;
      case 'colorBar': {
        const [left, , right] = boxes.trim;
        const pageWidth = right - left;
        const width = Math.min(160, pageWidth * 0.75);
        const x = left + (pageWidth - width) / 2;
        const y = boxes.protected[1] - BAR_GAP;
        const height = Math.min(BAR_HEIGHT, width / CHANNELS.length);
        CHANNELS.forEach((channel, i) => {
          const start = x + width * (i / CHANNELS.length);
          const end = x + width * ((i + 1) / CHANNELS.length);
          marks.push(barMark([start, y - height, end, y], channel, true));
        });
        break;
      }
      case 'pageInformation': {
        // The targets and corner marks share the first 27.25 points outside
        // the bleed. Give the caption its own row beyond their furthest ink.
        const y = boxes.protected[3] + 30;
        marks.push(pageInformationMark([boxes.trim[0], y, boxes.trim[2], y + 8], pageInformationText(page, info)));
        break;
      }
      default:
        throw new RangeError('unknown printer mark kind');
    }
  }
  return marks;
}

export function printerMarkForm(doc: Document, mark: MarkDrawing): PdfStream {
  const resources: PdfDict = mark.markName === 'PageInformation' ? fontResources(doc, 'Helvetica', 'Helv') : new Map();
  if (mark.markName === 'RegistrationTarget') {
    const tint = new Map<string, PdfObject>([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1], ['C0', [0, 0, 0, 0]], ['C1', [1, 1, 1, 1]],
    ]);
    const all = [name('Separation'), name('All'), name('DeviceCMYK'), tint];
    resources.set('ColorSpace', new Map<string, PdfObject>([['Registration', all]]));
  }
  const [x0, y0, x1, y1] = mark.rect;
  return {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', 1],
      ['BBox', [0, 0, x1 - x0, y1 - y0]], ['Resources', resources],
    ]),
    raw: enc(`q\n${mark.body}\nQ\n`),
  };
}

export function paintPrinterMarks(page: Page, marks: MarkDrawing[]): void {
  const doc = page.Document;
  const xobjects = ensureOwnSubdict(doc, ensureUnsharedResources(doc, page), 'XObject');
  const commands: string[] = [];
  for (const mark of marks) {
    const key = freshKey(xobjects, 'PrinterMark');
    xobjects.set(key, doc.allocObject(printerMarkForm(doc, mark)));
    commands.push(`q 1 0 0 1 ${num(mark.rect[0])} ${num(mark.rect[1])} cm /${key} Do Q`);
  }
  appendContent(doc, page, wrapArtifact(enc(commands.join('\n'))));
  doc.markModified();
}
