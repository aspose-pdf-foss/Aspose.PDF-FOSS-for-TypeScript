/**
 * Type 1 to CFF, the conversion behind embedding a `.pfb`.
 *
 * Pure: bytes in, bytes out, no PDF objects and no filesystem. It needs no
 * charstring transcoder, which is the whole reason this is small —
 * `type1charstring.ts` already interprets a Type 1 charstring into a `Path` of
 * M/L/C/Z cubics in glyph units, and that is exactly the Type 2 vocabulary
 * (`rmoveto`, `rlineto`, `rrcurveto`, close implicit). So the outlines are
 * re-emitted as deltas rather than translated operator by operator.
 *
 * HINTS ARE LOST, by decision. Outlines carry none, and preserving them would
 * mean a second charstring grammar whose divergences type1.ts already records
 * (unbiased subrs, closepath, 255 meaning a 32-bit integer rather than 16.16).
 * The cost is a little stem regularity at small sizes in third-party viewers,
 * and it is invisible to this suite: raster.ts is a scanline filler over
 * flattened outlines and ignores hints entirely.
 */
import type { Path } from './pagerender.js';
import { Type1Font } from './type1.js';
import { readType1Header, type Type1Header } from './type1header.js';
import { assembleCidCff } from './cffsubset.js';
import { glyphToUnicode } from './encoding.js';
import { buildCmap, otfFromCff } from './sfntwrite.js';

/** What a converted program yields, before it is wrapped as an sfnt. */
export interface Type1Conversion {
  /** A CID-keyed CFF with an identity charset. */
  cff: Uint8Array;
  /** `order[newGid] = oldGid` — the renumbering that puts .notdef first. */
  order: number[];
  /** Advance per NEW gid, in glyph units. */
  advances: number[];
  /** Code point -> new gid. */
  unicode: Map<number, number>;
  bbox: [number, number, number, number];
  header: Type1Header;
}

// ---------- Type 2 charstring emission ----------

/** A Type 2 integer operand. Values outside the short forms take the 28
 *  escape and a 16-bit signed big-endian; 255 (16.16 fixed) is never needed,
 *  because every coordinate is rounded to an integer first. */
function operand(v: number, out: number[]): void {
  if (v >= -107 && v <= 107) { out.push(v + 139); return; }
  if (v >= 108 && v <= 1131) {
    const d = v - 108;
    out.push(247 + (d >> 8), d & 0xff);
    return;
  }
  if (v >= -1131 && v <= -108) {
    const d = -v - 108;
    out.push(251 + (d >> 8), d & 0xff);
    return;
  }
  const c = Math.max(-32768, Math.min(32767, v));
  out.push(28, (c >> 8) & 0xff, c & 0xff);
}

const RMOVETO = 21, RLINETO = 5, RRCURVETO = 8, ENDCHAR = 14;

/**
 * One Type 2 charstring for `path`, advancing by `width`.
 *
 * The width rides as an extra leading operand on the first stack-clearing
 * operator, which is Type 2's own convention. It is emitted ALWAYS: with
 * `Private [0 0]` both `nominalWidthX` and `defaultWidthX` are 0, so a width
 * operand is the width itself and an omitted one means an advance of zero.
 *
 * Coordinates are rounded ABSOLUTELY and then differenced, so rounding error
 * cannot accumulate along a contour.
 */
export function encodeType2(path: Path, width: number): Uint8Array {
  const out: number[] = [];
  let x = 0, y = 0, first = true;

  const move = (nx: number, ny: number): void => {
    const dx = nx - x, dy = ny - y;
    if (first) operand(Math.round(width), out);
    operand(dx, out); operand(dy, out); out.push(RMOVETO);
    x = nx; y = ny; first = false;
  };

  for (const s of path) {
    if (s.op === 'M') { move(Math.round(s.x), Math.round(s.y)); continue; }
    if (s.op === 'L') {
      const nx = Math.round(s.x), ny = Math.round(s.y);
      operand(nx - x, out); operand(ny - y, out); out.push(RLINETO);
      x = nx; y = ny;
      continue;
    }
    if (s.op === 'C') {
      const x1 = Math.round(s.x1), y1 = Math.round(s.y1);
      const x2 = Math.round(s.x2), y2 = Math.round(s.y2);
      const nx = Math.round(s.x), ny = Math.round(s.y);
      operand(x1 - x, out); operand(y1 - y, out);
      operand(x2 - x1, out); operand(y2 - y1, out);
      operand(nx - x2, out); operand(ny - y2, out);
      out.push(RRCURVETO);
      x = nx; y = ny;
      continue;
    }
    // 'Z': Type 2 closes each subpath implicitly; there is nothing to emit.
  }

  if (first) operand(Math.round(width), out);   // a glyph that draws nothing
  out.push(ENDCHAR);
  return Uint8Array.from(out);
}

