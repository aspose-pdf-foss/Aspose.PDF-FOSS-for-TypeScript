// JBIG2 halftone decode — ITU-T T.88 §6.7 (pattern dictionary), Annex C.5
// (grayscale image) and §6.6 (halftone region).
//
// This is the one JBIG2 construct that is not a bilevel decode. Every other
// region decodes pixels; a halftone region decodes NUMBERS — a grid of
// `HGW x HGH` cells, each an index into a referred-to pattern dictionary — and
// then stamps the pattern each cell names. The numbers arrive as
// `ceil(log2(HNUMPATS))` separate bitplanes, each an ordinary generic region,
// Gray-coded and most-significant plane first.
//
// Pure: it takes the pattern dictionary as an argument and knows nothing about
// segments, the same split jbig2refine.ts makes.
import { PdfParseError } from './errors.js';
import { MqDecoder } from './jpxmq.js';
import { decodeGeneric, decodeMmrBitmap } from './jbig2generic.js';
import { newBitmap, combine, type Bitmap } from './jbig2.js';

/** An adaptive-pixel list for `decodeGeneric`. Templates 1-3 take ONE adaptive
 *  pixel and template 0 takes four (T.88 §6.2.5.3) — `buildTemplate` appends
 *  every entry it is given, so handing a template-1 decode four of them widens
 *  the context from 13 bits to 15 and decodes noise. */
function atFor(template: number, at1: { x: number; y: number }): Array<{ x: number; y: number }> {
  const at = [at1, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }];
  return template === 0 ? at : at.slice(0, 1);
}

/** The collective bitmap's adaptive-template pixels (T.88 §6.7.5). AT1 is
 *  pinned at `(-HDPW, 0)` — the same column of the PREVIOUS pattern, which is
 *  the correlation the collective layout exists to exploit; the rest are the
 *  nominal set. Published constants, so its test is a transcription check and
 *  NOT an independent decode: a round trip cannot see this at all, because our
 *  own encoder reads the same line of T.88. */
export function patternDictAt(patternWidth: number, template: number): Array<{ x: number; y: number }> {
  return atFor(template, { x: -patternWidth, y: 0 });
}

/** The grayscale bitplanes' adaptive-template pixels (T.88 §6.6.5.1): the
 *  nominal set, whose AT1 moves with the template. */
export function grayscaleAt(template: number): Array<{ x: number; y: number }> {
  return atFor(template, { x: template <= 1 ? 3 : 2, y: -1 });
}

export interface PatternDictParams {
  mmr: boolean; template: number;
  /** HDPW / HDPH: every pattern is this size. */
  patternWidth: number; patternHeight: number;
  /** GRAYMAX: the dictionary holds `grayMax + 1` patterns. */
  grayMax: number;
}

// A damage guard, not a format limit. This is the one place in JBIG2 where a
// PRODUCT of three header fields sizes an allocation — a single u32 region
// dimension is left to fail as it does everywhere else in the decoder, but
// (GRAYMAX+1)·HDPW·HDPH from a corrupt header reaches 10^14 without trying.
const MAX_COLLECTIVE_PIXELS = 1 << 26;

/** Decode a pattern dictionary (T.88 §6.7.5). Note there is exactly ONE
 *  bitmap on the wire: a collective `(GRAYMAX+1)·HDPW` wide and `HDPH` tall,
 *  sliced into patterns afterwards. */
export function decodePatternDict(
  data: Uint8Array, start: number, end: number, prm: PatternDictParams,
): Bitmap[] {
  const pw = prm.patternWidth, ph = prm.patternHeight;
  if (pw <= 0 || ph <= 0) {
    throw new PdfParseError('JBIG2: pattern dictionary with a zero-size pattern', start);
  }
  const count = prm.grayMax + 1;
  const collectiveWidth = count * pw;
  if (collectiveWidth * ph > MAX_COLLECTIVE_PIXELS) {
    throw new PdfParseError(`JBIG2: pattern dictionary collective bitmap too large (${collectiveWidth}x${ph})`, start);
  }
  const collective = decodeGeneric(data, start, end, {
    width: collectiveWidth, height: ph, template: prm.template,
    at: patternDictAt(pw, prm.template), tpgdon: false, mmr: prm.mmr,
  });
  const out: Bitmap[] = [];
  for (let i = 0; i < count; i++) {
    const p = newBitmap(pw, ph);
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) p.data[y * pw + x] = collective.data[y * collectiveWidth + i * pw + x];
    }
    out.push(p);
  }
  return out;
}

/** The four fields a cell's position depends on, so the geometry is testable on
 *  its own. HGX/HGY are signed and in 1/256 pel; HRX/HRY are the grid vectors
 *  in 8.8 fixed point. */
export interface HalftoneGrid { gridX: number; gridY: number; vectorX: number; vectorY: number }

/** A cell's top-left corner in region pixels (T.88 §6.6.5.2).
 *
 *  The CROSS TERMS are load-bearing and do not fail loudly when wrong:
 *  transposing HRX and HRY renders the screen rotated, which reads as an
 *  unusual halftone rather than as a decode fault. `>>` floors toward negative
 *  infinity as T.88 requires, where `| 0` truncates toward zero — they agree
 *  for every non-negative origin, so only a grid starting off the left or top
 *  edge distinguishes them, which is what HGX/HGY being signed is for. */
export function cellOrigin(g: HalftoneGrid, mg: number, ng: number): { x: number; y: number } {
  return {
    x: (g.gridX + mg * g.vectorY + ng * g.vectorX) >> 8,
    y: (g.gridY + mg * g.vectorX - ng * g.vectorY) >> 8,
  };
}

