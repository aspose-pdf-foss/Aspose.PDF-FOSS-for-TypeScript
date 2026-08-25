// Base text encodings (code 0..255 -> Unicode string) and a glyph-name resolver.
// Tables for the high range of MacRoman/Standard are transcribed from
// ISO 32000-1:2008 Annex D, Table D.2.

/** Curated Adobe-glyph-name -> Unicode codepoint map (Latin set + common symbols).
 *  Sufficient for /Differences arrays seen in real PDFs; extend as needed. */
const GLYPH_NAMES: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
  percent: 0x25, ampersand: 0x26, quotesingle: 0x27, quoteright: 0x2019,
  parenleft: 0x28, parenright: 0x29, asterisk: 0x2a, plus: 0x2b, comma: 0x2c,
  hyphen: 0x2d, period: 0x2e, slash: 0x2f,
  zero: 0x30, one: 0x31, two: 0x32, three: 0x33, four: 0x34, five: 0x35,
  six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39,
  colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e,
  question: 0x3f, at: 0x40,
  bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e,
  underscore: 0x5f, grave: 0x60, quoteleft: 0x2018,
  braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  // common punctuation / symbols
  bullet: 0x2022, ellipsis: 0x2026, emdash: 0x2014, endash: 0x2013,
  quotedblleft: 0x201c, quotedblright: 0x201d, quotesinglbase: 0x201a,
  quotedblbase: 0x201e, dagger: 0x2020, daggerdbl: 0x2021, perthousand: 0x2030,
  guilsinglleft: 0x2039, guilsinglright: 0x203a, fraction: 0x2044,
  florin: 0x0192, trademark: 0x2122, Euro: 0x20ac, currency: 0x00a4,
  degree: 0x00b0, plusminus: 0x00b1, multiply: 0x00d7, divide: 0x00f7,
  copyright: 0x00a9, registered: 0x00ae, paragraph: 0x00b6, section: 0x00a7,
  periodcentered: 0x00b7, cent: 0x00a2, sterling: 0x00a3, yen: 0x00a5,
  brokenbar: 0x00a6, logicalnot: 0x00ac, macron: 0x00af, acute: 0x00b4,
  cedilla: 0x00b8, questiondown: 0x00bf, exclamdown: 0x00a1,
  guillemotleft: 0x00ab, guillemotright: 0x00bb, ordfeminine: 0x00aa,
  ordmasculine: 0x00ba, onequarter: 0x00bc, onehalf: 0x00bd, threequarters: 0x00be,
  onesuperior: 0x00b9, twosuperior: 0x00b2, threesuperior: 0x00b3,
  mu: 0x00b5, dotlessi: 0x0131, circumflex: 0x02c6, tilde: 0x02dc,
  caron: 0x02c7, breve: 0x02d8, dotaccent: 0x02d9, ring: 0x02da,
  hungarumlaut: 0x02dd, ogonek: 0x02db,
};

// Accented Latin letters: build "<base><accentword>" names programmatically.
const ACCENTS: Record<string, Record<string, number>> = {
  acute:     { A:0xc1,E:0xc9,I:0xcd,O:0xd3,U:0xda,Y:0xdd,a:0xe1,e:0xe9,i:0xed,o:0xf3,u:0xfa,y:0xfd },
  grave:     { A:0xc0,E:0xc8,I:0xcc,O:0xd2,U:0xd9,a:0xe0,e:0xe8,i:0xec,o:0xf2,u:0xf9 },
  circumflex:{ A:0xc2,E:0xca,I:0xce,O:0xd4,U:0xdb,a:0xe2,e:0xea,i:0xee,o:0xf4,u:0xfb },
  tilde:     { A:0xc3,N:0xd1,O:0xd5,a:0xe3,n:0xf1,o:0xf5 },
  dieresis:  { A:0xc4,E:0xcb,I:0xcf,O:0xd6,U:0xdc,Y:0x178,a:0xe4,e:0xeb,i:0xef,o:0xf6,u:0xfc,y:0xff },
  ring:      { A:0xc5,a:0xe5 },
  cedilla:   { C:0xc7,c:0xe7 },
};
const SPECIAL_LETTERS: Record<string, number> = {
  AE:0xc6, ae:0xe6, Oslash:0xd8, oslash:0xf8, Eth:0xd0, eth:0xf0,
  Thorn:0xde, thorn:0xfe, germandbls:0xdf, OE:0x152, oe:0x153,
  Scaron:0x160, scaron:0x161, Zcaron:0x17d, zcaron:0x17e, Ydieresis:0x178,
};