// ---------- Conversion ----------

/**
 * Convert a Type 1 program to a CID-keyed CFF.
 *
 * GLYPH IDS ARE RENUMBERED so that `.notdef` is gid 0, which CFF requires.
 * `Type1Font` numbers by order of appearance in `/CharStrings` and carries none
 * of the CFF conventions — the bundled `NimbusSans-Regular.t1` lists `/.notdef`
 * LAST, so taking the font's own order puts the wrong glyph at 0 and shifts
 * every other by one.
 */
export function type1ToCff(bytes: Uint8Array): Type1Conversion {
  const t1 = new Type1Font(bytes);
  const header = readType1Header(bytes);

  // .notdef first, then every other glyph in the font's own order.
  const notdef = t1.gidForName('.notdef');
  const order: number[] = [];
  if (notdef !== undefined) order.push(notdef);
  for (let g = 0; g < t1.numGlyphs; g++) if (g !== notdef) order.push(g);

  const charStrings: Uint8Array[] = [];
  const advances: number[] = [];
  const unicode = new Map<number, number>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let newGid = 0; newGid < order.length; newGid++) {
    const oldGid = order[newGid];
    const path = t1.glyphPath(oldGid);
    const width = Math.round(t1.glyphWidth(oldGid));
    charStrings.push(encodeType2(path, width));
    advances.push(width);

    for (const s of path) {
      const pts = s.op === 'C'
        ? [[s.x1, s.y1], [s.x2, s.y2], [s.x, s.y]]
        : s.op === 'Z' ? [] : [[s.x, s.y]];
      for (const [px, py] of pts) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    }

    // Code point comes from the glyph NAME, through encoding.ts's resolver --
    // not from the program's built-in /Encoding, which addresses at most 256
    // codes and says nothing about the rest of /CharStrings.
    const name = t1.glyphName(oldGid);
    const u = name === undefined ? undefined : glyphToUnicode(name);
    if (u !== undefined) {
      const cps = [...u];
      if (cps.length === 1) {
        const cp = cps[0].codePointAt(0)!;
        if (!unicode.has(cp)) unicode.set(cp, newGid);   // first name wins
      }
    }
  }

  const bbox: [number, number, number, number] = header.bbox
    ?? (Number.isFinite(minX)
      ? [Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY)]
      : [0, 0, header.unitsPerEm, header.unitsPerEm]);

  const psName = header.fontName ?? 'Type1Font';
  const cff = assembleCidCff(
    [new TextEncoder().encode(psName)],
    charStrings,
    order.map((_, newGid) => newGid),     // identity charset: CID = gid
  );

  return { cff, order, advances, unicode, bbox, header };
}

/**
 * The INVERSE of `Type1Conversion.order`: old gid -> new gid.
 *
 * Exists because a caller that collected glyph ids from the Type 1 program
 * itself — `htmlfontembed.ts` builds a cmap keyed by whatever `gidForCode`
 * returned — holds ids in the program's own numbering, while the converted CFF
 * has renumbered them so `.notdef` is gid 0. Both are valid glyph ids, so a
 * missing remap does not throw: it silently draws each glyph's neighbour.
 */
export function newGidByOldGid(order: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let newGid = 0; newGid < order.length; newGid++) out.set(order[newGid], newGid);
  return out;
}

/**
 * A Type 1 program as a standalone `OTTO` sfnt.
 *
 * This is the whole integration point: `parseSfnt` calls it on Type 1 magic and
 * every consumer downstream — subsetting, `/FontFile3`, Identity-H emission,
 * `/ToUnicode`, `fontmatch.ts` — sees an ordinary OpenType-CFF font and needs
 * no change. Same shape as `woff.ts` reconstructing a WOFF and `ttc.ts`
 * extracting a collection face: convert before anything else sees it.
 *
 * Ascent and descent come from the bounding box. A Type 1 program has no
 * `OS/2` table and states no typographic ascender, so the box is the only
 * source available; it is an approximation and deliberately so.
 */
export function sfntFromType1(bytes: Uint8Array): Uint8Array {
  const c = type1ToCff(bytes);
  return otfFromCff(c.cff, buildCmap(c.unicode), {
    numGlyphs: c.order.length,
    unitsPerEm: c.header.unitsPerEm,
    advances: c.advances,
    bbox: c.bbox,
    ascent: c.bbox[3],
    descent: c.bbox[1],
    psName: c.header.fontName ?? 'Type1Font',
  });
}
