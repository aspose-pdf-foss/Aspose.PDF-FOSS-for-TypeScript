// Base text encodings (code 0..255 -> Unicode string) and a glyph-name resolver.
// Tables for the high range of MacRoman/Standard are transcribed from
// ISO 32000-1:2008 Annex D, Table D.2.

/** Curated Adobe-glyph-name -> Unicode codepoint map (Latin set + common symbols).
 *  Sufficient for /Differences arrays seen in real PDFs; extend as needed. */
const GLYPH_NAMES: Record<string, number> = {
  fi: 0xfb01, fl: 0xfb02, Lslash: 0x141, lslash: 0x142, minus: 0x2212,
  Alpha: 0x391, Beta: 0x392, Gamma: 0x393, Delta: 0x2206, Epsilon: 0x395,
  Zeta: 0x396, Eta: 0x397, Theta: 0x398, Iota: 0x399, Kappa: 0x39a,
  Lambda: 0x39b, Mu: 0x39c, Nu: 0x39d, Xi: 0x39e, Omicron: 0x39f,
  Pi: 0x3a0, Rho: 0x3a1, Sigma: 0x3a3, Tau: 0x3a4, Upsilon: 0x3a5,
  Phi: 0x3a6, Chi: 0x3a7, Psi: 0x3a8, Omega: 0x2126,
  alpha: 0x3b1, beta: 0x3b2, gamma: 0x3b3, delta: 0x3b4, epsilon: 0x3b5,
  zeta: 0x3b6, eta: 0x3b7, theta: 0x3b8, iota: 0x3b9, kappa: 0x3ba,
  lambda: 0x3bb, nu: 0x3bd, xi: 0x3be, omicron: 0x3bf, pi: 0x3c0,
  rho: 0x3c1, sigma: 0x3c3, tau: 0x3c4, upsilon: 0x3c5, phi: 0x3c6,
  chi: 0x3c7, psi: 0x3c8, omega: 0x3c9,
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

// Adobe Glyph List 2.0 / ITC Zapf Dingbats 2.0 subset for our name vectors.
// Copyright 2002-2019 Adobe; license and provenance: THIRD-PARTY-NOTICES.md.
const STANDARD_GLYPH_UNICODE: Record<string, string> = {
  "A": "A",
  "AE": "Æ",
  "Aacute": "Á",
  "Acircumflex": "Â",
  "Adieresis": "Ä",
  "Agrave": "À",
  "Alpha": "Α",
  "Aring": "Å",
  "Atilde": "Ã",
  "B": "B",
  "Beta": "Β",
  "C": "C",
  "Ccedilla": "Ç",
  "Chi": "Χ",
  "D": "D",
  "Delta": "∆",
  "E": "E",
  "Eacute": "É",
  "Ecircumflex": "Ê",
  "Edieresis": "Ë",
  "Egrave": "È",
  "Epsilon": "Ε",
  "Eta": "Η",
  "Eth": "Ð",
  "Euro": "€",
  "F": "F",
  "G": "G",
  "Gamma": "Γ",
  "H": "H",
  "I": "I",
  "Iacute": "Í",
  "Icircumflex": "Î",
  "Idieresis": "Ï",
  "Ifraktur": "ℑ",
  "Igrave": "Ì",
  "Iota": "Ι",
  "J": "J",
  "K": "K",
  "Kappa": "Κ",
  "L": "L",
  "Lambda": "Λ",
  "Lslash": "Ł",
  "M": "M",
  "Mu": "Μ",
  "N": "N",
  "Ntilde": "Ñ",
  "Nu": "Ν",
  "O": "O",
  "OE": "Œ",
  "Oacute": "Ó",
  "Ocircumflex": "Ô",
  "Odieresis": "Ö",
  "Ograve": "Ò",
  "Omega": "Ω",
  "Omicron": "Ο",
  "Oslash": "Ø",
  "Otilde": "Õ",
  "P": "P",
  "Phi": "Φ",
  "Pi": "Π",
  "Psi": "Ψ",
  "Q": "Q",
  "R": "R",
  "Rfraktur": "ℜ",
  "Rho": "Ρ",
  "S": "S",
  "Scaron": "Š",
  "Sigma": "Σ",
  "T": "T",
  "Tau": "Τ",
  "Theta": "Θ",
  "Thorn": "Þ",
  "U": "U",
  "Uacute": "Ú",
  "Ucircumflex": "Û",
  "Udieresis": "Ü",
  "Ugrave": "Ù",
  "Upsilon": "Υ",
  "Upsilon1": "ϒ",
  "V": "V",
  "W": "W",
  "X": "X",
  "Xi": "Ξ",
  "Y": "Y",
  "Yacute": "Ý",
  "Ydieresis": "Ÿ",
  "Z": "Z",
  "Zcaron": "Ž",
  "Zeta": "Ζ",
  "a": "a",
  "a1": "✁",
  "a10": "✡",
  "a100": "❞",
  "a101": "❡",
  "a102": "❢",
  "a103": "❣",
  "a104": "❤",
  "a105": "✐",
  "a106": "❥",
  "a107": "❦",
  "a108": "❧",
  "a109": "♠",
  "a11": "☛",
  "a110": "♥",
  "a111": "♦",
  "a112": "♣",
  "a117": "✉",
  "a118": "✈",
  "a119": "✇",
  "a12": "☞",
  "a120": "①",
  "a121": "②",
  "a122": "③",
  "a123": "④",
  "a124": "⑤",
  "a125": "⑥",
  "a126": "⑦",
  "a127": "⑧",
  "a128": "⑨",
  "a129": "⑩",
  "a13": "✌",
  "a130": "❶",
  "a131": "❷",
  "a132": "❸",
  "a133": "❹",
  "a134": "❺",
  "a135": "❻",
  "a136": "❼",
  "a137": "❽",
  "a138": "❾",
  "a139": "❿",
  "a14": "✍",
  "a140": "➀",
  "a141": "➁",
  "a142": "➂",
  "a143": "➃",
  "a144": "➄",
  "a145": "➅",
  "a146": "➆",
  "a147": "➇",
  "a148": "➈",
  "a149": "➉",
  "a15": "✎",
  "a150": "➊",
  "a151": "➋",
  "a152": "➌",
  "a153": "➍",
  "a154": "➎",
  "a155": "➏",
  "a156": "➐",
  "a157": "➑",
  "a158": "➒",
  "a159": "➓",
  "a16": "✏",
  "a160": "➔",
  "a161": "→",
  "a162": "➣",
  "a163": "↔",
  "a164": "↕",
  "a165": "➙",
  "a166": "➛",
  "a167": "➜",
  "a168": "➝",
  "a169": "➞",
  "a17": "✑",
  "a170": "➟",
  "a171": "➠",
  "a172": "➡",
  "a173": "➢",
  "a174": "➤",
  "a175": "➥",
  "a176": "➦",
  "a177": "➧",
  "a178": "➨",
  "a179": "➩",
  "a18": "✒",
  "a180": "➫",
  "a181": "➭",
  "a182": "➯",
  "a183": "➲",
  "a184": "➳",
  "a185": "➵",
  "a186": "➸",
  "a187": "➺",
  "a188": "➻",
  "a189": "➼",
  "a19": "✓",
  "a190": "➽",
  "a191": "➾",
  "a192": "➚",
  "a193": "➪",
  "a194": "➶",
  "a195": "➹",
  "a196": "➘",
  "a197": "➴",
  "a198": "➷",
  "a199": "➬",
  "a2": "✂",
  "a20": "✔",
  "a200": "➮",
  "a201": "➱",
  "a202": "✃",
  "a203": "❐",
  "a204": "❒",
  "a205": "❮",
  "a206": "❰",
  "a21": "✕",
  "a22": "✖",
  "a23": "✗",
  "a24": "✘",
  "a25": "✙",
  "a26": "✚",
  "a27": "✛",
  "a28": "✜",
  "a29": "✢",
  "a3": "✄",
  "a30": "✣",
  "a31": "✤",
  "a32": "✥",
  "a33": "✦",
  "a34": "✧",
  "a35": "★",
  "a36": "✩",
  "a37": "✪",
  "a38": "✫",
  "a39": "✬",
  "a4": "☎",
  "a40": "✭",
  "a41": "✮",
  "a42": "✯",
  "a43": "✰",
  "a44": "✱",
  "a45": "✲",
  "a46": "✳",
  "a47": "✴",
  "a48": "✵",
  "a49": "✶",
  "a5": "✆",
  "a50": "✷",
  "a51": "✸",
  "a52": "✹",
  "a53": "✺",
  "a54": "✻",
  "a55": "✼",
  "a56": "✽",
  "a57": "✾",
  "a58": "✿",
  "a59": "❀",
  "a6": "✝",
  "a60": "❁",
  "a61": "❂",
  "a62": "❃",
  "a63": "❄",
  "a64": "❅",
  "a65": "❆",
  "a66": "❇",
  "a67": "❈",
  "a68": "❉",
  "a69": "❊",
  "a7": "✞",
  "a70": "❋",
  "a71": "●",
  "a72": "❍",
  "a73": "■",
  "a74": "❏",
  "a75": "❑",
  "a76": "▲",
  "a77": "▼",
  "a78": "◆",
  "a79": "❖",
  "a8": "✟",
  "a81": "◗",
  "a82": "❘",
  "a83": "❙",
  "a84": "❚",
  "a85": "❯",
  "a86": "❱",
  "a87": "❲",
  "a88": "❳",
  "a89": "❨",
  "a9": "✠",
  "a90": "❩",
  "a91": "❬",
  "a92": "❭",
  "a93": "❪",
  "a94": "❫",
  "a95": "❴",
  "a96": "❵",
  "a97": "❛",
  "a98": "❜",
  "a99": "❝",
  "aacute": "á",
  "acircumflex": "â",
  "acute": "´",
  "adieresis": "ä",
  "ae": "æ",
  "agrave": "à",
  "aleph": "ℵ",
  "alpha": "α",
  "ampersand": "&",
  "angle": "∠",
  "angleleft": "〈",
  "angleright": "〉",
  "apple": "",
  "approxequal": "≈",
  "aring": "å",
  "arrowboth": "↔",
  "arrowdblboth": "⇔",
  "arrowdbldown": "⇓",
  "arrowdblleft": "⇐",
  "arrowdblright": "⇒",
  "arrowdblup": "⇑",
  "arrowdown": "↓",
  "arrowhorizex": "",
  "arrowleft": "←",
  "arrowright": "→",
  "arrowup": "↑",
  "arrowvertex": "",
  "asciicircum": "^",
  "asciitilde": "~",
  "asterisk": "*",
  "asteriskmath": "∗",
  "at": "@",
  "atilde": "ã",
  "b": "b",
  "backslash": "\\",
  "bar": "|",
  "beta": "β",
  "braceex": "",
  "braceleft": "{",
  "braceleftbt": "",
  "braceleftmid": "",
  "bracelefttp": "",
  "braceright": "}",
  "bracerightbt": "",
  "bracerightmid": "",
  "bracerighttp": "",
  "bracketleft": "[",
  "bracketleftbt": "",
  "bracketleftex": "",
  "bracketlefttp": "",
  "bracketright": "]",
  "bracketrightbt": "",
  "bracketrightex": "",
  "bracketrighttp": "",
  "breve": "˘",
  "brokenbar": "¦",
  "bullet": "•",
  "c": "c",
  "caron": "ˇ",
  "carriagereturn": "↵",
  "ccedilla": "ç",
  "cedilla": "¸",
  "cent": "¢",
  "chi": "χ",
  "circlemultiply": "⊗",
  "circleplus": "⊕",
  "circumflex": "ˆ",
  "club": "♣",
  "colon": ":",
  "comma": ",",
  "congruent": "≅",
  "copyright": "©",
  "copyrightsans": "",
  "copyrightserif": "",
  "currency": "¤",
  "d": "d",
  "dagger": "†",
  "daggerdbl": "‡",
  "degree": "°",
  "delta": "δ",
  "diamond": "♦",
  "dieresis": "¨",
  "divide": "÷",
  "dollar": "$",
  "dotaccent": "˙",
  "dotlessi": "ı",
  "dotmath": "⋅",
  "e": "e",
  "eacute": "é",
  "ecircumflex": "ê",
  "edieresis": "ë",
  "egrave": "è",
  "eight": "8",
  "element": "∈",
  "ellipsis": "…",
  "emdash": "—",
  "emptyset": "∅",
  "endash": "–",
  "epsilon": "ε",
  "equal": "=",
  "equivalence": "≡",
  "eta": "η",
  "eth": "ð",
  "exclam": "!",
  "exclamdown": "¡",
  "existential": "∃",
  "f": "f",
  "fi": "ﬁ",
  "five": "5",
  "fl": "ﬂ",
  "florin": "ƒ",
  "four": "4",
  "fraction": "⁄",
  "g": "g",
  "gamma": "γ",
  "germandbls": "ß",
  "gradient": "∇",
  "grave": "`",
  "greater": ">",
  "greaterequal": "≥",
  "guillemotleft": "«",
  "guillemotright": "»",
  "guilsinglleft": "‹",
  "guilsinglright": "›",
  "h": "h",
  "heart": "♥",
  "hungarumlaut": "˝",
  "hyphen": "-",
  "i": "i",
  "iacute": "í",
  "icircumflex": "î",
  "idieresis": "ï",
  "igrave": "ì",
  "infinity": "∞",
  "integral": "∫",
  "integralbt": "⌡",
  "integralex": "",
  "integraltp": "⌠",
  "intersection": "∩",
  "iota": "ι",
  "j": "j",
  "k": "k",
  "kappa": "κ",
  "l": "l",
  "lambda": "λ",
  "less": "<",
  "lessequal": "≤",
  "logicaland": "∧",
  "logicalnot": "¬",
  "logicalor": "∨",
  "lozenge": "◊",
  "lslash": "ł",
  "m": "m",
  "macron": "¯",
  "minus": "−",
  "minute": "′",
  "mu": "µ",
  "multiply": "×",
  "n": "n",
  "nine": "9",
  "notelement": "∉",
  "notequal": "≠",
  "notsubset": "⊄",
  "ntilde": "ñ",
  "nu": "ν",
  "numbersign": "#",
  "o": "o",
  "oacute": "ó",
  "ocircumflex": "ô",
  "odieresis": "ö",
  "oe": "œ",
  "ogonek": "˛",
  "ograve": "ò",
  "omega": "ω",
  "omega1": "ϖ",
  "omicron": "ο",
  "one": "1",
  "onehalf": "½",
  "onequarter": "¼",
  "onesuperior": "¹",
  "ordfeminine": "ª",
  "ordmasculine": "º",
  "oslash": "ø",
  "otilde": "õ",
  "p": "p",
  "paragraph": "¶",
  "parenleft": "(",
  "parenleftbt": "",
  "parenleftex": "",
  "parenlefttp": "",
  "parenright": ")",
  "parenrightbt": "",
  "parenrightex": "",
  "parenrighttp": "",
  "partialdiff": "∂",
  "percent": "%",
  "period": ".",
  "periodcentered": "·",
  "perpendicular": "⊥",
  "perthousand": "‰",
  "phi": "φ",
  "phi1": "ϕ",
  "pi": "π",
  "plus": "+",
  "plusminus": "±",
  "product": "∏",
  "propersubset": "⊂",
  "propersuperset": "⊃",
  "proportional": "∝",
  "psi": "ψ",
  "q": "q",
  "question": "?",
  "questiondown": "¿",
  "quotedbl": "\"",
  "quotedblbase": "„",
  "quotedblleft": "“",
  "quotedblright": "”",
  "quoteleft": "‘",
  "quoteright": "’",
  "quotesinglbase": "‚",
  "quotesingle": "'",
  "r": "r",
  "radical": "√",
  "radicalex": "",
  "reflexsubset": "⊆",
  "reflexsuperset": "⊇",
  "registered": "®",
  "registersans": "",
  "registerserif": "",
  "rho": "ρ",
  "ring": "˚",
  "s": "s",
  "scaron": "š",
  "second": "″",
  "section": "§",
  "semicolon": ";",
  "seven": "7",
  "sigma": "σ",
  "sigma1": "ς",
  "similar": "∼",
  "six": "6",
  "slash": "/",
  "space": " ",
  "spade": "♠",
  "sterling": "£",
  "suchthat": "∋",
  "summation": "∑",
  "t": "t",
  "tau": "τ",
  "therefore": "∴",
  "theta": "θ",
  "theta1": "ϑ",
  "thorn": "þ",
  "three": "3",
  "threequarters": "¾",
  "threesuperior": "³",
  "tilde": "˜",
  "trademark": "™",
  "trademarksans": "",
  "trademarkserif": "",
  "two": "2",
  "twosuperior": "²",
  "u": "u",
  "uacute": "ú",
  "ucircumflex": "û",
  "udieresis": "ü",
  "ugrave": "ù",
  "underscore": "_",
  "union": "∪",
  "universal": "∀",
  "upsilon": "υ",
  "v": "v",
  "w": "w",
  "weierstrass": "℘",
  "x": "x",
  "xi": "ξ",
  "y": "y",
  "yacute": "ý",
  "ydieresis": "ÿ",
  "yen": "¥",
  "z": "z",
  "zcaron": "ž",
  "zero": "0",
  "zeta": "ζ",
};

/** Resolve an Adobe glyph name to a Unicode string, or undefined. */
export function glyphToUnicode(name: string): string | undefined {
  const cp = Object.hasOwn(NAME_TO_CP, name) ? NAME_TO_CP[name] : undefined;
  if (cp !== undefined) return String.fromCodePoint(cp);
  if (Object.hasOwn(STANDARD_GLYPH_UNICODE, name)) return STANDARD_GLYPH_UNICODE[name];
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

/** Built-in name vector from fonts/StandardSymbolsPS.ttf (see fonts/SOURCES.md). */
export const symbolEncodingNames: readonly string[] = [
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  "space", "exclam", "universal", "numbersign", "existential", "percent", "ampersand", "suchthat",
  "parenleft", "parenright", "asteriskmath", "plus", "comma", "minus", "period", "slash",
  "zero", "one", "two", "three", "four", "five", "six", "seven",
  "eight", "nine", "colon", "semicolon", "less", "equal", "greater", "question",
  "congruent", "Alpha", "Beta", "Chi", "Delta", "Epsilon", "Phi", "Gamma",
  "Eta", "Iota", "theta1", "Kappa", "Lambda", "Mu", "Nu", "Omicron",
  "Pi", "Theta", "Rho", "Sigma", "Tau", "Upsilon", "sigma1", "Omega",
  "Xi", "Psi", "Zeta", "bracketleft", "therefore", "bracketright", "perpendicular", "underscore",
  "radicalex", "alpha", "beta", "chi", "delta", "epsilon", "phi", "gamma",
  "eta", "iota", "phi1", "kappa", "lambda", "mu", "nu", "omicron",
  "pi", "theta", "rho", "sigma", "tau", "upsilon", "omega1", "omega",
  "xi", "psi", "zeta", "braceleft", "bar", "braceright", "similar", ".notdef",
  "apple", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  "Euro", "Upsilon1", "minute", "lessequal", "fraction", "infinity", "florin", "club",
  "diamond", "heart", "spade", "arrowboth", "arrowleft", "arrowup", "arrowright", "arrowdown",
  "degree", "plusminus", "second", "greaterequal", "multiply", "proportional", "partialdiff", "bullet",
  "divide", "notequal", "equivalence", "approxequal", "ellipsis", "arrowvertex", "arrowhorizex", "carriagereturn",
  "aleph", "Ifraktur", "Rfraktur", "weierstrass", "circlemultiply", "circleplus", "emptyset", "intersection",
  "union", "propersuperset", "reflexsuperset", "notsubset", "propersubset", "reflexsubset", "element", "notelement",
  "angle", "gradient", "registerserif", "copyrightserif", "trademarkserif", "product", "radical", "dotmath",
  "logicalnot", "logicaland", "logicalor", "arrowdblboth", "arrowdblleft", "arrowdblup", "arrowdblright", "arrowdbldown",
  "lozenge", "angleleft", "registersans", "copyrightsans", "trademarksans", "summation", "parenlefttp", "parenleftex",
  "parenleftbt", "bracketlefttp", "bracketleftex", "bracketleftbt", "bracelefttp", "braceleftmid", "braceleftbt", "braceex",
  ".notdef", "angleright", "integral", "integraltp", "integralex", "integralbt", "parenrighttp", "parenrightex",
  "parenrightbt", "bracketrighttp", "bracketrightex", "bracketrightbt", "bracerighttp", "bracerightmid", "bracerightbt", ".notdef",
];

/** Built-in name vector from fonts/D050000L.ttf (see fonts/SOURCES.md). */
export const dingbatsEncodingNames: readonly string[] = [
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  "space", "a1", "a2", "a202", "a3", "a4", "a5", "a119",
  "a118", "a117", "a11", "a12", "a13", "a14", "a15", "a16",
  "a105", "a17", "a18", "a19", "a20", "a21", "a22", "a23",
  "a24", "a25", "a26", "a27", "a28", "a6", "a7", "a8",
  "a9", "a10", "a29", "a30", "a31", "a32", "a33", "a34",
  "a35", "a36", "a37", "a38", "a39", "a40", "a41", "a42",
  "a43", "a44", "a45", "a46", "a47", "a48", "a49", "a50",
  "a51", "a52", "a53", "a54", "a55", "a56", "a57", "a58",
  "a59", "a60", "a61", "a62", "a63", "a64", "a65", "a66",
  "a67", "a68", "a69", "a70", "a71", "a72", "a73", "a74",
  "a203", "a75", "a204", "a76", "a77", "a78", "a79", "a81",
  "a82", "a83", "a84", "a97", "a98", "a99", "a100", ".notdef",
  "a89", "a90", "a93", "a94", "a91", "a92", "a205", "a85",
  "a206", "a86", "a87", "a88", "a95", "a96", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef", ".notdef",
  ".notdef", "a101", "a102", "a103", "a104", "a106", "a107", "a108",
  "a112", "a111", "a110", "a109", "a120", "a121", "a122", "a123",
  "a124", "a125", "a126", "a127", "a128", "a129", "a130", "a131",
  "a132", "a133", "a134", "a135", "a136", "a137", "a138", "a139",
  "a140", "a141", "a142", "a143", "a144", "a145", "a146", "a147",
  "a148", "a149", "a150", "a151", "a152", "a153", "a154", "a155",
  "a156", "a157", "a158", "a159", "a160", "a161", "a163", "a164",
  "a196", "a165", "a192", "a166", "a167", "a168", "a169", "a170",
  "a171", "a172", "a173", "a162", "a174", "a175", "a176", "a177",
  "a178", "a179", "a193", "a180", "a199", "a181", "a200", "a182",
  ".notdef", "a201", "a183", "a184", "a197", "a185", "a194", "a198",
  "a186", "a195", "a187", "a188", "a189", "a190", "a191", ".notdef",
];