const NAME_TO_CP: Record<string, number> = (() => {
  const m: Record<string, number> = { ...GLYPH_NAMES, ...SPECIAL_LETTERS };
  // single ASCII letters A..Z, a..z
  for (let c = 0x41; c <= 0x5a; c++) m[String.fromCharCode(c)] = c;
  for (let c = 0x61; c <= 0x7a; c++) m[String.fromCharCode(c)] = c;
  for (const [accent, table] of Object.entries(ACCENTS)) {
    for (const [base, cp] of Object.entries(table)) m[base + accent] = cp;
  }
  return m;
})();

/** Resolve an Adobe glyph name to a Unicode string, or undefined. */
export function glyphToUnicode(name: string): string | undefined {
  const cp = NAME_TO_CP[name];
  if (cp !== undefined) return String.fromCodePoint(cp);
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const v = parseInt(m[1], 16);
    if (v <= 0x10ffff) return String.fromCodePoint(v);
  }
  return undefined;
}

type Enc = (string | undefined)[];

/** WinAnsiEncoding: Latin-1 baseline (0x20..0xFF) with the CP1252 0x80..0x9F block. */
export const winAnsi: Enc = (() => {
  const t: Enc = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0xff; c++) t[c] = String.fromCharCode(c);
  const over: Record<number, number> = {
    0x80:0x20ac,0x82:0x201a,0x83:0x0192,0x84:0x201e,0x85:0x2026,0x86:0x2020,
    0x87:0x2021,0x88:0x02c6,0x89:0x2030,0x8a:0x0160,0x8b:0x2039,0x8c:0x0152,
    0x8e:0x017d,0x91:0x2018,0x92:0x2019,0x93:0x201c,0x94:0x201d,0x95:0x2022,
    0x96:0x2013,0x97:0x2014,0x98:0x02dc,0x99:0x2122,0x9a:0x0161,0x9b:0x203a,
    0x9c:0x0153,0x9e:0x017e,0x9f:0x0178,
  };
  for (const k of Object.keys(over)) t[+k] = String.fromCodePoint(over[+k]);
  for (const c of [0x81,0x8d,0x8f,0x90,0x9d]) t[c] = undefined; // unused slots
  return t;
})();

/** Reverse of the WinAnsi table: Unicode codepoint -> byte code. Built once.
 *  Lower codes win when two slots share a codepoint (none do in WinAnsi). */
const WINANSI_REVERSE: Map<number, number> = (() => {
  const m = new Map<number, number>();
  for (let code = 0; code < 256; code++) {
    const ch = winAnsi[code];
    if (ch === undefined) continue;
    const cp = ch.codePointAt(0)!;
    if (!m.has(cp)) m.set(cp, code);
  }
  return m;
})();

/** Encode a JS string to WinAnsiEncoding bytes, dropping unrepresentable
 *  codepoints (so callers never throw on a stray glyph). */
export function encodeWinAnsi(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const code = WINANSI_REVERSE.get(ch.codePointAt(0)!);
    if (code !== undefined) out.push(code);
  }
  return Uint8Array.from(out);
}

/** PDFDocEncoding: like WinAnsi for ASCII; the CP1252 punctuation lives in 0x18..0x1F and 0xA0.
 *  Only the entries needed in practice are pinned; baseline mirrors Latin-1. */
export const pdfDocEncoding: Enc = (() => {
  const t = winAnsi.slice();
  t[0xa0] = '€'; // Euro in PDFDocEncoding
  t[0xad] = '­';
  return t;
})();

/** StandardEncoding (Adobe): ASCII letters/digits, typographic quotes at 0x27/0x60,
 *  high range per ISO 32000-1 Annex D Table D.2 "STD" column. */
