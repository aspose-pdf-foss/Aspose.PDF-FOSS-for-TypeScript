/**
 * Which INSTALLED face substitutes for a font dict the document did not embed
 * (`lqcs.2`).
 *
 * **Invariant: a pure leaf that takes its faces as an ARGUMENT.** It receives a
 * `FaceRecord[]` and a `cmap` reader, never a `Document` and never a path, so
 * every resolution rule is drivable from hand-built records with no PDF built,
 * no folder registered and no filesystem touched -- the seam `colorimage.ts`
 * takes `resolve`/`inflate` through. It never throws.
 */
import { PdfDict, PdfObject, PdfStream, isStream, isName } from './types.js';
import { parseCMap } from './cmap.js';
import { getCidToUnicode } from './cidunicode.js';
import { cidSystemOrdering, resolveSimpleEncoding, type FontStyle } from './font.js';
import { matchChain } from './fontmatch.js';
import type { FaceRecord } from './fontsource.js';

// The house shape, matching font.ts, colorspace.ts and colorimage.ts: the
// return is PdfObject rather than PdfObject | undefined, because
// `doc.resolve(undefined)` answers `null` and null IS a PdfObject.
type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: PdfStream) => Uint8Array;

/** How many code points a coverage score is taken over. The score is a
 *  FRACTION rather than a census, so past a sample the answer stops improving
 *  and only the cost grows. */
export const WANTED_CAP = 256;
/** How far into a collection the CID probe walks. */
export const CID_PROBE_LIMIT = 20000;
/** PRIME, and that is the whole point: a collection's CIDs are grouped by kind
 *  -- Adobe-Japan1's 1..230 are proportional Latin -- so a step sharing a
 *  factor with that structure samples one region and reports that a Latin-only
 *  face covers a Japanese font. */
export const CID_PROBE_STEP = 61;

/**
 * The code points this font dict can emit, bounded to {@link WANTED_CAP}.
 *
 * Three sources in order, and the second one's mechanism is the trap:
 * `CMap.entries()` enumerates a `/ToUnicode` outright, but `CidToUnicode`
 * exposes `lookup(cid)` and NOTHING else, so a collection's set is PROBED
 * rather than iterated. That leaves `cidunicode.ts` untouched instead of
 * widening a public interface for one consumer.
 *
 * Empty is a real answer: a composite font with an `Identity` ordering and no
 * `/ToUnicode` states no characters at all, so no coverage score is possible
 * and the caller keeps its placeholder boxes.
 */
export function wantedCodepoints(dict: PdfDict, resolve: Resolve, inflate: Inflate): Set<number> {
  const out = new Set<number>();
  const add = (s: string | undefined): void => {
    if (!s) return;
    const cp = s.codePointAt(0);
    if (cp !== undefined) out.add(cp);
  };

  // 1. /ToUnicode -- the font's own statement, and the only enumerable source.
  const tu = resolve(dict.get('ToUnicode'));
  if (isStream(tu)) {
    try {
      for (const [, text] of parseCMap(inflate(tu)).entries()) {
        add(text);
        if (out.size >= WANTED_CAP) return out;
      }
    } catch { /* a damaged /ToUnicode costs its own contribution, not the font */ }
  }
  if (out.size > 0) return out;

  // 2. A composite font's character collection.
  const ordering = cidSystemOrdering(dict, resolve);
  const table = ordering ? getCidToUnicode(ordering) : undefined;
  if (table) {
    for (let cid = 1; cid <= CID_PROBE_LIMIT && out.size < WANTED_CAP; cid += CID_PROBE_STEP) {
      add(table.lookup(cid));
    }
    return out;
  }

  // 3. A simple font: its encoding already answers code -> Unicode.
  const sub = resolve(dict.get('Subtype'));
  if (!(isName(sub) && sub.name === 'Type0')) {
    for (const s of resolveSimpleEncoding(dict, resolve).unicode) {
      add(s);
      if (out.size >= WANTED_CAP) break;
    }
  }
  return out;
}

