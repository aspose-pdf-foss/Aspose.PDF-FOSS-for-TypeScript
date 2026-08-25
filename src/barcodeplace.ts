import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { Layer } from './ocg.js';
import { PdfDict, PdfObject, PdfStream, name } from './types.js';
import { enc } from './serialize.js';
import {
  ensureOwnResources, ensureOwnSubdict, freshKey, appendContent, num,
  registerOcProperty,
} from './pagecontent.js';
import { validateMarkOptions, markDrawing } from './structwrite.js';
import {
  makeCode128, makeEan13, makeUpcA, makeEan8,
  type LinearBarcode, type MatrixBarcode, type BarcodeModel,
} from './barcode.js';
import { makeQr, type QrEcc } from './qr.js';

/** Which barcode to draw. */
export type BarcodeSpec =
  | { type: 'code128'; data: string }
  | { type: 'ean13' | 'upca' | 'ean8'; data: string }
  | { type: 'qr'; data: string; ecc?: QrEcc; version?: number };

export interface AddBarcodeOptions {
  /** 'vector' (filled rectangles, default) or 'raster' (1-bit /ImageMask stencil). */
  render?: 'vector' | 'raster';
  /** Dark-module color (RGB 0..1). Default black. */
  color?: [number, number, number];
  /** Include the symbology's recommended quiet-zone margins. Default true. */
  quietZone?: boolean;
  /** Draw the human-readable payload under a 1D barcode. Default: on for
   *  EAN/UPC, off for Code128; ignored for QR. */
  text?: boolean;
  /** Attach the drawing to an optional-content layer. */
  layer?: Layer;
  /** Tag the drawing into the logical structure tree (marked content). */
  tag?: StructElement;
  /** Create a /Figure carrying this /Alt and tag the drawing into it. Ignored
   *  when `tag` is given, and on a document with no structure tree. */
  alt?: string;
  /** Mark the drawing as an /Artifact — decoration carrying no meaning. Cannot
   *  be combined with `tag` or `alt`. */
  artifact?: boolean;
}

function checkColor(rgb: [number, number, number]): [number, number, number] {
  if (!Array.isArray(rgb) || rgb.length !== 3 ||
      !rgb.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  return rgb;
}

function toModel(spec: BarcodeSpec): BarcodeModel {
  switch (spec.type) {
    case 'code128': return makeCode128(spec.data);
    case 'ean13': return makeEan13(spec.data);
    case 'upca': return makeUpcA(spec.data);
    case 'ean8': return makeEan8(spec.data);
    case 'qr': return makeQr(spec.data, { ecc: spec.ecc, version: spec.version });
    default: throw new TypeError(`AddBarcode: unknown barcode type '${(spec as { type: string }).type}'`);
  }
}

/** A dark rectangle in PDF user space. */
interface Rect { x: number; y: number; w: number; h: number; }

/** Compute the dark rectangles for a 1D barcode filling `[x, y+textStrip, w, barsH]`. */
function linearRects(m: LinearBarcode, x: number, yBars: number, w: number, barsH: number, quiet: boolean): Rect[] {
  const qL = quiet ? m.quietLeft : 0;
  const qR = quiet ? m.quietRight : 0;
  const total = qL + m.modules.reduce((a, b) => a + b, 0) + qR;
  const u = w / total;
  const rects: Rect[] = [];
  let cursor = x + qL * u;
  for (let i = 0; i < m.modules.length; i++) {
    const runW = m.modules[i] * u;
    if (i % 2 === 0) rects.push({ x: cursor, y: yBars, w: runW, h: barsH }); // bar
    cursor += runW;
  }
  return rects;
}

/** Geometry of a matrix barcode centered in `rect`. */
function matrixLayout(m: MatrixBarcode, x: number, y: number, w: number, h: number, quiet: boolean) {
  const q = quiet ? 4 : 0;
  const wq = m.size + 2 * q;
  const u = Math.min(w, h) / wq;
  const side = wq * u;
  const x0 = x + (w - side) / 2;
  const yTop = y + (h - side) / 2 + side; // top edge of the square
  return { q, wq, u, side, x0, yTop };
}

function matrixRects(m: MatrixBarcode, x: number, y: number, w: number, h: number, quiet: boolean): Rect[] {
  const { q, u, x0, yTop } = matrixLayout(m, x, y, w, h, quiet);
  const rects: Rect[] = [];
  for (let my = 0; my < m.size; my++) for (let mx = 0; mx < m.size; mx++) {
    if (!m.dark[my * m.size + mx]) continue;
    rects.push({ x: x0 + (q + mx) * u, y: yTop - (q + my + 1) * u, w: u, h: u });
  }
  return rects;
}

/** Pack a 1-bit MSB-first raster (rows byte-aligned). */
function packBits(width: number, height: number, get: (r: number, c: number) => boolean): Uint8Array {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    if (get(r, c)) out[r * rowBytes + (c >> 3)] |= 0x80 >> (c & 7);
  }
  return out;
}

