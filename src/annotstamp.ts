// A rubber-stamp annotation's caption box (`v0tz.2`): what the stamp says, and
// how it is drawn. Shared by `Page.AddStamp`, which writes it as the stamp's
// /AP, and by `annotappearance.ts`, which draws it on the fly for a /Stamp a
// producer left without one — one drawing, so the two cannot disagree about
// what a stamp looks like.
//
// A leaf over metrics, encoding and the number/string formatters: no Document,
// no allocation, so the caller decides where the font resource lives.
//
// It is a CAPTION, documented as such, not the standard rubber-stamp artwork:
// those drawings are not ours to bundle, and a legible box reading APPROVED is
// better than a blank rectangle.
import { measure } from './metrics.js';
import { encodeWinAnsi } from './encoding.js';
import { serializeString } from './serialize.js';
import { num } from './pagecontent.js';

/** The font every stamp caption is set in. */
export const STAMP_FONT = 'Helvetica-Bold';

/** The 14 standard stamp names of 32000-1 12.5.6.12, spelled the way the
 *  stamp reads. Matched EXACTLY: a /Name is case-sensitive, and any other name
 *  is drawn as written. */
const STANDARD_CAPTIONS: Readonly<Record<string, string>> = {
  Approved: 'APPROVED',
  Experimental: 'EXPERIMENTAL',
  NotApproved: 'NOT APPROVED',
  AsIs: 'AS IS',
  Expired: 'EXPIRED',
  NotForPublicRelease: 'NOT FOR PUBLIC RELEASE',
  Confidential: 'CONFIDENTIAL',
  Final: 'FINAL',
  Sold: 'SOLD',
  Departmental: 'DEPARTMENTAL',
  ForComment: 'FOR COMMENT',
  TopSecret: 'TOP SECRET',
  Draft: 'DRAFT',
  ForPublicRelease: 'FOR PUBLIC RELEASE',
};

/** The caption for stamp name `n`. The name comes out of a document, so the
 *  table is probed with `hasOwnProperty` — `in` would find
 *  `Object.prototype.constructor` for `/constructor`. */
export function stampCaption(n: string): string {
  return Object.prototype.hasOwnProperty.call(STANDARD_CAPTIONS, n) ? STANDARD_CAPTIONS[n] : n;
}

/** Largest font size for `bytes` fitting ~60% of the box height and 85% of its
 *  width. */
function labelSize(bytes: Uint8Array, w: number, h: number): number {
  let size = Math.min(h * 0.6, 24);
  const avail = w * 0.85;
  const tw = measure(STAMP_FONT, bytes, size);
  if (tw > avail && tw > 0) size = Math.max(4, (size * avail) / tw);
  return size;
}

/** The colour-setting operators for `c`: 1, 3 or 4 components (gray, RGB,
 *  CMYK), stroking then non-stroking. */
function colorOps(c: readonly number[]): [string, string] {
  const n = c.map(num).join(' ');
  if (c.length === 1) return [`${n} G`, `${n} g`];
  if (c.length === 4) return [`${n} K`, `${n} k`];
  return [`${n} RG`, `${n} rg`];
}

/** Content-stream body of a caption box in a `w` x `h` box: a frame in `color`
 *  and `label` centred in bold, set through font resource `fontKey`.
 *  Characters WinAnsi cannot encode are dropped, as for every Standard-14
 *  appearance; the frame is drawn regardless. */
export function stampLabelBody(
  w: number, h: number, label: string, color: readonly number[], fontKey: string,
): string {
  const [stroke, fill] = colorOps(color);
  const bw = Math.max(1, Math.min(w, h) * 0.04);
  const half = bw / 2;
  const bytes = encodeWinAnsi(label);
  const size = labelSize(bytes, w, h);
  const tw = measure(STAMP_FONT, bytes, size);
  const x = (w - tw) / 2;
  const y = (h - size) / 2 + size * 0.2;
  return `${stroke} ${num(bw)} w ${num(half)} ${num(half)} ${num(w - bw)} ${num(h - bw)} re S\n`
    + `BT /${fontKey} ${num(size)} Tf ${fill} ${num(x)} ${num(y)} Td ${serializeString(bytes)} Tj ET`;
}