export const standardEncoding: Enc = (() => {
  const t: Enc = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0x7e; c++) t[c] = String.fromCharCode(c);
  t[0x27] = '’'; // quoteright
  t[0x60] = '‘'; // quoteleft
  // High range (0xA1..0xFF) from Annex D Table D.2 STD column.
  const over: Record<number, number> = {
    0xa1:0xa1, 0xa2:0xa2, 0xa3:0xa3, 0xa4:0x2044, 0xa5:0xa5, 0xa6:0x192,
    0xa7:0xa7, 0xa8:0xa4, 0xa9:0x27, 0xaa:0x201c, 0xab:0xab, 0xac:0x2039,
    0xad:0x203a, 0xae:0xfb01, 0xaf:0xfb02,
    0xb1:0x2013, 0xb2:0x2020, 0xb3:0x2021, 0xb4:0xb7, 0xb6:0xb6, 0xb7:0x2022,
    0xb8:0x201a, 0xb9:0x201e, 0xba:0x201d, 0xbb:0xbb, 0xbc:0x2026, 0xbd:0x2030,
    0xbf:0xbf, 0xc1:0x60, 0xc2:0xb4, 0xc3:0x2c6, 0xc4:0x2dc, 0xc5:0xaf,
    0xc6:0x2d8, 0xc7:0x2d9, 0xc8:0xa8, 0xca:0x2da, 0xcb:0xb8, 0xcd:0x2dd,
    0xce:0x2db, 0xcf:0x2c7, 0xd0:0x2014, 0xe1:0xc6, 0xe3:0xaa, 0xe8:0x141,
    0xe9:0xd8, 0xea:0x152, 0xeb:0xba, 0xf1:0xe6, 0xf5:0x131, 0xf8:0x142,
    0xf9:0xf8, 0xfa:0x153, 0xfb:0xdf,
  };
  for (const k of Object.keys(over)) t[+k] = String.fromCodePoint(over[+k]);
  return t;
})();

/** MacRomanEncoding: ASCII baseline + 0x80..0xFF per ISO 32000-1 Annex D Table D.2
 *  "MAC" column (transcribe below). */
export const macRoman: Enc = (() => {
  const t: Enc = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0x7e; c++) t[c] = String.fromCharCode(c);
  // 0x80..0xFF from Annex D Table D.2 MAC column. Seed entries (verified):
  const high: Record<number, number> = {
    0x80:0xc4,0x81:0xc5,0x82:0xc7,0x83:0xc9,0x84:0xd1,0x85:0xd6,0x86:0xdc,
    0x87:0xe1,0x88:0xe0,0x89:0xe2,0x8a:0xe4,0x8b:0xe3,0x8c:0xe5,0x8d:0xe7,
    0x8e:0xe9,0x8f:0xe8,0x90:0xea,0x91:0xeb,0x92:0xed,0x93:0xec,0x94:0xee,
    0x95:0xef,0x96:0xf1,0x97:0xf3,0x98:0xf2,0x99:0xf4,0x9a:0xf6,0x9b:0xf5,
    0x9c:0xfa,0x9d:0xf9,0x9e:0xfb,0x9f:0xfc,0xa0:0x2020,0xa1:0xb0,0xa2:0xa2,
    0xa3:0xa3,0xa4:0xa7,0xa5:0x2022,0xa6:0xb6,0xa7:0xdf,0xa8:0xae,0xa9:0xa9,
    0xaa:0x2122,0xab:0xb4,0xac:0xa8,0xae:0xc6,0xaf:0xd8,0xb0:0x221e,0xb1:0xb1,
    0xb4:0xa5,0xb5:0xb5,0xbb:0xaa,0xbc:0xba,0xbe:0xe6,0xbf:0xf8,0xc0:0xbf,
    0xc1:0xa1,0xc2:0xac,0xc4:0x192,0xc7:0xab,0xc8:0xbb,0xc9:0x2026,0xca:0xa0,0xcb:0xc0,
    0xcc:0xc3,0xcd:0xd5,0xce:0x152,0xcf:0x153,0xd0:0x2013,0xd1:0x2014,
    0xd2:0x201c,0xd3:0x201d,0xd4:0x2018,0xd5:0x2019,0xd6:0xf7,0xd8:0xff,
    0xd9:0x178,0xda:0x2044,0xdb:0xa4,0xdc:0x2039,0xdd:0x203a,0xde:0xfb01,
    0xdf:0xfb02,0xe0:0x2021,0xe1:0xb7,0xe2:0x201a,0xe3:0x201e,0xe4:0x2030,
    0xe5:0xc2,0xe6:0xca,0xe7:0xc1,0xe8:0xcb,0xe9:0xc8,0xea:0xcd,0xeb:0xce,
    0xec:0xcf,0xed:0xcc,0xee:0xd3,0xef:0xd4,0xf1:0xd2,0xf2:0xda,0xf3:0xdb,
    0xf4:0xd9,0xf5:0x131,0xf6:0x2c6,0xf7:0x2dc,0xf8:0xaf,0xf9:0x2d8,
    0xfa:0x2d9,0xfb:0x2da,0xfc:0xb8,0xfd:0x2dd,0xfe:0x2db,0xff:0x2c7,
  };
  for (const k of Object.keys(high)) t[+k] = String.fromCodePoint(high[+k]);
  return t;
})();

