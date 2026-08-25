import { X509Certificate } from 'node:crypto';
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, PdfRef } from './types.js';
import { num } from './pagecontent.js';
import { serializeString } from './serialize.js';
import { encodeWinAnsi } from './encoding.js';
import { measure } from './metrics.js';
import { buildAppearanceXObject, type WidgetGeom } from './appearance.js';
import { buildImageXObject } from './imageembed.js';
import type { SignOptions, SignatureAppearance } from './signature.js';

/** Visible-signature appearance rendering (issue stw.9, F2): turn a
 *  {@link SignatureAppearance} request into a `/Form` XObject — a name/date/
 *  reason text block, an optional image to its left, or both — reusing the form
 *  field appearance envelope in `appearance.ts` and the image embedding in
 *  `imageembed.ts`. The widget wiring (page, /Rect, /AP install) lives in
 *  `Document.installSignatureField`. */

/** Font face + resource key for the generated text (Standard-14 Helvetica). */
const STD = 'Helvetica';
const FONT_KEY = 'Helv';
/** Inner padding inside the box, in points. */
const PAD = 4;
/** Fraction of the box width given to the image when text sits beside it. */
const IMAGE_FRACTION = 0.4;

interface Region { x: number; y: number; w: number; h: number }

/** The display name for the appearance: the explicit `/Name`, else the signer
 *  certificate's subject common name, else the whole subject. */
export function signerDisplayName(opts: SignOptions, certificate: Uint8Array): string {
  if (opts.name) return opts.name;
  const subject = new X509Certificate(Buffer.from(certificate)).subject;
  const cn = subject.split('\n').find((l) => l.startsWith('CN='));
  return cn ? cn.slice(3).trim() : subject.replace(/\n+/g, ', ');
}

/** A readable UTC timestamp `YYYY-MM-DD HH:MM:SS UTC` for the appearance text. */
function formatDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

/** Default appearance text: a name/date/reason/location block from `opts`. */
export function defaultAppearanceText(opts: SignOptions, signingTime: Date, displayName: string): string {
  const lines = [`Digitally signed by ${displayName}`, `Date: ${formatDate(signingTime)}`];
  if (opts.reason) lines.push(`Reason: ${opts.reason}`);
  if (opts.location) lines.push(`Location: ${opts.location}`);
  return lines.join('\n');
}

/** Greedy word-wrap of one paragraph to `maxW` at `size`; never empty. */
function wrap(para: string, size: number, maxW: number): string[] {
  const words = para.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (cur === '' || measure(STD, encodeWinAnsi(trial), size) <= maxW) cur = trial;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Content ops drawing `text` top-aligned in `region`, shrinking the font until
 *  every wrapped line fits the height (floor 4pt). */
function drawText(text: string, region: Region): string {
  const paras = text.split('\n');
  let size = 10;
  let lines: string[] = [];
  for (;;) {
    lines = [];
    for (const p of paras) lines.push(...wrap(p, size, region.w));
    if (lines.length * size * 1.2 <= region.h || size <= 4) break;
    size = Math.max(4, size - 0.5);
  }
  const leading = size * 1.2;
  const baseline = region.y + region.h - size; // first line near the top
  let s = `BT\n/${FONT_KEY} ${num(size)} Tf\n${num(leading)} TL\n0 g\n` +
    `${num(region.x)} ${num(baseline)} Td\n`;
  lines.forEach((ln, i) => {
    if (i > 0) s += 'T*\n';
    s += `${serializeString(encodeWinAnsi(ln))} Tj\n`;
  });
  return s + 'ET\n';
}

/** Content ops painting image `key` (intrinsic `iw`x`ih`) scaled to fit
 *  `region` while preserving aspect ratio, centered. */
function drawImage(key: string, iw: number, ih: number, region: Region): string {
  const scale = Math.min(region.w / iw, region.h / ih);
  const dw = iw * scale, dh = ih * scale;
  const dx = region.x + (region.w - dw) / 2;
  const dy = region.y + (region.h - dh) / 2;
  return `q\n${num(dw)} 0 0 ${num(dh)} ${num(dx)} ${num(dy)} cm\n/${key} Do\nQ\n`;
}

/** Build the visible signature `/AP /N` Form XObject for `app`. Allocates the
 *  font (via the appearance envelope) and any image XObject in `doc`; the caller
 *  allocates the returned stream and snapshots all newly created objects (for
 *  the incremental-update delta). Throws on a degenerate (zero-area) rect. */
export function buildSignatureAppearance(
  doc: Document, app: SignatureAppearance, text: string,
): PdfStream {
  const [x1, y1, x2, y2] = app.rect;
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  if (!(w > 1e-3) || !(h > 1e-3))
    throw new TypeError('signature appearance: rect must have a positive area');
  const g: WidgetGeom = { w, h, rotate: 0 };

  const hasText = text.length > 0;
  let body = '';
  let imgRef: PdfRef | undefined;
  let imgKey: string | undefined;

  if (app.image) {
    const built = buildImageXObject(app.image);
    if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
    imgRef = doc.allocObject(built.stream);
    imgKey = 'Im0';
    const iw = built.stream.dict.get('Width') as number;
    const ih = built.stream.dict.get('Height') as number;
    const region: Region = hasText
      ? { x: PAD, y: PAD, w: IMAGE_FRACTION * w - PAD, h: h - 2 * PAD }
      : { x: PAD, y: PAD, w: w - 2 * PAD, h: h - 2 * PAD };
    body += drawImage(imgKey, iw, ih, region);
  }

  if (hasText) {
    const region: Region = imgRef
      ? { x: IMAGE_FRACTION * w + PAD, y: PAD, w: (1 - IMAGE_FRACTION) * w - 2 * PAD, h: h - 2 * PAD }
      : { x: PAD, y: PAD, w: w - 2 * PAD, h: h - 2 * PAD };
    body += drawText(text, region);
  }

  const stream = buildAppearanceXObject(doc, g, STD, FONT_KEY, body);
  if (imgRef && imgKey) {
    const res = stream.dict.get('Resources') as PdfDict;
    res.set('XObject', new Map<string, PdfObject>([[imgKey, imgRef]]));
  }
  return stream;
}
