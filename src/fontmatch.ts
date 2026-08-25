/**
 * Choosing a face: deriving what style a face IS, and which face best answers a
 * request for a family, a weight and a slant.
 *
 * A pure leaf. It takes `FaceRecord[]` and returns one of them — no `node:fs`,
 * no `Document`, and no font file — which is what lets every branch of the
 * weight walk be asserted from hand-built records. `fontsource.ts` imports
 * nothing from here; the two type imports below are erased.
 *
 * The matching rule is CSS Fonts 4 §5.2, cited rather than invented: slant
 * first, then the desired-weight walk. See the design under
 * `docs/superpowers/specs/2026-08-24-font-family-style-matching-design.md`.
 */
import type { FontNames } from './fontnames.js';
import type { FaceRecord } from './fontsource.js';
import type { AddFontOptions } from './document.js';
import type { EmbeddedFont } from './embeddedfont.js';

/** A face's style as DERIVED, which is not always what it states. */
export interface FaceStyle {
  /** CSS weight, 1..1000. */
  weight: number;
  /** Italic or oblique — one bit, since `head.macStyle` has no oblique. */
  italic: boolean;
}

/**
 * The weight a subfamily word names.
 *
 * ORDER IS THE RULE: 'ExtraLight' contains 'Light' and 'SemiBold' contains
 * 'Bold', so the compound spellings must be tested first or a first-match scan
 * reports 300 and 700 — plausible weights, and both wrong.
 */
const SUBFAMILY_WEIGHTS: readonly (readonly [RegExp, number])[] = [
  [/extra\s*light|ultra\s*light/i, 200],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/thin/i, 100],
  [/light/i, 300],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/book|regular|normal/i, 400],
];

/** The weight `s` names, or undefined when it names none. */
export function weightFromSubfamily(s: string): number | undefined {
  for (const [re, w] of SUBFAMILY_WEIGHTS) if (re.test(s)) return w;
  return undefined;
}

/**
 * A face's derived weight and slant.
 *
 * Every signal is POSITIVE evidence and they are OR-ed — the rule `fontStyleOf`
 * in font.ts already sets for the same question asked of a document's own
 * fonts. A face that merely omits `OS/2` says nothing and must not veto a
 * subfamily that says Bold.
 *
 * The weight corroboration fires ONLY at 400, deliberately. 400 is what an
 * absent `OS/2`, a stated 0 and a genuine Regular all produce, so it is the one
 * value that may mean "said nothing" — and a mis-stated Bold left there costs
 * twice, being unreachable at 700 AND a rival for the face returned at 400. At
 * any other value the font made a numeric statement and the name is a second
 * opinion nobody asked for.
 */
export function deriveStyle(names: FontNames): FaceStyle {
  const sub = names.typographicSubfamily ?? names.subfamily;
  const stated = names.weight;
  const weight = stated !== 400
    ? stated
    : names.bold ? 700 : (weightFromSubfamily(sub) ?? 400);
  return { weight, italic: names.italic || /italic|oblique/i.test(sub) };
}

/** What a caller asked for, normalised. */
export interface StyleRequest {
  weight: number;
  italic: boolean;
}

/** A requested weight, defaulted and clamped. It is a number in an options bag,
 *  not a document we are parsing, so it is clamped rather than rejected. */
export function clampWeight(w: number | undefined): number {
  if (w === undefined || !Number.isFinite(w)) return 400;
  return Math.min(1000, Math.max(1, Math.round(w)));
}

/** Whether `names` belongs to the family `want`, which must ALREADY be trimmed
 *  and lower-cased. Matched against the typographic family (ID 16) where the
 *  font states one and ID 1 otherwise -- unchanged from l1my.1. */
export function familyMatches(names: FontNames, want: string): boolean {
  const typo = (names.typographicFamily ?? names.family).trim().toLowerCase();
  return typo === want || names.family.trim().toLowerCase() === want;
}

/**
 * A lexicographic sort key for `have` against the desired weight `want`, under
 * CSS Fonts 4 5.2's weight walk. Lower is better; compare tier, then distance.
 *
 *   400 <= want <= 500 : >=want and <=500 asc, then <want desc, then >500 asc
 *   want < 400         : <=want desc, then >want asc
 *   want > 500         : >=want asc, then <want desc
 *
 * Module-private: the ordering is observable through `matchFace`, and a second
 * entry point into it would be a second thing to keep agreeing with 5.2.
 */