/** Look up a base encoding by its PDF name; defaults to WinAnsi. */
export function baseEncodingByName(name: string | undefined): Enc {
  switch (name) {
    case 'MacRomanEncoding': return macRoman;
    case 'StandardEncoding': return standardEncoding;
    case 'PDFDocEncoding': return pdfDocEncoding;
    case 'WinAnsiEncoding':
    default: return winAnsi;
  }
}

// ---------- Annex D Table D.2: code -> glyph name ----------
//
// The counterpart to the code -> Unicode tables above, and the only route from
// a character code to a Type 1 font's /CharStrings or a name-keyed CFF's
// charset — both of which are keyed by glyph name, not by character.
//
// Deriving these by inverting the Unicode tables through the AGL was rejected:
// the mapping is many-to-one (/quoteright and /quotesingle, /hyphen and /minus,
// /space and the two non-breaking codes below), and cidunicode.ts records what
// inverting a many-to-one mapping costs.
//
// PDFDocEncoding has no column: 32000-1 Table 114 admits only MacRoman,
// MacExpert and WinAnsi as /BaseEncoding, with Standard as the default, so
// PDFDoc is a text-string encoding that no font can name.

/** Codes 0x20..0x7E, shared by all three encodings but for two codes. */
const ASCII_NAMES: string[] = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand',
  'quotesingle', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma',
  'hyphen', 'period', 'slash', 'zero', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal',
  'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I',
  'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X',
  'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum',
  'underscore', 'grave', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
  'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y',
  'z', 'braceleft', 'bar', 'braceright', 'asciitilde',
];

/** StandardEncoding's high range (Annex D Table D.2, STD column). */
const STD_HIGH: Record<number, string> = {
  0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'fraction', 0xa5: 'yen',
  0xa6: 'florin', 0xa7: 'section', 0xa8: 'currency', 0xa9: 'quotesingle',
  0xaa: 'quotedblleft', 0xab: 'guillemotleft', 0xac: 'guilsinglleft',
  0xad: 'guilsinglright', 0xae: 'fi', 0xaf: 'fl',
  0xb1: 'endash', 0xb2: 'dagger', 0xb3: 'daggerdbl', 0xb4: 'periodcentered',
  0xb6: 'paragraph', 0xb7: 'bullet', 0xb8: 'quotesinglbase', 0xb9: 'quotedblbase',
  0xba: 'quotedblright', 0xbb: 'guillemotright', 0xbc: 'ellipsis',
  0xbd: 'perthousand', 0xbf: 'questiondown',
  0xc1: 'grave', 0xc2: 'acute', 0xc3: 'circumflex', 0xc4: 'tilde', 0xc5: 'macron',
  0xc6: 'breve', 0xc7: 'dotaccent', 0xc8: 'dieresis', 0xca: 'ring', 0xcb: 'cedilla',
  0xcd: 'hungarumlaut', 0xce: 'ogonek', 0xcf: 'caron', 0xd0: 'emdash',
  0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash', 0xe9: 'Oslash', 0xea: 'OE',
  0xeb: 'ordmasculine', 0xf1: 'ae', 0xf5: 'dotlessi', 0xf8: 'lslash',
  0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls',
};

/** MacRomanEncoding's high range (Annex D Table D.2, MAC column). Apple's own
 *  MacRoman additions — /infinity at 0xB0 and the other maths glyphs — are not
 *  in Table D.2 and are deliberately absent. */
