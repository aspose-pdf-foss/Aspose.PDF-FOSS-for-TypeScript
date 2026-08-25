import { PdfDict, PdfObject, isDict, isStream } from './types.js';
import { SfntFont, parseSfnt } from './sfnt.js';
import { CffFont } from './cff.js';
import { Type1Font } from './type1.js';

type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

/**
 * Whichever font program a `/FontDescriptor` embeds.
 *
 * This module is the single owner of three questions both the renderer and the
 * extraction path ask: what program does this descriptor carry, which glyph
 * does a code select in it, and how wide is that glyph. `raster.ts` asked all
 * three already; `font.ts` needs the third and cannot import `raster.ts`, so a
 * second copy was the alternative — the same one-owner reasoning that put
 * code → glyph *name* in one place.
 *
 * Takes `resolve`/`inflate` rather than a `Document`, and takes the name
 * resolver as an argument rather than importing `font.ts`. That is what keeps
 * `font.ts -> glyphprogram.ts` free of a dependency cycle.
 */
export interface EmbeddedProgram {
  sfnt?: SfntFont;
  cff?: CffFont;
  type1?: Type1Font;
}

/** True when `raw` begins with an sfnt version tag (OTTO / TrueType / collection). */
function isSfnt(raw: Uint8Array): boolean {
  if (raw.length < 4) return false;
  const tag = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  return tag === 0x4f54544f || tag === 0x00010000 || tag === 0x74727565 || tag === 0x74746366;
}

/**
 * Load `/FontFile2` (TrueType), `/FontFile3` (CFF / OpenType-CFF) or
 * `/FontFile` (Type 1), in that precedence.
 *
 * A malformed program is a broken font, not a broken document: every parse is
 * guarded, and an unreadable one simply leaves its slot empty.
 */
export function loadEmbeddedProgram(
  fdObj: PdfObject | undefined, resolve: Resolve, inflate: Inflate,
): EmbeddedProgram {
  const fd = resolve(fdObj);
  if (!isDict(fd)) return {};
  const inf = (s: PdfObject): Uint8Array => inflate(s as { dict: PdfDict; raw: Uint8Array });

  let sfnt: SfntFont | undefined;
  let cff: CffFont | undefined;
  let type1: Type1Font | undefined;

  const ff2 = resolve(fd.get('FontFile2'));
  if (isStream(ff2)) { try { sfnt = parseSfnt(inf(ff2)); } catch { sfnt = undefined; } }
  if (sfnt?.outlines === 'cff') {
    const t = sfnt.table('CFF ', false);
    if (t) { try { cff = new CffFont(t); } catch { /* keep sfnt for its cmap */ } }
  }

  if (!cff) {
    const ff3 = resolve(fd.get('FontFile3'));
    if (isStream(ff3)) {
      try {
        const raw = inf(ff3);
        if (isSfnt(raw)) {
          const s = parseSfnt(raw);
          sfnt = sfnt ?? s;
          const t = s.table('CFF ', false);
          if (t) cff = new CffFont(t);
        } else cff = new CffFont(raw);
      } catch { /* undecodable */ }
    }
  }

  if (!cff && !sfnt) {
    const ff1 = resolve(fd.get('FontFile'));
    if (isStream(ff1)) { try { type1 = new Type1Font(inf(ff1)); } catch { type1 = undefined; } }
  }

  const out: EmbeddedProgram = {};
  if (sfnt) out.sfnt = sfnt;
  if (cff) out.cff = cff;
  if (type1) out.type1 = type1;
  return out;
}

/**
 * Resolve a *simple* font's character code to a glyph id in `prog`.
 *
 * `nameForCode` is the name-keyed route and is supplied by the caller — a Type 1
 * program has no other route, and a CFF with no usable `cmap` has none either.
 * `text` is the Unicode the code decodes to, which a TrueType `cmap` prefers
 * over the raw code.
 */
export function gidForProgram(
  prog: EmbeddedProgram, code: number, text: string,
  nameForCode: ((code: number) => string | undefined) | undefined,
): number | undefined {
  if (nameForCode) {
    const n = nameForCode(code);
    // A Type 1 program has no cmap and no substitute: a name it does not define
    // simply has no glyph.
    if (prog.type1) return n === undefined ? undefined : prog.type1.gidForName(n);
    const names = prog.cff?.charsetNames() ?? [];
    if (n !== undefined) {
      const gid = names.indexOf(n);
      if (gid > 0) return gid;
    }
    const bg = prog.cff?.builtinEncoding()?.get(code);
    if (bg !== undefined) return bg;
    // A charset we could read that does not name this glyph: no answer. Only a
    // charset we could not read at all falls through to the guess below.
    if (names.length) return undefined;
  }

  const sf = prog.sfnt;
  if (sf?.cmap.size) {                             // simple font: via cmap (glyf or OTTO-CFF)
    if (text) { const g = sf.cmapLookup(text.codePointAt(0)!); if (g) return g; }
    const gc = sf.cmapLookup(code); if (gc) return gc;
    const gs = sf.cmapLookup(0xf000 + code); if (gs) return gs;   // symbol cmap
    return undefined;
  }
  return code;                                     // no cmap (bare subset): assume gid = code
}

/**
 * The program's own advance for `gid`, **normalised to 1/1000 em**.
 *
 * The three programs report in three different spaces — `hsbw` in glyph space,
 * a CFF charstring width in charstring units, `hmtx` in font units — and only
 * the first two are reliably 1000/em. A TrueType is commonly 2048/em, so
 * skipping the division reports an advance 2.048x too wide while the other two
 * kinds keep looking correct.
 *
 * `hmtx` wins over the CFF charstring width when both exist, which is the
 * OpenType-CFF case: `hmtx` is the authority there.
 */
/**
 * The glyph a COMPOSITE font's CID selects in `prog`.
 *
 * Lives here rather than in `raster.ts` for the reason this module exists: two
 * callers ask it — `raster.ts` to draw a glyph and `font.ts` to measure one —
 * and `raster.ts` imports `font.ts`, so keeping it there would force a second
 * copy. Two copies is how the drawn glyph and the measured glyph come to
 * disagree about one document, silently, since every candidate is a valid gid.
 *
 * `cidToGid` is the inflated `/CIDToGIDMap` stream (2 bytes per CID, big
 * endian); `undefined` means `/Identity` or absent.
 */
export function gidForCid(
  prog: EmbeddedProgram, cid: number, cidToGid: Uint8Array | undefined,
): number {
  if (cidToGid) {
    const i = cid * 2;
    return i + 1 < cidToGid.length ? (cidToGid[i] << 8) | cidToGid[i + 1] : 0;
  }
  // A CID-keyed CFF carries the mapping in its charset; anything else is
  // Identity, which is what /CIDFontType2 without a map means.
  if (prog.cff?.isCID) return prog.cff.cidToGid(cid);
  return cid;
}

export function programAdvance(prog: EmbeddedProgram, gid: number): number | undefined {
  const em = (raw: number, upm: number): number => (raw * 1000) / (upm || 1000);
  if (prog.sfnt) return em(prog.sfnt.advanceWidth(gid), prog.sfnt.unitsPerEm);
  if (prog.cff) {
    const w = prog.cff.glyphWidth(gid);
    return w === undefined ? undefined : em(w, prog.cff.unitsPerEm);
  }
  if (prog.type1) return em(prog.type1.glyphWidth(gid), prog.type1.unitsPerEm);
  return undefined;
}
