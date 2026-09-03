/** The HTML5 character-reference sub-machine (HTML Standard §13.2.5.72–§13.2.5.80).
 *
 *  Its own module rather than states on the tokenizer: it is self-contained, it
 *  holds the only real arithmetic in the tokenizer, and returning offsets lets
 *  the caller convert them to line/col with the cursor it already has.
 *
 *  Invariant: pure, and it never throws. Bytes of text in, a replacement and a
 *  length out. */

import { namedEntity, allowsMissingSemicolon, MAX_ENTITY_NAME } from './mdentity.js';

export interface CharRefError {
  code: string;
  /** A code-point count from the '&', so the caller can turn it into a column
   *  by adding it to the '&' position. Points at the code point the error is
   *  reported on — normally the one that ENDED the match. */
  offset: number;
}

export interface CharRefResult {
  /** The text to append — to the attribute value, or to emit as characters. */
  text: string;
  /** Index just past what was consumed. Never less than `i + 1`. */
  end: number;
  errors: CharRefError[];
}

/** §13.2.5.80's numeric character reference end state table. The five values in
 *  0x80..0x9F absent from it (0x81, 0x8D, 0x8F, 0x90, 0x9D) pass through
 *  unchanged, which is the spec's behaviour and not an omission.
 *
 *  Skipping this table leaves those references as C1 controls, which draw
 *  nothing — so the page reads as a missing glyph rather than a decode fault. */
export const C1_REPLACEMENTS: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

const REPLACEMENT = '�';

function isAsciiDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isAsciiHexDigit(c: string | undefined): boolean {
  return isAsciiDigit(c) || (c !== undefined && ((c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')));
}

function isAsciiAlphanumeric(c: string | undefined): boolean {
  return isAsciiDigit(c) || (c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')));
}

function isSurrogate(cp: number): boolean { return cp >= 0xd800 && cp <= 0xdfff; }

function isNoncharacter(cp: number): boolean {
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  const low = cp & 0xffff;
  return low === 0xfffe || low === 0xffff;
}

/** ASCII whitespace, per the HTML Standard: tab, LF, FF, CR, space. */
function isAsciiWhitespace(cp: number): boolean {
  return cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d || cp === 0x20;
}

function isControl(cp: number): boolean {
  return (cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f);
}

/** Resolve the character reference beginning at `s[i]`, which must be '&'.
 *
 *  `inAttribute` selects the historical rule (§13.2.5.73) that decides whether
 *  a semicolon-less match is replaced at all — the whole reason mdentity.ts
 *  carries the legacy name set. */
export function resolveCharRef(s: string, i: number, inAttribute: boolean): CharRefResult {
  const next = s[i + 1];
  if (next === '#') return numericReference(s, i);
  if (isAsciiAlphanumeric(next)) return namedReference(s, i, inAttribute);
  // §13.2.5.72: anything else leaves the ampersand as literal text, with no
  // error — a bare '&' is not a malformed reference.
  return { text: '&', end: i + 1, errors: [] };
}

/** §13.2.5.73 Named character reference state. */
function namedReference(s: string, i: number, inAttribute: boolean): CharRefResult {
  // Longest match wins, and the scan must CONTINUE past a name that is present
  // in the table but not usable here: '&notin' falls back to '&not', because
  // 'notin' is spelled only with its semicolon while 'not' is a legacy name.
  const maxK = Math.min(MAX_ENTITY_NAME, s.length - (i + 1));
  for (let k = maxK; k >= 1; k--) {
    const name = s.slice(i + 1, i + 1 + k);
    const value = namedEntity(name);
    if (value === undefined) continue;

    if (s[i + 1 + k] === ';') {
      return { text: value, end: i + 1 + k + 1, errors: [] };
    }
    if (!allowsMissingSemicolon(name)) continue;

    const end = i + 1 + k;
    const after = s[end];
    // The historical rule: in an attribute, a semicolon-less match followed by
    // '=' or an alphanumeric is NOT replaced — the consumed text is flushed
    // literally, so `?a=1&copy=2` keeps its query string.
    if (inAttribute && (after === '=' || isAsciiAlphanumeric(after))) {
      return { text: s.slice(i, end), end, errors: [] };
    }
    return {
      text: value,
      end,
      errors: [{ code: 'missing-semicolon-after-character-reference', offset: end - i }],
    };
  }

  // §13.2.5.74 Ambiguous ampersand state. Nothing matched, so only the '&' is
  // consumed and the caller re-reads the rest as ordinary text — but a run of
  // alphanumerics closed by ';' is still reported, which is the whole content
  // of that state.
  let j = i + 1;
  while (isAsciiAlphanumeric(s[j])) j++;
  const errors: CharRefError[] = s[j] === ';'
    ? [{ code: 'unknown-named-character-reference', offset: j - i }]
    : [];
  return { text: '&', end: i + 1, errors };
}

/** §13.2.5.75–§13.2.5.80 the numeric branch. */
function numericReference(s: string, i: number): CharRefResult {
  const errors: CharRefError[] = [];
  const isHex = s[i + 2] === 'x' || s[i + 2] === 'X';
  const digitsAt = isHex ? i + 3 : i + 2;
  const isDigit = isHex ? isAsciiHexDigit : isAsciiDigit;

  let j = digitsAt;
  while (isDigit(s[j])) j++;

  if (j === digitsAt) {
    // §13.2.5.76/77: no digits at all. The consumed text is flushed literally
    // and the offending code point is NOT consumed.
    errors.push({ code: 'absence-of-digits-in-numeric-character-reference', offset: digitsAt - i });
    return { text: s.slice(i, digitsAt), end: digitsAt, errors };
  }

  // Parsed without a length cap: an overflowing value simply lands past
  // 0x10FFFF and is caught by the out-of-range rule below.
  let cp = Number.parseInt(s.slice(digitsAt, j), isHex ? 16 : 10);
  if (!Number.isFinite(cp)) cp = 0x110000;

  let end = j;
  if (s[j] === ';') end = j + 1;
  else errors.push({ code: 'missing-semicolon-after-character-reference', offset: j - i });

  // §13.2.5.80 numeric character reference end state, in the spec's own order.
  const at = end - i;
  if (cp === 0x00) {
    errors.push({ code: 'null-character-reference', offset: at });
    return { text: REPLACEMENT, end, errors };
  }
  if (cp > 0x10ffff) {
    errors.push({ code: 'character-reference-outside-unicode-range', offset: at });
    return { text: REPLACEMENT, end, errors };
  }
  if (isSurrogate(cp)) {
    errors.push({ code: 'surrogate-character-reference', offset: at });
    return { text: REPLACEMENT, end, errors };
  }
  if (isNoncharacter(cp)) {
    errors.push({ code: 'noncharacter-character-reference', offset: at });
    return { text: String.fromCodePoint(cp), end, errors };
  }
  if (cp === 0x0d || (isControl(cp) && !isAsciiWhitespace(cp))) {
    errors.push({ code: 'control-character-reference', offset: at });
    const mapped = C1_REPLACEMENTS.get(cp);
    if (mapped !== undefined) cp = mapped;
  }
  return { text: String.fromCodePoint(cp), end, errors };
}