const MAC_HIGH: Record<number, string> = {
  0x80: 'Adieresis', 0x81: 'Aring', 0x82: 'Ccedilla', 0x83: 'Eacute', 0x84: 'Ntilde',
  0x85: 'Odieresis', 0x86: 'Udieresis', 0x87: 'aacute', 0x88: 'agrave',
  0x89: 'acircumflex', 0x8a: 'adieresis', 0x8b: 'atilde', 0x8c: 'aring',
  0x8d: 'ccedilla', 0x8e: 'eacute', 0x8f: 'egrave', 0x90: 'ecircumflex',
  0x91: 'edieresis', 0x92: 'iacute', 0x93: 'igrave', 0x94: 'icircumflex',
  0x95: 'idieresis', 0x96: 'ntilde', 0x97: 'oacute', 0x98: 'ograve',
  0x99: 'ocircumflex', 0x9a: 'odieresis', 0x9b: 'otilde', 0x9c: 'uacute',
  0x9d: 'ugrave', 0x9e: 'ucircumflex', 0x9f: 'udieresis',
  0xa0: 'dagger', 0xa1: 'degree', 0xa2: 'cent', 0xa3: 'sterling', 0xa4: 'section',
  0xa5: 'bullet', 0xa6: 'paragraph', 0xa7: 'germandbls', 0xa8: 'registered',
  0xa9: 'copyright', 0xaa: 'trademark', 0xab: 'acute', 0xac: 'dieresis',
  0xae: 'AE', 0xaf: 'Oslash', 0xb1: 'plusminus', 0xb4: 'yen', 0xb5: 'mu',
  0xbb: 'ordfeminine', 0xbc: 'ordmasculine', 0xbe: 'ae', 0xbf: 'oslash',
  0xc0: 'questiondown', 0xc1: 'exclamdown', 0xc2: 'logicalnot', 0xc4: 'florin',
  0xc7: 'guillemotleft', 0xc8: 'guillemotright', 0xc9: 'ellipsis', 0xca: 'space',
  0xcb: 'Agrave', 0xcc: 'Atilde', 0xcd: 'Otilde', 0xce: 'OE', 0xcf: 'oe',
  0xd0: 'endash', 0xd1: 'emdash', 0xd2: 'quotedblleft', 0xd3: 'quotedblright',
  0xd4: 'quoteleft', 0xd5: 'quoteright', 0xd6: 'divide', 0xd8: 'ydieresis',
  0xd9: 'Ydieresis', 0xda: 'fraction', 0xdb: 'currency', 0xdc: 'guilsinglleft',
  0xdd: 'guilsinglright', 0xde: 'fi', 0xdf: 'fl', 0xe0: 'daggerdbl',
  0xe1: 'periodcentered', 0xe2: 'quotesinglbase', 0xe3: 'quotedblbase',
  0xe4: 'perthousand', 0xe5: 'Acircumflex', 0xe6: 'Ecircumflex', 0xe7: 'Aacute',
  0xe8: 'Edieresis', 0xe9: 'Egrave', 0xea: 'Iacute', 0xeb: 'Icircumflex',
  0xec: 'Idieresis', 0xed: 'Igrave', 0xee: 'Oacute', 0xef: 'Ocircumflex',
  0xf1: 'Ograve', 0xf2: 'Uacute', 0xf3: 'Ucircumflex', 0xf4: 'Ugrave',
  0xf5: 'dotlessi', 0xf6: 'circumflex', 0xf7: 'tilde', 0xf8: 'macron',
  0xf9: 'breve', 0xfa: 'dotaccent', 0xfb: 'ring', 0xfc: 'cedilla',
  0xfd: 'hungarumlaut', 0xfe: 'ogonek', 0xff: 'caron',
};

/** WinAnsiEncoding's high range (Annex D Table D.2, WIN column). 0xA0 and 0xAD
 *  are Annex D's documented duplicates: /space and /hyphen a second time. */