/** What `halftoneSkip` needs: the region, the grid and the pattern size. */
export interface SkipInput extends HalftoneGrid {
  width: number; height: number;
  gridWidth: number; gridHeight: number;
  patternWidth: number; patternHeight: number;
}

/** HSKIP (T.88 §6.6.5.1): the cells whose stamp falls ENTIRELY outside the
 *  region. `HGW x HGH`, indexed `[mg * HGW + ng]`. A cell that merely overhangs
 *  an edge is decoded normally and clipped when it is drawn. */
export function halftoneSkip(s: SkipInput): Bitmap {
  const skip = newBitmap(s.gridWidth, s.gridHeight);
  for (let mg = 0; mg < s.gridHeight; mg++) {
    for (let ng = 0; ng < s.gridWidth; ng++) {
      const { x, y } = cellOrigin(s, mg, ng);
      const off = x + s.patternWidth <= 0 || x >= s.width || y + s.patternHeight <= 0 || y >= s.height;
      if (off) skip.data[mg * s.gridWidth + ng] = 1;
    }
  }
  return skip;
}

/** Annex C.5's Gray-code fold and value assembly. `planes[0]` is the LSB and
 *  `planes[n-1]` the MSB — the reverse of the order they come off the stream in,
 *  which is MSB first.
 *
 *  The fold is applied here, after every plane is decoded, rather than
 *  interleaved with the decoding the way C.5 writes it. That is exactly
 *  equivalent and not a shortcut: plane J is folded against the ALREADY-FOLDED
 *  plane J+1, and folding J changes nothing plane J's own decode reads, since
 *  each plane is an independent generic region over its own pixels. Separating
 *  them is what makes this a pure function with a hand-computable expectation —
 *  the published Gray sequence 00 01 11 10 naming 0 1 2 3 — which is one of the
 *  few things in this stack anchored outside our own encoder. */
export function grayscaleValues(planes: Bitmap[], width: number, height: number): Int32Array {
  const n = width * height;
  const out = new Int32Array(n);
  if (planes.length === 0) return out;
  const top = planes.length - 1;
  let above = Uint8Array.from(planes[top].data);
  for (let i = 0; i < n; i++) out[i] |= above[i] << top;
  for (let j = top - 1; j >= 0; j--) {
    const cur = Uint8Array.from(planes[j].data);
    for (let i = 0; i < n; i++) { cur[i] ^= above[i]; out[i] |= cur[i] << j; }
    above = cur;
  }
  return out;
}

export interface HalftoneParams extends HalftoneGrid {
  width: number; height: number;
  mmr: boolean; template: number; enableSkip: boolean;
  /** HCOMBOP: how a stamped pattern combines with the region. */
  combOp: number;
  /** HDEFPIXEL: the region's initial fill. */
  defPixel: number;
  /** HGW / HGH: the grid's dimensions in cells. */
  gridWidth: number; gridHeight: number;
  patterns: Bitmap[];
}

/** Decode a halftone region (T.88 §6.6.5). */
export function decodeHalftoneRegion(
  data: Uint8Array, start: number, end: number, prm: HalftoneParams,
): Bitmap {
  if (prm.patterns.length === 0) {
    throw new PdfParseError('JBIG2: halftone region refers to no pattern dictionary', start);
  }
  const region = newBitmap(prm.width, prm.height, prm.defPixel);
  const pat0 = prm.patterns[0];
  const skip = prm.enableSkip
    ? halftoneSkip({ ...prm, patternWidth: pat0.width, patternHeight: pat0.height })
    : undefined;

  // HBPP. An integer loop rather than Math.ceil(Math.log2(n)): the float form is
  // exact for the values that matter, but this decides how many planes are read
  // off the stream and the loop cannot be wrong at all.
  let bpp = 0;
  while ((1 << bpp) < prm.patterns.length) bpp++;

  // The planes come off the stream MSB FIRST and are stored LSB-first, which is
  // the indexing grayscaleValues folds in.
  const planes: Bitmap[] = new Array<Bitmap>(bpp);
  if (prm.mmr) {
    // Annex C.5: NOT one stream per plane. They are decoded consecutively from
    // one MMR datastream with an EOFB between them, which is the whole reason
    // ccitt.ts reports bytes consumed.
    let o = start;
    for (let j = bpp - 1; j >= 0; j--) {
      const r = decodeMmrBitmap(data, o, end, prm.gridWidth, prm.gridHeight);
      planes[j] = r.bitmap;
      o += r.consumed;
    }
  } else {
    // One decoder and one context set shared by every plane (Annex C.5).
    const mq = new MqDecoder(data, start, end);
    const cx = new Int8Array(1 << 16);
    const at = grayscaleAt(prm.template);
    for (let j = bpp - 1; j >= 0; j--) {
      planes[j] = decodeGeneric(data, start, end, {
        width: prm.gridWidth, height: prm.gridHeight, template: prm.template,
        at, tpgdon: false, mmr: false, skip,
      }, mq, cx);
    }
  }

  const values = grayscaleValues(planes, prm.gridWidth, prm.gridHeight);
  const last = prm.patterns.length - 1;
  for (let mg = 0; mg < prm.gridHeight; mg++) {
    for (let ng = 0; ng < prm.gridWidth; ng++) {
      const i = mg * prm.gridWidth + ng;
      if (skip !== undefined && skip.data[i]) continue;
      // A damage guard: T.88 does not say what an out-of-range grayscale value
      // means, and an unclamped index stamps `undefined`.
      const v = values[i] < 0 ? 0 : values[i] > last ? last : values[i];
      const { x, y } = cellOrigin(prm, mg, ng);
      combine(region, prm.patterns[v], x, y, prm.combOp);
    }
  }
  return region;
}