/**
 * Code-point block -> `OS/2.ulUnicodeRange` bit, from the OpenType `OS/2`
 * specification's Unicode Character Range table.
 *
 * **DELIBERATELY PARTIAL, and that is what makes it safe.** Transcribing all
 * ~170 rows would be a large unverified table for a pre-filter; these are the
 * blocks that actually discriminate for font substitution. A code point no row
 * covers contributes NO bit, and a face is excluded only when every wanted
 * point maps to a known bit and the face sets none of them -- so an omission
 * costs a confirm, never a wrong answer. Rows may be added; none may be
 * guessed.
 */
const RANGE_BITS: readonly { lo: number; hi: number; bit: number }[] = [
  { lo: 0x0000, hi: 0x007f, bit: 0 },    // Basic Latin
  { lo: 0x0080, hi: 0x00ff, bit: 1 },    // Latin-1 Supplement
  { lo: 0x0370, hi: 0x03ff, bit: 7 },    // Greek and Coptic
  { lo: 0x0400, hi: 0x04ff, bit: 9 },    // Cyrillic
  { lo: 0x0590, hi: 0x05ff, bit: 11 },   // Hebrew
  { lo: 0x0600, hi: 0x06ff, bit: 13 },   // Arabic
  { lo: 0x0900, hi: 0x097f, bit: 15 },   // Devanagari
  { lo: 0x0e00, hi: 0x0e7f, bit: 24 },   // Thai
  { lo: 0x1100, hi: 0x11ff, bit: 28 },   // Hangul Jamo
  { lo: 0x3000, hi: 0x303f, bit: 48 },   // CJK Symbols and Punctuation
  { lo: 0x3040, hi: 0x309f, bit: 49 },   // Hiragana
  { lo: 0x30a0, hi: 0x30ff, bit: 50 },   // Katakana
  { lo: 0x3100, hi: 0x312f, bit: 51 },   // Bopomofo
  { lo: 0xac00, hi: 0xd7af, bit: 56 },   // Hangul Syllables
  { lo: 0x4e00, hi: 0x9fff, bit: 59 },   // CJK Unified Ideographs
  { lo: 0xf900, hi: 0xfaff, bit: 61 },   // CJK Compatibility Ideographs
];

const rangeBit = (cp: number): number | undefined =>
  RANGE_BITS.find((r) => cp >= r.lo && cp <= r.hi)?.bit;

/** Whether a face's stated ranges could hold any of `wanted`. Conservative: a
 *  face is refused only on POSITIVE evidence that it cannot. */
function rangeAdmits(range: readonly [number, number, number, number], wanted: readonly number[]): boolean {
  let sawKnown = false;
  for (const cp of wanted) {
    const bit = rangeBit(cp);
    if (bit === undefined) continue;
    sawKnown = true;
    if ((range[bit >> 5] >>> (bit & 31)) & 1) return true;
  }
  return !sawKnown;   // nothing we can judge -> admit, and let the cmap decide
}

/** `OS/2.sFamilyClass` classes 1..7 are the serif families; 8 is sans serif.
 *  Anything else (0 unclassified, 9..14 ornamental/script/symbolic) is not a
 *  serif claim. */
const isSerifClass = (cls: number | undefined): boolean =>
  cls !== undefined && cls >= 1 && cls <= 7;

/** How many admitted faces are confirmed against their real `cmap`. A cost
 *  bound with a stated consequence: a folder offering more than this many
 *  admitted faces confirms the first {@link CONFIRM_CAP} in index order, which
 *  is registration then directory order. */
export const CONFIRM_CAP = 64;
/** Below this fraction of `wanted`, a face is not a substitute for this font --
 *  drawing a tenth of a page's characters is worse than boxes throughout,
 *  because it looks like a font that works. */
export const MIN_COVERAGE = 0.5;

