/**
 * A Type 1 program's cleartext header, read as cheaply as possible.
 *
 * A pure leaf with no imports. Three unrelated callers want it and only one of
 * them wants the charstring interpreter: `fontsource.ts` indexes thousands of
 * files and must not pull in an engine to read a family name, `type1cff.ts`
 * wants `/FontName` and `/FontBBox`, and `type1.ts` wants `/FontMatrix`.
 *
 * Everything here lives BEFORE the `eexec` keyword, so a few hundred bytes of
 * prefix suffice — which is what keeps the folder index's partial-read cost
 * model intact when a `.pfb` is indexed.
 */

/** The header fields anything outside this module needs. */
export interface Type1Header {
  /** /FontName — becomes the sfnt PostScript name, and hence /BaseFont. */
  fontName?: string;
  /** /FamilyName. */
  familyName?: string;
  /** /Weight — 'Bold', 'Light', ... the words fontmatch.ts already parses. */
  weight?: string;
  /** /ItalicAngle; 0 when the header states none. */
  italicAngle: number;
  /** /FontBBox, or undefined when the header states none. */
  bbox?: [number, number, number, number];
  /** Units per em from /FontMatrix; 1000 when it states none. */
  unitsPerEm: number;
}

/** PFB segment marker, then a binary-segment type byte. */
const isPfb = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x80 && b[1] === 0x01;
/** '%!' — a PostScript program, which is how a PFA and a /FontFile body open. */
const isPs = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x25 && b[1] === 0x21;

/**
 * Whether `bytes` opens as a Type 1 program. A prefix is enough.
 *
 * Deliberately loose: a PostScript file that is not a font passes here and is
 * rejected later, by `readType1Header` reporting no `/FontName` or by
 * `Type1Font` finding no `/CharStrings`. A tighter test would have to parse,
 * which is the thing this exists to avoid.
 */
export function isType1(bytes: Uint8Array): boolean {
  return isPfb(bytes) || isPs(bytes);
}

/** Concatenate a PFB's segments, or return `bytes` unchanged. Mirrors
 *  `stripPfb` in type1.ts, kept local so this module imports nothing. */
function stripPfb(bytes: Uint8Array): Uint8Array {
  if (!isPfb(bytes)) return bytes;
  const parts: Uint8Array[] = [];
  let p = 0;
  while (p + 6 <= bytes.length && bytes[p] === 0x80) {
    if (bytes[p + 1] === 3) break;                 // EOF segment
    const len = bytes[p + 2] | (bytes[p + 3] << 8) | (bytes[p + 4] << 16) | (bytes[p + 5] << 24);
    if (len < 0 || p + 6 + len > bytes.length) break;
    parts.push(bytes.subarray(p + 6, p + 6 + len));
    p += 6 + len;
  }
  if (parts.length === 0) return bytes;
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

const asciiOf = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

function indexOfAscii(b: Uint8Array, s: string): number {
  outer: for (let i = 0; i + s.length <= b.length; i++) {
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** The text following `key`, capped — every value here is short. */
function after(b: Uint8Array, key: string): string | undefined {
  const at = indexOfAscii(b, key);
  if (at < 0) return undefined;
  return asciiOf(b, at + key.length, at + key.length + 256);
}

/** `/Key (value) readonly def` — a parenthesised PostScript string. */
function psString(b: Uint8Array, key: string): string | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const open = tail.indexOf('(');
  if (open < 0) return undefined;
  const close = tail.indexOf(')', open + 1);
  return close < 0 ? undefined : tail.slice(open + 1, close);
}

/** `/FontName /Value def` — a PostScript NAME, not a string. */
function psName(b: Uint8Array, key: string): string | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const slash = tail.indexOf('/');
  if (slash < 0) return undefined;
  const m = /^[^\s/(){}[\]<>%]+/.exec(tail.slice(slash + 1));
  return m ? m[0] : undefined;
}

/** `/Key 0.0 def` — a bare number. */
function psNumber(b: Uint8Array, key: string): number | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const m = /^\s*([-+]?[0-9]*\.?[0-9]+)/.exec(tail);
  return m ? Number(m[1]) : undefined;
}

/** Four numbers in `{...}` or `[...]`. Real fonts use both. */
function psNumbers(b: Uint8Array, key: string): number[] | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const m = /[{[]([^}\]]*)[}\]]/.exec(tail);
  if (!m) return undefined;
  const out = m[1].trim().split(/\s+/).map(Number);
  return out.every((n) => Number.isFinite(n)) ? out : undefined;
}

/**
 * Read the cleartext header.
 *
 * Never throws: a PostScript file that is not a font yields a header stating
 * nothing, which every caller already treats as unusable. One unreadable file
 * in a system font directory must not break every lookup on the machine.
 */
export function readType1Header(bytes: Uint8Array): Type1Header {
  const b = stripPfb(bytes);
  const at = indexOfAscii(b, 'eexec');
  const clear = at < 0 ? b : b.subarray(0, at);

  const fm = psNumbers(clear, '/FontMatrix');
  const first = fm && fm.length > 0 ? fm[0] : undefined;
  const unitsPerEm = first !== undefined && Number.isFinite(first) && first !== 0
    ? Math.round(1 / first)
    : 1000;

  const box = psNumbers(clear, '/FontBBox');
  return {
    fontName: psName(clear, '/FontName'),
    familyName: psString(clear, '/FamilyName'),
    weight: psString(clear, '/Weight'),
    italicAngle: psNumber(clear, '/ItalicAngle') ?? 0,
    bbox: box && box.length === 4 ? [box[0], box[1], box[2], box[3]] : undefined,
    unitsPerEm,
  };
}
