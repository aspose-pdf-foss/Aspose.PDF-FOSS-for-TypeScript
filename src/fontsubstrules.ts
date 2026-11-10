// Font substitution RULES (g0ky.6): the vocabulary a caller states which face
// stands in for a font the document did not embed, and the name matching that
// decides whether a rule applies. Rendering only -- `raster.ts`'s
// `installedSubstitute` asks the handler, then these rules, then
// `fontsubst.ts`'s ladder.
//
// **Invariant:** a pure LEAF. It owns "what is this font's family" for BOTH
// rules and `EmbedFonts` (`embedfonts.ts` imports `fontFamilyKeys`), so a
// rule for `Arial` and `EmbedFonts` agree about which fonts are Arial.
//
// **Invariant:** a rule's `original` matches the whole `/BaseFont` or its
// family part -- up to the first `,` (`Arial,Bold`) or the first `,` or `-`
// (`Arial-BoldMT`) -- with case, spaces and hyphens ignored. It cannot catch
// `ArialNarrow` from `Arial`: there is no separator to cut at.

import { matchStd14, type StdFont } from './metrics.js';

/** One rule of {@link Document.AddFontSubstitution}: render a font named
 *  `original` with the face named `substitute`. */
export interface FontSubstitutionRule {
  readonly original: string;
  readonly substitute: string;
}

/** What a {@link FontSubstitutionHandler} is asked about a non-embedded font. */
export interface FontSubstitutionRequest {
  /** `/BaseFont`, subset tag removed; `''` when absent. */
  name: string;
  bold: boolean;
  italic: boolean;
  /** A SAMPLE of the characters the font needs, at most 256 code points. */
  characters: ReadonlySet<number>;
}

/** Decides the face for one non-embedded font: a face name (resolved as a
 *  rule's substitute is), font bytes, or `undefined` for "not mine". */
export type FontSubstitutionHandler = (req: FontSubstitutionRequest) => string | Uint8Array | undefined;

/** A font name compared loosely: case, spaces and hyphens ignored. */
export const squashFontName = (s: string): string => s.replace(/[\s-]/g, '').toLowerCase();

/** The squashed family keys of a `/BaseFont`: up to the first `,`, and up to
 *  the first `,` or `-`. */
export function fontFamilyKeys(baseFont: string): string[] {
  return [...new Set([baseFont.split(',')[0], baseFont.split(/[,-]/)[0]].map(squashFontName))].filter((s) => s !== '');
}

/** Whether a rule naming `original` applies to a (subset-stripped) `baseFont`. */
export function ruleMatches(original: string, baseFont: string): boolean {
  const want = squashFontName(original);
  if (want === '') return false;
  return want === squashFontName(baseFont) || fontFamilyKeys(baseFont).includes(want);
}

const FAMILY_WORDS: Record<string, readonly [StdFont, StdFont, StdFont, StdFont]> = {
  // regular, bold, italic, bold italic
  helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

/** The bundled Standard-14 face a substitute name denotes: an exact
 *  Standard-14 name, or `Helvetica`/`Times`/`Courier` (any case) taken in the
 *  font's style. Undefined otherwise. */
export function std14Substitute(name: string, style: { bold: boolean; italic: boolean }): StdFont | undefined {
  const fam = Object.hasOwn(FAMILY_WORDS, name.trim().toLowerCase()) ? FAMILY_WORDS[name.trim().toLowerCase()] : undefined;
  if (fam) return fam[(style.bold ? 1 : 0) + (style.italic ? 2 : 0)];
  const exact = matchStd14(name.trim());
  return exact === name.trim() ? exact : undefined;
}