/** What a non-embedded font dict asks of a substitute. */
export interface SubstRequest {
  /** `/BaseFont` with any six-letter subset prefix stripped. `''` when absent. */
  baseFont: string;
  /** From `font.ts`'s `fontStyleOf` -- the ONE owner of "is this bold or
   *  italic", shared with `fragmentsFromGlyphs` and `struct.ts`. */
  style: FontStyle;
  /** {@link wantedCodepoints}'s answer for this dict. */
  wanted: ReadonlySet<number>;
  /** The descriptor's `/Flags` bit 2 (Serif). */
  serif: boolean;
}

/** A chosen face, and WHICH rung chose it. The rung is reported so a test can
 *  pin the ORDER rather than only the outcome, and so a caller can tell a name
 *  hit from a guess. */
export interface SubstMatch {
  face: FaceRecord;
  rung: 'name' | 'coverage';
}

/**
 * The installed face that substitutes for a non-embedded font, or `undefined`
 * when none should -- an ordinary outcome, where the caller falls back to the
 * bundled Standard-14 face exactly as it did before this existed.
 *
 * **Rung 1, NAME.** The document named a family, so a coverage score must not
 * overrule a name that matched -- the rule `matchChain` already applies for
 * authoring, reused rather than re-derived.
 *
 * **Rung 2, COVERAGE.** `ulUnicodeRange` pre-filters (free: `fontnames.ts`
 * already read that slice) and the real `cmap` decides. This is also where
 * `lqcs.3`'s collection step lands: for a composite font with a known
 * ordering, `wanted` IS that collection's table, so a face covering Simplified
 * Chinese is found without anybody writing PingFang SC's name down.
 */
export function resolveSubstitute(
  faces: readonly FaceRecord[],
  req: SubstRequest,
  cmapOf: (face: FaceRecord) => ReadonlySet<number> | undefined,
): SubstMatch | undefined {
  if (faces.length === 0) return undefined;

  if (req.baseFont !== '') {
    // `/BaseFont` is the POSTSCRIPT name (32000-1 9.6.2.1), which is NOT the
    // family name -- MS Mincho's is `MS-Mincho` and Arial Bold's is
    // `Arial-BoldMT`. So the PostScript name (`name` ID 6) is tried FIRST, and
    // an exact hit needs no style matching at all: a PostScript name addresses
    // one face, where a family addresses several.
    //
    // The family match stays behind it, because a producer naming a font it
    // did not embed very often writes the plain family (`/Arial`), and because
    // it is what brings CSS Fonts 4 slant-then-weight matching to bear.
    const want = req.baseFont.trim().toLowerCase();
    const byPs = faces.find((f) => f.names.postScriptName?.trim().toLowerCase() === want);
    if (byPs) return { face: byPs, rung: 'name' };

    const hit = matchChain(faces, [req.baseFont],
      { weight: req.style.bold ? 700 : 400, italic: req.style.italic });
    if (hit) return { face: hit, rung: 'name' };
  }

  if (req.wanted.size === 0) return undefined;
  const wanted = [...req.wanted];

  const admitted = faces
    .filter((f) => !f.names.unicodeRange || rangeAdmits(f.names.unicodeRange, wanted))
    .slice(0, CONFIRM_CAP);

  let best: SubstMatch | undefined;
  let bestScore = 0;
  let bestSerif = false;
  for (const f of admitted) {
    const cov = cmapOf(f);
    if (!cov) continue;
    let hits = 0;
    for (const cp of wanted) if (cov.has(cp)) hits++;
    const score = hits / wanted.length;
    if (score < MIN_COVERAGE) continue;
    const serif = isSerifClass(f.names.familyClass) === req.serif;
    // Strict >, so an equal score and an equal serif verdict leave the EARLIER
    // face in place -- index order, which is registration then directory
    // order, exactly as `matchFace` breaks its own ties.
    if (score > bestScore || (score === bestScore && serif && !bestSerif)) {
      best = { face: f, rung: 'coverage' };
      bestScore = score;
      bestSerif = serif;
    }
  }
  return best;
}