const WIN_HIGH: Record<number, string> = {
  0x80: 'Euro', 0x82: 'quotesinglbase', 0x83: 'florin', 0x84: 'quotedblbase',
  0x85: 'ellipsis', 0x86: 'dagger', 0x87: 'daggerdbl', 0x88: 'circumflex',
  0x89: 'perthousand', 0x8a: 'Scaron', 0x8b: 'guilsinglleft', 0x8c: 'OE',
  0x8e: 'Zcaron', 0x91: 'quoteleft', 0x92: 'quoteright', 0x93: 'quotedblleft',
  0x94: 'quotedblright', 0x95: 'bullet', 0x96: 'endash', 0x97: 'emdash',
  0x98: 'tilde', 0x99: 'trademark', 0x9a: 'scaron', 0x9b: 'guilsinglright',
  0x9c: 'oe', 0x9e: 'zcaron', 0x9f: 'Ydieresis',
  0xa0: 'space', 0xa1: 'exclamdown', 0xa2: 'cent', 0xa3: 'sterling',
  0xa4: 'currency', 0xa5: 'yen', 0xa6: 'brokenbar', 0xa7: 'section',
  0xa8: 'dieresis', 0xa9: 'copyright', 0xaa: 'ordfeminine', 0xab: 'guillemotleft',
  0xac: 'logicalnot', 0xad: 'hyphen', 0xae: 'registered', 0xaf: 'macron',
  0xb0: 'degree', 0xb1: 'plusminus', 0xb2: 'twosuperior', 0xb3: 'threesuperior',
  0xb4: 'acute', 0xb5: 'mu', 0xb6: 'paragraph', 0xb7: 'periodcentered',
  0xb8: 'cedilla', 0xb9: 'onesuperior', 0xba: 'ordmasculine',
  0xbb: 'guillemotright', 0xbc: 'onequarter', 0xbd: 'onehalf',
  0xbe: 'threequarters', 0xbf: 'questiondown',
  0xc0: 'Agrave', 0xc1: 'Aacute', 0xc2: 'Acircumflex', 0xc3: 'Atilde',
  0xc4: 'Adieresis', 0xc5: 'Aring', 0xc6: 'AE', 0xc7: 'Ccedilla', 0xc8: 'Egrave',
  0xc9: 'Eacute', 0xca: 'Ecircumflex', 0xcb: 'Edieresis', 0xcc: 'Igrave',
  0xcd: 'Iacute', 0xce: 'Icircumflex', 0xcf: 'Idieresis', 0xd0: 'Eth',
  0xd1: 'Ntilde', 0xd2: 'Ograve', 0xd3: 'Oacute', 0xd4: 'Ocircumflex',
  0xd5: 'Otilde', 0xd6: 'Odieresis', 0xd7: 'multiply', 0xd8: 'Oslash',
  0xd9: 'Ugrave', 0xda: 'Uacute', 0xdb: 'Ucircumflex', 0xdc: 'Udieresis',
  0xdd: 'Yacute', 0xde: 'Thorn', 0xdf: 'germandbls',
  0xe0: 'agrave', 0xe1: 'aacute', 0xe2: 'acircumflex', 0xe3: 'atilde',
  0xe4: 'adieresis', 0xe5: 'aring', 0xe6: 'ae', 0xe7: 'ccedilla', 0xe8: 'egrave',
  0xe9: 'eacute', 0xea: 'ecircumflex', 0xeb: 'edieresis', 0xec: 'igrave',
  0xed: 'iacute', 0xee: 'icircumflex', 0xef: 'idieresis', 0xf0: 'eth',
  0xf1: 'ntilde', 0xf2: 'ograve', 0xf3: 'oacute', 0xf4: 'ocircumflex',
  0xf5: 'otilde', 0xf6: 'odieresis', 0xf7: 'divide', 0xf8: 'oslash',
  0xf9: 'ugrave', 0xfa: 'uacute', 0xfb: 'ucircumflex', 0xfc: 'udieresis',
  0xfd: 'yacute', 0xfe: 'thorn', 0xff: 'ydieresis',
};

type Names = (string | undefined)[];

function buildNames(high: Record<number, string>, asciiOverrides: Record<number, string>): Names {
  const t: Names = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0x7e; c++) t[c] = ASCII_NAMES[c - 0x20];
  for (const k of Object.keys(asciiOverrides)) t[+k] = asciiOverrides[+k];
  for (const k of Object.keys(high)) t[+k] = high[+k];
  return t;
}

/** StandardEncoding as glyph names. Its two ASCII departures are the typographic
 *  quotes: 0x27 is /quoteright and 0x60 is /quoteleft, where the other two
 *  encodings carry the straight /quotesingle and /grave. */
export const standardEncodingNames: Names = buildNames(STD_HIGH, { 0x27: 'quoteright', 0x60: 'quoteleft' });
export const macRomanEncodingNames: Names = buildNames(MAC_HIGH, {});
export const winAnsiEncodingNames: Names = buildNames(WIN_HIGH, {});

/**
 * Glyph names for a base encoding a font dict may name, or `undefined` when we
 * have no table for it.
 *
 * Unlike {@link baseEncodingByName} this does *not* default to WinAnsi. A
 * caller that gets `undefined` must fall through to the font program's own
 * encoding, which is a real answer; defaulting would hand it a wrong one.
 */
export function baseEncodingNamesByName(name: string | undefined): Names | undefined {
  switch (name) {
    case 'StandardEncoding': return standardEncodingNames;
    case 'MacRomanEncoding': return macRomanEncodingNames;
    case 'WinAnsiEncoding': return winAnsiEncodingNames;
    default: return undefined;
  }
}