function colorOp(c: [number, number, number]): string {
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} rg`;
}

/** Draw `spec` into `rect` (PDF user space). Existing content is preserved. */
export function addBarcode(
  doc: Document, page: Page, spec: BarcodeSpec,
  rect: [number, number, number, number], opts: AddBarcodeOptions = {},
): void {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] (4 finite numbers)');
  validateMarkOptions(opts); // before anything is drawn or allocated
  const [x, y, w, h] = rect;
  const color = opts.color ? checkColor(opts.color) : [0, 0, 0] as [number, number, number];
  const quiet = opts.quietZone !== false;
  const model = toModel(spec);

  // Human-readable text: default on for EAN/UPC, off for Code128, n/a for QR.
  const textDefault = spec.type === 'ean13' || spec.type === 'upca' || spec.type === 'ean8';
  const textEnabled = model.kind === 'linear' && (opts.text ?? textDefault) && !!model.text;
  const textStrip = textEnabled ? Math.min(0.2 * h, 12) : 0;
  const barsH = h - textStrip;
  const yBars = y + textStrip;

  let body: Uint8Array;
  if (opts.render === 'raster') {
    body = enc(rasterContent(doc, page, model, x, yBars, w, barsH, quiet, color, opts.layer));
  } else {
    const rects = model.kind === 'linear'
      ? linearRects(model, x, yBars, w, barsH, quiet)
      : matrixRects(model, x, y, w, h, quiet);
    let s = `q\n${colorOp(color)}\n`;
    for (const r of rects) s += `${num(r.x)} ${num(r.y)} ${num(r.w)} ${num(r.h)} re\n`;
    s += 'f\nQ';
    if (opts.layer) {
      const key = registerOcProperty(doc, page, opts.layer.Ref);
      s = `/OC /${key} BDC\n${s}\nEMC`;
    }
    body = enc(s);
  }

  appendContent(doc, page, markDrawing(doc, page, body, opts));

  if (textEnabled && model.text) {
    const fs = Math.max(4, Math.min(textStrip, 10));
    const tw = page.MeasureText(model.text, fs, 'Helvetica');
    const tx = x + Math.max(0, (w - tw) / 2);
    page.AddText(model.text, tx, y + 2, { font: 'Helvetica', fontSize: fs, color });
  }
}

/** Build the /ImageMask XObject + its draw op; returns the content-stream body. */
function rasterContent(
  doc: Document, page: Page, model: BarcodeModel,
  x: number, yBars: number, w: number, barsH: number,
  quiet: boolean, color: [number, number, number], layer?: Layer,
): string {
  let width: number, height: number, raw: Uint8Array;
  let cm: string;
  if (model.kind === 'linear') {
    const qL = quiet ? model.quietLeft : 0;
    const qR = quiet ? model.quietRight : 0;
    // Expand run-lengths to a per-module dark flag row (quiet modules light).
    const cols: boolean[] = new Array(qL).fill(false);
    for (let i = 0; i < model.modules.length; i++) {
      const dark = i % 2 === 0;
      for (let k = 0; k < model.modules[i]; k++) cols.push(dark);
    }
    for (let k = 0; k < qR; k++) cols.push(false);
    width = cols.length; height = 1;
    raw = packBits(width, height, (_r, c) => cols[c]);
    cm = `${num(w)} 0 0 ${num(barsH)} ${num(x)} ${num(yBars)} cm`;
  } else {
    const { q, wq, side, x0, yTop } = matrixLayout(model, x, yBars, w, barsH, quiet);
    width = wq; height = wq;
    raw = packBits(width, height, (r, c) => {
      const mx = c - q, my = r - q;
      if (mx < 0 || my < 0 || mx >= model.size || my >= model.size) return false;
      return model.dark[my * model.size + mx];
    });
    // Image space maps [0,1]x[0,1] with row 0 at top; place the square with top at yTop.
    cm = `${num(side)} 0 0 ${num(side)} ${num(x0)} ${num(yTop - side)} cm`;
  }

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Image')],
    ['Width', width],
    ['Height', height],
    ['BitsPerComponent', 1],
    ['ImageMask', true],
    ['Decode', [1, 0]],
  ]);
  if (layer) dict.set('OC', layer.Ref);
  const stream: PdfStream = { kind: 'stream', dict, raw };

  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Bc');
  xobjs.set(key, doc.allocObject(stream));

  return `q\n${colorOp(color)}\n${cm}\n/${key} Do\nQ`;
}