function weightKey(have: number, want: number): [number, number] {
  if (want >= 400 && want <= 500) {
    if (have >= want && have <= 500) return [0, have - want];
    if (have < want) return [1, want - have];
    return [2, have - 500];
  }
  if (want < 400) return have <= want ? [0, want - have] : [1, have - want];
  return have >= want ? [0, have - want] : [1, want - have];
}

/**
 * The face of family `want` that best answers `req`, or undefined when no face
 * belongs to that family at all.
 *
 * SLANT OUTRANKS WEIGHT (5.2 applies style before weight), which is the
 * surprising half: asking { weight: 700, italic: true } of a family holding
 * [Regular, Bold, Italic] yields Italic, not Bold. The upright bold face is a
 * worse answer than the italic regular one, because slant is the stronger
 * signal.
 *
 * Once the family exists this ALWAYS returns a face: the slant pass keeps every
 * face when none matches, and the weight walk ranks all of them. Ties fall to
 * index order, which is registration order and then directory order, so a
 * lookup stays reproducible.
 */
export function matchFace(
  faces: readonly FaceRecord[], want: string, req: StyleRequest,
): FaceRecord | undefined {
  const family = faces.filter((f) => familyMatches(f.names, want));
  if (family.length === 0) return undefined;

  const slanted = family.filter((f) => deriveStyle(f.names).italic === req.italic);
  const pool = slanted.length > 0 ? slanted : family;

  let best = pool[0];
  let bestKey = weightKey(deriveStyle(best.names).weight, req.weight);
  for (let i = 1; i < pool.length; i++) {
    const k = weightKey(deriveStyle(pool[i].names).weight, req.weight);
    // Strict <, so an equal rank leaves the earlier face in place.
    if (k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
      best = pool[i];
      bestKey = k;
    }
  }
  return best;
}

/**
 * The first family in `chain` that any face belongs to, resolved to one face.
 *
 * The chain selects a FAMILY; style matching then runs inside the winner. A
 * caller stated a preference order over families and a style detail must not
 * silently override it -- so ['Arial', 'Liberation Sans'] at weight 700, with
 * Arial present in Regular only, gives Arial Regular and never consults
 * Liberation Sans. That is CSS's own behaviour and it keeps the two mechanisms
 * independent: one picks the family, the other picks the face.
 */
export function matchChain(
  faces: readonly FaceRecord[], chain: readonly string[], req: StyleRequest,
): FaceRecord | undefined {
  for (const name of chain) {
    const want = name.trim().toLowerCase();
    if (want === '') continue;
    const hit = matchFace(faces, want, req);
    if (hit) return hit;
  }
  return undefined;
}

/** A style request alongside the ordinary font options. */
export interface LoadFontOptions extends AddFontOptions {
  /** CSS weight, 1..1000. Default 400. Clamped, never rejected. */
  weight?: number;
  /** Prefer an italic or oblique face. Default false. */
  italic?: boolean;
}

/** What a name resolves to -- reported without loading or embedding anything. */
export interface FontMatch {
  /** The family as the FONT states it (ID 16 where present), not as asked for. */
  family: string;
  /** The subfamily as the font states it (ID 17 where present). */
  subfamily: string;
  /** DERIVED weight and slant, not the raw usWeightClass or macStyle bits. */
  weight: number;
  italic: boolean;
  /** Whether weight AND slant both matched the request exactly. False means a
   *  face was substituted -- the only way a caller can learn that, since
   *  `EmbeddedFont.sfnt` is internal. */
  exact: boolean;
  path: string;
  faceIndex: number;
}

/**
 * The four faces emphasis selects between, loaded from disk.
 *
 * Structurally assignable to `MarkdownFontFamily` (mdstyle.ts), so it drops
 * straight into `AddMarkdown({ style: { font } })` -- declared here rather than
 * imported from there, because a general font API must not depend on the
 * Markdown vocabulary. An absent slot is deliberate: see
 * `Document.LoadFontFamily`.
 */
export interface FontFamily {
  regular: EmbeddedFont;
  bold?: EmbeddedFont;
  italic?: EmbeddedFont;
  boldItalic?: EmbeddedFont;
}
