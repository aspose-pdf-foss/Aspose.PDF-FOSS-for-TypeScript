// Which font each character of a replacement is written in (u3l5.2), and the
// options that choose them. Pure over a TextFont and authoring fonts: it
// allocates nothing and touches no content stream, so every tier rule is
// testable from fonts alone.
import type { SearchOptions } from './textedit.js';
import type { TextFont } from './font.js';
import type { ContentOp } from './content.js';
import { EmbeddedFont } from './embeddedfont.js';
import { AUTHORING_FONTS, driverFor, type AuthoringFont } from './stamp.js';

/** Options for `ReplaceText` on a page or a document. */
export interface ReplaceTextOptions extends SearchOptions {
  /** Fonts to write a character in when the matched glyph's own font cannot
   *  draw it, tried in order: one of the 12 Latin Standard-14 faces by name, or
   *  a handle from `AddFont`/`LoadFontByName`. */
  fallbackFonts?: AuthoringFont[];
  /** Before `fallbackFonts`, look for the SAME face among folders registered
   *  with `RegisterFontFolder`/`RegisterSystemFonts`: a font whose PostScript
   *  name equals the matched font's `/BaseFont` without its subset tag.
   *  Default false, since the answer depends on the machine. */
  matchRegisteredFonts?: boolean;
  /** Called once per match that lost characters no font could draw. Without
   *  it such a call throws `UnsupportedFeatureError` and changes nothing. */
  onUndrawable?: (r: UndrawableText) => void;
  /** Write the replacement in this font rather than the matched text's own
   *  (u3l5.3), then `fallbackFonts` for what it cannot draw. Text around a
   *  match keeps its font. */
  font?: AuthoringFont;
  /** The replacement's size in points as rendered — the matched text's own
   *  scaling applies, so `fontSize: 12` draws 12pt whatever its `Tf` said.
   *  Default: the matched text's size. */
  fontSize?: number;
  /** The replacement's fill colour as [r, g, b] in 0..1. The colour in force
   *  before is restored after it, in its own colour space. Stroked text (`Tr`
   *  1, 2, 5, 6) keeps its stroke colour. Default: the matched text's. */
  color?: [number, number, number];
  /** What happens to the rest of the line when the replacement is wider or
   *  narrower than what it replaced (u3l5.4). `'none'` (the default) changes
   *  only the matched text: text after it in the same show operator moves, and
   *  text positioned on its own does not, so a wider replacement may overlap
   *  it. `'shiftRest'` moves everything after the replacement on its line by
   *  the difference. `'spaceWidth'` takes the difference out of the word gaps
   *  after the replacement on its line, so the line keeps its end. A gap gives up
   *  at most half its width, so words never touch; what the gaps cannot absorb
   *  — all of it, with no gap after the replacement — shifts the rest of the
   *  line as under `'shiftRest'`. */
  adjust?: ReplaceAdjust;
}

/** See `ReplaceTextOptions.adjust`. */
export type ReplaceAdjust = 'none' | 'shiftRest' | 'spaceWidth';
const ADJUSTS: readonly ReplaceAdjust[] = ['none', 'shiftRest', 'spaceWidth'];

/** A match some of whose characters no available font could draw. */
export interface UndrawableText {
  /** 1-based page number. */
  page: number;
  /** The matched text. */
  match: string;
  /** The characters left out, distinct, in order of first appearance. */
  missing: string[];
}

/** Validate `opts` before any page is read; `TypeError` for the wrong kind of
 *  thing, so a typo such as `fallbackFonts: 'Helvetica'` cannot silently mean
 *  "no fallback". */
