// Adobe Core-14 glyph advance widths (1000-unit em). The Helvetica table is
// indexed directly by WinAnsiEncoding byte code; the remaining Latin text fonts
// are built from per-font glyph-name -> width maps via the shared WINANSI_NAMES
// code -> glyph-name table, so a single name table drives all of them. Symbol
// and ZapfDingbats use their own built-in encodings and are covered only for the
// glyphs this library actually emits (the button check/circle).

// Adobe Core-14 Helvetica glyph advance widths (1000-unit em), indexed by
// WinAnsiEncoding byte code. Transcribed from the Helvetica AFM; codes with no
// glyph (control range, unused CP1252 slots) are 0.
export const HELVETICA_WIDTHS: readonly number[] = [
  // 0x00..0x0F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // 0x10..0x1F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // 0x20..0x2F  space ! " # $ % & ' ( ) * + , - . /
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  // 0x30..0x3F  0-9 : ; < = > ?
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  // 0x40..0x4F  @ A-O
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  // 0x50..0x5F  P-Z [ \ ] ^ _
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  // 0x60..0x6F  ` a-o
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  // 0x70..0x7F  p-z { | } ~ (del)
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  // 0x80..0x8F  Euro . quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE . Zcaron .
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  // 0x90..0x9F  . quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe . zcaron Ydieresis
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  // 0xA0..0xAF  nbsp exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  // 0xB0..0xBF  degree plusminus 2 3 acute mu paragraph periodcentered cedilla 1 ordmasculine guillemotright 1/4 1/2 3/4 questiondown
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  // 0xC0..0xCF  Agrave..Aring AE Ccedilla Egrave..Edieresis Igrave..Idieresis
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  // 0xD0..0xDF  Eth Ntilde Ograve..Odieresis multiply Oslash Ugrave..Udieresis Yacute Thorn germandbls
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  // 0xE0..0xEF  agrave..aring ae ccedilla egrave..edieresis igrave..idieresis
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  // 0xF0..0xFF  eth ntilde ograve..odieresis divide oslash ugrave..udieresis yacute thorn ydieresis
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

export type StdFont =
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique'
  | 'Symbol' | 'ZapfDingbats';

// WinAnsiEncoding byte code -> Adobe glyph name (0x20..0xFF; gaps are undefined).
// Built from the row layout annotated in HELVETICA_WIDTHS above.
const WINANSI_NAMES: (string | undefined)[] = (() => {
  const t: (string | undefined)[] = new Array(256).fill(undefined);
  const put = (start: number, names: (string | undefined)[]) =>
    names.forEach((n, i) => { t[start + i] = n; });
  const upper = (s: string) => s.split(' ');
  put(0x20, upper('space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash'));
  put(0x30, upper('zero one two three four five six seven eight nine colon semicolon less equal greater question'));
  put(0x40, upper('at A B C D E F G H I J K L M N O'));
  put(0x50, upper('P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore'));
  put(0x60, upper('grave a b c d e f g h i j k l m n o'));
  put(0x70, ['p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde', undefined]);
  put(0x80, ['Euro', undefined, 'quotesinglbase', 'florin', 'quotedblbase', 'ellipsis', 'dagger', 'daggerdbl', 'circumflex', 'perthousand', 'Scaron', 'guilsinglleft', 'OE', undefined, 'Zcaron', undefined]);
  put(0x90, [undefined, 'quoteleft', 'quoteright', 'quotedblleft', 'quotedblright', 'bullet', 'endash', 'emdash', 'tilde', 'trademark', 'scaron', 'guilsinglright', 'oe', undefined, 'zcaron', 'Ydieresis']);
  // 0xA0 nbsp shares the 'space' width.
  put(0xa0, upper('space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron'));
  put(0xb0, upper('degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown'));
  put(0xc0, upper('Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis'));
  put(0xd0, upper('Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls'));
  put(0xe0, upper('agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis'));
  put(0xf0, upper('eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'));
  return t;
})();

type WMap = Record<string, number>;

// Expand accent groups (all share one width per font) onto a base name->width map.
function withAccents(base: WMap, w: {
  A: number; E: number; I: number; O: number; U: number;
  a: number; e: number; i: number; o: number; u: number;
  Ccedilla: number; ccedilla: number; Ntilde: number; ntilde: number;
  Yacute: number; yacute: number; Eth: number; eth: number; Thorn: number; thorn: number;
  AE: number; ae: number; Oslash: number; oslash: number; germandbls: number;
  Ydieresis: number; ydieresis: number;
}): WMap {
  const m: WMap = { ...base };
  const set = (names: string, v: number) => names.split(' ').forEach((n) => { m[n] = v; });
  set('Agrave Aacute Acircumflex Atilde Adieresis Aring', w.A);
  set('Egrave Eacute Ecircumflex Edieresis', w.E);
  set('Igrave Iacute Icircumflex Idieresis', w.I);
  set('Ograve Oacute Ocircumflex Otilde Odieresis', w.O);
  set('Ugrave Uacute Ucircumflex Udieresis', w.U);
  set('agrave aacute acircumflex atilde adieresis aring', w.a);
  set('egrave eacute ecircumflex edieresis', w.e);
  set('igrave iacute icircumflex idieresis', w.i);
  set('ograve oacute ocircumflex otilde odieresis', w.o);
  set('ugrave uacute ucircumflex udieresis', w.u);
  m.Ccedilla = w.Ccedilla; m.ccedilla = w.ccedilla; m.Ntilde = w.Ntilde; m.ntilde = w.ntilde;
  m.Yacute = w.Yacute; m.yacute = w.yacute; m.Eth = w.Eth; m.eth = w.eth;
  m.Thorn = w.Thorn; m.thorn = w.thorn; m.AE = w.AE; m.ae = w.ae;
  m.Oslash = w.Oslash; m.oslash = w.oslash; m.germandbls = w.germandbls;
  m.Ydieresis = w.Ydieresis; m.ydieresis = w.ydieresis;
  return m;
}

// Build a 256-entry WinAnsi-indexed width array from a name->width map.
function mkWidths(map: WMap): number[] {
  const out = new Array(256).fill(0);
  for (let code = 0; code < 256; code++) {
    const n = WINANSI_NAMES[code];
    if (n !== undefined && map[n] !== undefined) out[code] = map[n];
  }
  return out;
}

const HELVETICA_BOLD_MAP: WMap = withAccents({
  space: 278, exclam: 333, quotedbl: 474, numbersign: 556, dollar: 556, percent: 889,
  ampersand: 722, quotesingle: 238, parenleft: 333, parenright: 333, asterisk: 389, plus: 584,
  comma: 278, hyphen: 333, period: 278, slash: 278,
  zero: 556, one: 556, two: 556, three: 556, four: 556, five: 556, six: 556, seven: 556, eight: 556, nine: 556,
  colon: 333, semicolon: 333, less: 584, equal: 584, greater: 584, question: 611, at: 975,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778,
  P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  bracketleft: 333, backslash: 278, bracketright: 333, asciicircum: 584, underscore: 556, grave: 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889, n: 611, o: 611,
  p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  braceleft: 389, bar: 280, braceright: 389, asciitilde: 584,
  Euro: 556, quotesinglbase: 278, florin: 556, quotedblbase: 500, ellipsis: 1000, dagger: 556, daggerdbl: 556,
  circumflex: 333, perthousand: 1000, Scaron: 667, guilsinglleft: 333, OE: 1000, Zcaron: 611,
  quoteleft: 278, quoteright: 278, quotedblleft: 500, quotedblright: 500, bullet: 350, endash: 556, emdash: 1000,
  tilde: 333, trademark: 1000, scaron: 556, guilsinglright: 333, oe: 944, zcaron: 500,
  exclamdown: 333, cent: 556, sterling: 556, currency: 556, yen: 556, brokenbar: 280, section: 556, dieresis: 333,
  copyright: 737, ordfeminine: 370, guillemotleft: 556, logicalnot: 584, registered: 737, macron: 333,
  degree: 400, plusminus: 584, twosuperior: 333, threesuperior: 333, acute: 333, mu: 611, paragraph: 556,
  periodcentered: 278, cedilla: 333, onesuperior: 333, ordmasculine: 365, guillemotright: 556,
  onequarter: 834, onehalf: 834, threequarters: 834, questiondown: 611, multiply: 584, divide: 584,
}, {
  A: 722, E: 667, I: 278, O: 778, U: 722, a: 556, e: 556, i: 278, o: 611, u: 611,
  Ccedilla: 722, ccedilla: 556, Ntilde: 722, ntilde: 611, Yacute: 667, yacute: 556,
  Eth: 722, eth: 611, Thorn: 667, thorn: 611, AE: 1000, ae: 889, Oslash: 778, oslash: 611,
  germandbls: 611, Ydieresis: 667, ydieresis: 556,
});

const TIMES_ROMAN_MAP: WMap = withAccents({
  space: 250, exclam: 333, quotedbl: 408, numbersign: 500, dollar: 500, percent: 833,
  ampersand: 778, quotesingle: 180, parenleft: 333, parenright: 333, asterisk: 500, plus: 564,
  comma: 250, hyphen: 333, period: 250, slash: 278,
  zero: 500, one: 500, two: 500, three: 500, four: 500, five: 500, six: 500, seven: 500, eight: 500, nine: 500,
  colon: 278, semicolon: 278, less: 564, equal: 564, greater: 564, question: 444, at: 921,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389, K: 722, L: 611, M: 889, N: 722, O: 722,
  P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
  bracketleft: 333, backslash: 278, bracketright: 333, asciicircum: 469, underscore: 500, grave: 333,
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500, l: 278, m: 778, n: 500, o: 500,
  p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500, w: 722, x: 500, y: 500, z: 444,
  braceleft: 480, bar: 200, braceright: 480, asciitilde: 541,
  Euro: 500, quotesinglbase: 333, florin: 500, quotedblbase: 444, ellipsis: 1000, dagger: 500, daggerdbl: 500,
  circumflex: 333, perthousand: 1000, Scaron: 556, guilsinglleft: 333, OE: 889, Zcaron: 611,
  quoteleft: 333, quoteright: 333, quotedblleft: 444, quotedblright: 444, bullet: 350, endash: 500, emdash: 1000,
  tilde: 333, trademark: 980, scaron: 389, guilsinglright: 333, oe: 722, zcaron: 444,
  exclamdown: 333, cent: 500, sterling: 500, currency: 500, yen: 500, brokenbar: 200, section: 500, dieresis: 333,
  copyright: 760, ordfeminine: 276, guillemotleft: 500, logicalnot: 564, registered: 760, macron: 333,
  degree: 400, plusminus: 564, twosuperior: 300, threesuperior: 300, acute: 333, mu: 500, paragraph: 453,
  periodcentered: 250, cedilla: 333, onesuperior: 300, ordmasculine: 310, guillemotright: 500,
  onequarter: 750, onehalf: 750, threequarters: 750, questiondown: 444, multiply: 564, divide: 564,
}, {
  A: 722, E: 611, I: 333, O: 722, U: 722, a: 444, e: 444, i: 278, o: 500, u: 500,
  Ccedilla: 667, ccedilla: 444, Ntilde: 722, ntilde: 500, Yacute: 722, yacute: 500,
  Eth: 722, eth: 500, Thorn: 556, thorn: 500, AE: 889, ae: 667, Oslash: 722, oslash: 500,
  germandbls: 500, Ydieresis: 722, ydieresis: 500,
});

const TIMES_BOLD_MAP: WMap = withAccents({
  space: 250, exclam: 333, quotedbl: 555, numbersign: 500, dollar: 500, percent: 1000,
  ampersand: 833, quotesingle: 278, parenleft: 333, parenright: 333, asterisk: 500, plus: 570,
  comma: 250, hyphen: 333, period: 250, slash: 278,
  zero: 500, one: 500, two: 500, three: 500, four: 500, five: 500, six: 500, seven: 500, eight: 500, nine: 500,
  colon: 333, semicolon: 333, less: 570, equal: 570, greater: 570, question: 500, at: 930,
  A: 722, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 778, I: 389, J: 500, K: 778, L: 667, M: 944, N: 722, O: 778,
  P: 611, Q: 778, R: 722, S: 556, T: 667, U: 722, V: 722, W: 1000, X: 722, Y: 722, Z: 667,
  bracketleft: 333, backslash: 278, bracketright: 333, asciicircum: 581, underscore: 500, grave: 333,
  a: 500, b: 556, c: 444, d: 556, e: 444, f: 333, g: 500, h: 556, i: 278, j: 333, k: 556, l: 278, m: 833, n: 556, o: 500,
  p: 556, q: 556, r: 444, s: 389, t: 333, u: 556, v: 500, w: 722, x: 500, y: 500, z: 444,
  braceleft: 394, bar: 220, braceright: 394, asciitilde: 520,
  Euro: 500, quotesinglbase: 333, florin: 500, quotedblbase: 500, ellipsis: 1000, dagger: 500, daggerdbl: 500,
  circumflex: 333, perthousand: 1000, Scaron: 556, guilsinglleft: 333, OE: 1000, Zcaron: 667,
  quoteleft: 333, quoteright: 333, quotedblleft: 500, quotedblright: 500, bullet: 350, endash: 500, emdash: 1000,
  tilde: 333, trademark: 1000, scaron: 389, guilsinglright: 333, oe: 722, zcaron: 444,
  exclamdown: 333, cent: 500, sterling: 500, currency: 500, yen: 500, brokenbar: 220, section: 500, dieresis: 333,
  copyright: 747, ordfeminine: 300, guillemotleft: 500, logicalnot: 570, registered: 747, macron: 333,
  degree: 400, plusminus: 570, twosuperior: 300, threesuperior: 300, acute: 333, mu: 556, paragraph: 540,
  periodcentered: 250, cedilla: 333, onesuperior: 300, ordmasculine: 330, guillemotright: 500,
  onequarter: 750, onehalf: 750, threequarters: 750, questiondown: 500, multiply: 570, divide: 570,
}, {
  A: 722, E: 667, I: 389, O: 778, U: 722, a: 500, e: 444, i: 278, o: 500, u: 556,
  Ccedilla: 722, ccedilla: 444, Ntilde: 722, ntilde: 556, Yacute: 722, yacute: 500,
  Eth: 722, eth: 500, Thorn: 611, thorn: 556, AE: 1000, ae: 722, Oslash: 778, oslash: 500,
  germandbls: 556, Ydieresis: 722, ydieresis: 500,
});

const TIMES_ITALIC_MAP: WMap = withAccents({
  space: 250, exclam: 333, quotedbl: 420, numbersign: 500, dollar: 500, percent: 833,
  ampersand: 778, quotesingle: 214, parenleft: 333, parenright: 333, asterisk: 500, plus: 675,
  comma: 250, hyphen: 333, period: 250, slash: 278,
  zero: 500, one: 500, two: 500, three: 500, four: 500, five: 500, six: 500, seven: 500, eight: 500, nine: 500,
  colon: 333, semicolon: 333, less: 675, equal: 675, greater: 675, question: 500, at: 920,
  A: 611, B: 611, C: 667, D: 722, E: 611, F: 611, G: 722, H: 722, I: 333, J: 444, K: 667, L: 556, M: 833, N: 667, O: 722,
  P: 611, Q: 722, R: 611, S: 500, T: 556, U: 722, V: 611, W: 833, X: 611, Y: 556, Z: 556,
  bracketleft: 389, backslash: 278, bracketright: 389, asciicircum: 422, underscore: 500, grave: 333,
  a: 500, b: 500, c: 444, d: 500, e: 444, f: 278, g: 500, h: 500, i: 278, j: 278, k: 444, l: 278, m: 722, n: 500, o: 500,
  p: 500, q: 500, r: 389, s: 389, t: 278, u: 500, v: 444, w: 667, x: 444, y: 444, z: 389,
  braceleft: 400, bar: 275, braceright: 400, asciitilde: 541,
  Euro: 500, quotesinglbase: 333, florin: 500, quotedblbase: 556, ellipsis: 889, dagger: 500, daggerdbl: 500,
  circumflex: 333, perthousand: 1000, Scaron: 500, guilsinglleft: 333, OE: 944, Zcaron: 556,
  quoteleft: 333, quoteright: 333, quotedblleft: 556, quotedblright: 556, bullet: 350, endash: 500, emdash: 889,
  tilde: 333, trademark: 980, scaron: 389, guilsinglright: 333, oe: 667, zcaron: 389,
  exclamdown: 389, cent: 500, sterling: 500, currency: 500, yen: 500, brokenbar: 275, section: 500, dieresis: 333,
  copyright: 760, ordfeminine: 276, guillemotleft: 500, logicalnot: 675, registered: 760, macron: 333,
  degree: 400, plusminus: 675, twosuperior: 300, threesuperior: 300, acute: 333, mu: 500, paragraph: 523,
  periodcentered: 250, cedilla: 333, onesuperior: 300, ordmasculine: 310, guillemotright: 500,
  onequarter: 750, onehalf: 750, threequarters: 750, questiondown: 500, multiply: 675, divide: 675,
}, {
  A: 611, E: 611, I: 333, O: 722, U: 722, a: 500, e: 444, i: 278, o: 500, u: 500,
  Ccedilla: 667, ccedilla: 444, Ntilde: 667, ntilde: 500, Yacute: 556, yacute: 444,
  Eth: 722, eth: 500, Thorn: 611, thorn: 500, AE: 889, ae: 667, Oslash: 722, oslash: 500,
  germandbls: 500, Ydieresis: 556, ydieresis: 444,
});

const TIMES_BOLDITALIC_MAP: WMap = withAccents({
  space: 250, exclam: 389, quotedbl: 555, numbersign: 500, dollar: 500, percent: 833,
  ampersand: 778, quotesingle: 278, parenleft: 333, parenright: 333, asterisk: 500, plus: 570,
  comma: 250, hyphen: 333, period: 250, slash: 278,
  zero: 500, one: 500, two: 500, three: 500, four: 500, five: 500, six: 500, seven: 500, eight: 500, nine: 500,
  colon: 333, semicolon: 333, less: 570, equal: 570, greater: 570, question: 500, at: 832,
  A: 667, B: 667, C: 667, D: 722, E: 667, F: 667, G: 722, H: 778, I: 389, J: 500, K: 667, L: 611, M: 889, N: 722, O: 722,
  P: 611, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 667, W: 889, X: 667, Y: 611, Z: 611,
  bracketleft: 333, backslash: 278, bracketright: 333, asciicircum: 570, underscore: 500, grave: 333,
  a: 500, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 556, i: 278, j: 278, k: 500, l: 278, m: 778, n: 556, o: 500,
  p: 500, q: 500, r: 389, s: 389, t: 278, u: 556, v: 444, w: 667, x: 500, y: 444, z: 389,
  braceleft: 348, bar: 220, braceright: 348, asciitilde: 570,
  Euro: 500, quotesinglbase: 333, florin: 500, quotedblbase: 500, ellipsis: 1000, dagger: 500, daggerdbl: 500,
  circumflex: 333, perthousand: 1000, Scaron: 556, guilsinglleft: 333, OE: 944, Zcaron: 611,
  quoteleft: 333, quoteright: 333, quotedblleft: 500, quotedblright: 500, bullet: 350, endash: 500, emdash: 1000,
  tilde: 333, trademark: 1000, scaron: 389, guilsinglright: 333, oe: 722, zcaron: 389,
  exclamdown: 389, cent: 500, sterling: 500, currency: 500, yen: 500, brokenbar: 220, section: 500, dieresis: 333,
  copyright: 747, ordfeminine: 266, guillemotleft: 500, logicalnot: 606, registered: 747, macron: 333,
  degree: 400, plusminus: 570, twosuperior: 300, threesuperior: 300, acute: 333, mu: 576, paragraph: 500,
  periodcentered: 250, cedilla: 333, onesuperior: 300, ordmasculine: 300, guillemotright: 500,
  onequarter: 750, onehalf: 750, threequarters: 750, questiondown: 500, multiply: 570, divide: 570,
}, {
  A: 667, E: 667, I: 389, O: 722, U: 722, a: 500, e: 444, i: 278, o: 500, u: 556,
  Ccedilla: 667, ccedilla: 444, Ntilde: 722, ntilde: 556, Yacute: 611, yacute: 444,
  Eth: 722, eth: 500, Thorn: 611, thorn: 500, AE: 944, ae: 722, Oslash: 722, oslash: 500,
  germandbls: 500, Ydieresis: 611, ydieresis: 444,
});

// Courier and its variants are monospaced: every WinAnsi code that has a glyph
// in Helvetica advances 600; non-glyph slots stay 0.
const COURIER_WIDTHS: readonly number[] = HELVETICA_WIDTHS.map((w) => (w === 0 ? 0 : 600));

const HELVETICA_BOLD_WIDTHS = mkWidths(HELVETICA_BOLD_MAP);
const TIMES_ROMAN_WIDTHS = mkWidths(TIMES_ROMAN_MAP);
const TIMES_BOLD_WIDTHS = mkWidths(TIMES_BOLD_MAP);
const TIMES_ITALIC_WIDTHS = mkWidths(TIMES_ITALIC_MAP);
const TIMES_BOLDITALIC_WIDTHS = mkWidths(TIMES_BOLDITALIC_MAP);

// Symbol and ZapfDingbats use their own built-in encodings, so their advance
// tables are indexed directly by the byte code (no shared WinAnsi name table).
// Both are transcribed from the Adobe AFM files as [code, WX] pairs; codes with
// no glyph (the 0x7F..0xA0 range and 0xF0) stay 0.
function mkCodeWidths(pairs: ReadonlyArray<readonly [number, number]>): number[] {
  const out = new Array(256).fill(0);
  for (const [c, w] of pairs) out[c] = w;
  return out;
}

// Adobe Symbol.afm advance widths, indexed by Symbol's built-in encoding code.
const SYMBOL_WIDTHS: readonly number[] = mkCodeWidths([
  [32, 250], [33, 333], [34, 713], [35, 500], [36, 549], [37, 833], [38, 778], [39, 439],
  [40, 333], [41, 333], [42, 500], [43, 549], [44, 250], [45, 549], [46, 250], [47, 278],
  [48, 500], [49, 500], [50, 500], [51, 500], [52, 500], [53, 500], [54, 500], [55, 500],
  [56, 500], [57, 500], [58, 278], [59, 278], [60, 549], [61, 549], [62, 549], [63, 444],
  [64, 549], [65, 722], [66, 667], [67, 722], [68, 612], [69, 611], [70, 763], [71, 603],
  [72, 722], [73, 333], [74, 631], [75, 722], [76, 686], [77, 889], [78, 722], [79, 722],
  [80, 768], [81, 741], [82, 556], [83, 592], [84, 611], [85, 690], [86, 439], [87, 768],
  [88, 645], [89, 795], [90, 611], [91, 333], [92, 863], [93, 333], [94, 658], [95, 500],
  [96, 500], [97, 631], [98, 549], [99, 549], [100, 494], [101, 439], [102, 521], [103, 411],
  [104, 603], [105, 329], [106, 603], [107, 549], [108, 549], [109, 576], [110, 521], [111, 549],
  [112, 549], [113, 521], [114, 549], [115, 603], [116, 439], [117, 576], [118, 713], [119, 686],
  [120, 493], [121, 686], [122, 494], [123, 480], [124, 200], [125, 480], [126, 549],
  [161, 620], [162, 247], [163, 549], [164, 167], [165, 713], [166, 500], [167, 753], [168, 753],
  [169, 753], [170, 753], [171, 1042], [172, 987], [173, 603], [174, 987], [175, 603], [176, 400],
  [177, 549], [178, 411], [179, 549], [180, 549], [181, 713], [182, 494], [183, 460], [184, 549],
  [185, 549], [186, 549], [187, 549], [188, 1000], [189, 603], [190, 1000], [191, 658], [192, 823],
  [193, 686], [194, 795], [195, 987], [196, 768], [197, 768], [198, 823], [199, 768], [200, 768],
  [201, 713], [202, 713], [203, 713], [204, 713], [205, 713], [206, 713], [207, 713], [208, 768],
  [209, 713], [210, 790], [211, 790], [212, 890], [213, 823], [214, 549], [215, 250], [216, 713],
  [217, 603], [218, 603], [219, 1042], [220, 987], [221, 603], [222, 987], [223, 603], [224, 494],
  [225, 329], [226, 790], [227, 790], [228, 786], [229, 713], [230, 384], [231, 384], [232, 384],
  [233, 384], [234, 384], [235, 384], [236, 494], [237, 494], [238, 494], [239, 494],
  [241, 790], [242, 384], [243, 384], [244, 384], [245, 384], [246, 384], [247, 384], [248, 384],
  [249, 384], [250, 384], [251, 384], [252, 494], [253, 494], [254, 494],
]);

// Adobe ZapfDingbats.afm advance widths, indexed by its built-in encoding code.
const ZAPF_WIDTHS: readonly number[] = mkCodeWidths([
  [32, 278], [33, 974], [34, 961], [35, 974], [36, 980], [37, 719], [38, 789], [39, 790],
  [40, 791], [41, 690], [42, 960], [43, 939], [44, 549], [45, 855], [46, 911], [47, 933],
  [48, 911], [49, 945], [50, 974], [51, 755], [52, 846], [53, 762], [54, 761], [55, 571],
  [56, 677], [57, 763], [58, 760], [59, 759], [60, 754], [61, 494], [62, 552], [63, 537],
  [64, 577], [65, 692], [66, 786], [67, 788], [68, 788], [69, 790], [70, 793], [71, 794],
  [72, 816], [73, 823], [74, 789], [75, 841], [76, 823], [77, 833], [78, 816], [79, 831],
  [80, 923], [81, 744], [82, 723], [83, 749], [84, 790], [85, 792], [86, 695], [87, 776],
  [88, 768], [89, 792], [90, 759], [91, 707], [92, 708], [93, 682], [94, 701], [95, 826],
  [96, 815], [97, 789], [98, 789], [99, 707], [100, 687], [101, 696], [102, 689], [103, 786],
  [104, 787], [105, 713], [106, 791], [107, 785], [108, 791], [109, 873], [110, 761], [111, 762],
  [112, 762], [113, 759], [114, 759], [115, 892], [116, 892], [117, 788], [118, 784], [119, 438],
  [120, 138], [121, 277], [122, 415], [123, 392], [124, 392], [125, 668], [126, 668],
  [161, 732], [162, 544], [163, 544], [164, 910], [165, 667], [166, 760], [167, 760], [168, 776],
  [169, 595], [170, 694], [171, 626], [172, 788], [173, 788], [174, 788], [175, 788], [176, 788],
  [177, 788], [178, 788], [179, 788], [180, 788], [181, 788], [182, 788], [183, 788], [184, 788],
  [185, 788], [186, 788], [187, 788], [188, 788], [189, 788], [190, 788], [191, 788], [192, 788],
  [193, 788], [194, 788], [195, 788], [196, 788], [197, 788], [198, 788], [199, 788], [200, 788],
  [201, 788], [202, 788], [203, 788], [204, 788], [205, 788], [206, 788], [207, 788], [208, 788],
  [209, 788], [210, 788], [211, 788], [212, 894], [213, 838], [214, 1016], [215, 458], [216, 748],
  [217, 924], [218, 748], [219, 918], [220, 927], [221, 928], [222, 928], [223, 834], [224, 873],
  [225, 828], [226, 924], [227, 924], [228, 917], [229, 930], [230, 931], [231, 463], [232, 883],
  [233, 836], [234, 836], [235, 867], [236, 867], [237, 696], [238, 696], [239, 874],
  [241, 874], [242, 760], [243, 946], [244, 771], [245, 865], [246, 771], [247, 888], [248, 967],
  [249, 888], [250, 831], [251, 873], [252, 927], [253, 970], [254, 918],
]);

const WIDTHS: Record<StdFont, readonly number[]> = {
  'Helvetica': HELVETICA_WIDTHS,
  'Helvetica-Bold': HELVETICA_BOLD_WIDTHS,
  'Helvetica-Oblique': HELVETICA_WIDTHS,
  'Helvetica-BoldOblique': HELVETICA_BOLD_WIDTHS,
  'Times-Roman': TIMES_ROMAN_WIDTHS,
  'Times-Bold': TIMES_BOLD_WIDTHS,
  'Times-Italic': TIMES_ITALIC_WIDTHS,
  'Times-BoldItalic': TIMES_BOLDITALIC_WIDTHS,
  'Courier': COURIER_WIDTHS,
  'Courier-Bold': COURIER_WIDTHS,
  'Courier-Oblique': COURIER_WIDTHS,
  'Courier-BoldOblique': COURIER_WIDTHS,
  'Symbol': SYMBOL_WIDTHS,
  'ZapfDingbats': ZAPF_WIDTHS,
};

// Abbreviated /DA font names (as Acrobat writes them) -> StdFont.
const ABBREV: Record<string, StdFont> = {
  Helv: 'Helvetica', HeBo: 'Helvetica-Bold', HeOb: 'Helvetica-Oblique', HeBO: 'Helvetica-BoldOblique',
  Cour: 'Courier', CoBo: 'Courier-Bold', CoOb: 'Courier-Oblique', CoBO: 'Courier-BoldOblique',
  TiRo: 'Times-Roman', TiBo: 'Times-Bold', TiIt: 'Times-Italic', TiBI: 'Times-BoldItalic',
  Symb: 'Symbol', ZaDb: 'ZapfDingbats',
};

const STD: readonly StdFont[] = Object.keys(WIDTHS) as StdFont[];

/** Map a /BaseFont or /DA font name (incl. subset prefixes and Acrobat
 *  abbreviations) to a Standard-14 font, defaulting to Helvetica. */
export function normalizeFont(baseFont: string): StdFont {
  const raw = baseFont.includes('+') ? baseFont.slice(baseFont.indexOf('+') + 1) : baseFont;
  if (raw in ABBREV) return ABBREV[raw];
  for (const f of STD) if (f === raw) return f;
  if (raw === 'Arial') return 'Helvetica';
  if (raw === 'Arial-Bold' || raw === 'Arial,Bold' || raw === 'Arial-BoldMT') return 'Helvetica-Bold';
  if (raw === 'Times' || raw === 'TimesNewRoman' || raw === 'TimesNewRomanPSMT') return 'Times-Roman';
  if (raw === 'CourierNew' || raw === 'CourierNewPSMT') return 'Courier';
  return 'Helvetica';
}

/** Advance width (1000-unit em) of a byte `code` in `font`; 0 if no glyph. */
export function glyphWidth(font: StdFont, code: number): number {
  return WIDTHS[font][code] ?? 0;
}

/** Width of `font`-encoded `bytes` in points at `fontSize`. */
export function measure(font: StdFont, bytes: Uint8Array, fontSize: number): number {
  let units = 0;
  for (const b of bytes) units += WIDTHS[font][b] ?? 0;
  return (units / 1000) * fontSize;
}

/** Width of WinAnsi-encoded `bytes` in points at `fontSize` (Helvetica). */
export function measureWinAnsi(bytes: Uint8Array, fontSize: number): number {
  return measure('Helvetica', bytes, fontSize);
}