export function checkReplaceOptions(opts: ReplaceTextOptions | undefined): ReplaceTextOptions {
  const o = opts ?? {};
  if (typeof o !== 'object' || o === null) throw new TypeError('ReplaceText options must be an object');
  const isFont = (f: unknown): boolean => f instanceof EmbeddedFont
    || (typeof f === 'string' && (AUTHORING_FONTS as readonly string[]).includes(f));
  if (o.fallbackFonts !== undefined) {
    if (!Array.isArray(o.fallbackFonts)) throw new TypeError('ReplaceText: fallbackFonts must be an array of fonts');
    for (const f of o.fallbackFonts) {
      if (!isFont(f)) throw new TypeError(`ReplaceText: fallbackFonts entry ${String(f)} is neither a Standard-14 authoring face nor a font from AddFont`);
    }
  }
  if (o.font !== undefined && !isFont(o.font))
    throw new TypeError(`ReplaceText: font ${String(o.font)} is neither a Standard-14 authoring face nor a font from AddFont`);
  if (o.fontSize !== undefined) {
    if (typeof o.fontSize !== 'number') throw new TypeError('ReplaceText: fontSize must be a number');
    if (!Number.isFinite(o.fontSize) || o.fontSize <= 0) throw new RangeError(`ReplaceText: fontSize must be positive, got ${o.fontSize}`);
  }
  if (o.color !== undefined) {
    if (!Array.isArray(o.color) || o.color.length !== 3 || o.color.some((c) => typeof c !== 'number'))
      throw new TypeError('ReplaceText: color must be [r, g, b]');
    if (o.color.some((c) => !(c >= 0 && c <= 1))) throw new RangeError('ReplaceText: color components must be in 0..1');
  }
  if (o.adjust !== undefined) {
    if (typeof o.adjust !== 'string') throw new TypeError('ReplaceText: adjust must be a string');
    if (!(ADJUSTS as readonly string[]).includes(o.adjust))
      throw new RangeError(`ReplaceText: adjust must be one of ${ADJUSTS.join(', ')}, got ${o.adjust}`);
  }
  for (const k of ['matchRegisteredFonts', 'ignoreCase', 'wholeWord'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new TypeError(`ReplaceText: ${k} must be a boolean`);
  }
  if (o.onUndrawable !== undefined && typeof o.onUndrawable !== 'function')
    throw new TypeError('ReplaceText: onUndrawable must be a function');
  return o;
}

/** One run of written text in one font: bytes already encoded in the ORIGINAL
 *  font, or text to encode at apply time in a foreign authoring font. Encoding
 *  a foreign run is deferred because `EmbeddedFont.encode` records glyph usage
 *  for subsetting, and a plan that is refused must record nothing. */
export type Run =
  | { font: 'original'; bytes: Uint8Array; style?: RunStyle }
  | { font: AuthoringFont; text: string; style?: RunStyle };

/** How a replacement is styled (u3l5.3): its `Tf` size, and the fill to set
 *  before it and the operators that put the old fill back after. One object
 *  per inserted replacement, so runs merge only within it. */
export interface RunStyle {
  size?: number;
  fill?: { set: ContentOp; restore: readonly ContentOp[] };
}

/** The fonts a character may be written in, in tier order. `original` is
 *  absent when the caller named the replacement's font. */
export interface FontTiers {
  original?: TextFont;
  registered?: EmbeddedFont;
  fallbacks: readonly AuthoringFont[];
}

/** Assign each code point of `text` to the first tier that can draw it,
 *  appending to `out`. A code point no tier draws is omitted and pushed onto
 *  `missing`.
 *
 *  **Invariant (u3l5.2):** the decision is PER CHARACTER, so the original face
 *  is kept wherever it can draw and only what it cannot changes face. */
export function assignRuns(text: string, tiers: FontTiers, out: Run[], missing: string[], style?: RunStyle): void {
  for (const ch of text) {
    const bytes = tiers.original?.drawCode(ch);
    if (bytes) { pushRun(out, { font: 'original', bytes, style }); continue; }
    const foreign = [tiers.registered, ...tiers.fallbacks]
      .find((f): f is AuthoringFont => f !== undefined && driverFor(f).probe(ch) > 0);
    if (foreign !== undefined) pushRun(out, { font: foreign, text: ch, style });
    else missing.push(ch);
  }
}

/** Append `r`, merging it into the last run when both are in one font and
 *  one style. */
export function pushRun(out: Run[], r: Run): void {
  const last = out[out.length - 1];
  if (last && last.style === r.style) {
    if (last.font === 'original' && r.font === 'original') {
      const joined = new Uint8Array(last.bytes.length + r.bytes.length);
      joined.set(last.bytes); joined.set(r.bytes, last.bytes.length);
      out[out.length - 1] = { font: 'original', bytes: joined, style: r.style };
      return;
    }
    if (last.font !== 'original' && r.font !== 'original' && last.font === r.font) {
      out[out.length - 1] = { font: r.font, text: last.text + r.text, style: r.style };
      return;
    }
  }
  out.push(r);
}
