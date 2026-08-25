// @ts-nocheck
// Generates src/unicode-data.ts from the Unicode Character Database.
// Downloads pinned-version UCD files into a gitignored unicode/ dir (cached),
// parses them into range-compressed lookup tables, and emits the committed
// src/unicode-data.ts. Also refreshes the committed BidiCharacterTest.txt
// conformance fixture. Run via: npm run gen:ucd
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_VERSION = '16.0.0';
const BASE = `https://www.unicode.org/Public/${UNICODE_VERSION}/ucd`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'unicode');
mkdirSync(rawDir, { recursive: true });

const FILES = {
  bidiClass: 'extracted/DerivedBidiClass.txt',
  unicodeData: 'UnicodeData.txt',
  scripts: 'Scripts.txt',
  joiningType: 'extracted/DerivedJoiningType.txt',
  arabicShaping: 'ArabicShaping.txt',
  brackets: 'BidiBrackets.txt',
  mirroring: 'BidiMirroring.txt',
  bidiTest: 'BidiCharacterTest.txt',
  lineBreak: 'LineBreak.txt',
  lineBreakTest: 'auxiliary/LineBreakTest.txt',
  eastAsian: 'EastAsianWidth.txt',
  caseFolding: 'CaseFolding.txt',
};

function download(rel, dest) {
  return new Promise((resolve, reject) => {
    const go = (u) => get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
      if (res.statusCode !== 200) { reject(new Error(`${u} -> ${res.statusCode}`)); return; }
      const out = createWriteStream(dest); res.pipe(out); out.on('finish', () => out.close(resolve));
    }).on('error', reject);
    go(`${BASE}/${rel}`);
  });
}

async function fetchAll() {
  const paths = {};
  for (const [key, rel] of Object.entries(FILES)) {
    const dest = join(rawDir, rel.split('/').pop());
    if (!existsSync(dest)) { process.stdout.write(`downloading ${rel}\n`); await download(rel, dest); }
    paths[key] = dest;
  }
  return paths;
}

// ---- parsing helpers ----
const HEX = (s) => parseInt(s, 16);

// "start[..end] ; value  # comment" -> [start, end, rawValue]
function parseRanges(text, valueAt = 1) {
  const rows = [];
  for (const line of text.split('\n')) {
    const noComment = line.split('#')[0].trim();
    if (!noComment) continue;
    const parts = noComment.split(';').map((s) => s.trim());
    const range = parts[0].split('..');
    rows.push([HEX(range[0]), HEX(range[1] ?? range[0]), parts[valueAt]]);
  }
  return rows;
}

// "# @missing: start..end; Value" default declarations -> [start, end, rawValue]
function parseMissing(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^#\s*@missing:\s*([0-9A-Fa-f]+)\.\.([0-9A-Fa-f]+)\s*;\s*([^#]+)/);
    if (m) rows.push([HEX(m[1]), HEX(m[2]), m[3].trim()]);
  }
  return rows;
}

const MAXCP = 0x110000;

// Overlay explicit rows on @missing defaults; coalesce to flat [start,end,id,...].
function buildTable(explicit, missing, idOf, fallbackId) {
  const arr = new Int32Array(MAXCP).fill(fallbackId);
  for (const [s, e, v] of missing) { const id = idOf(v); for (let cp = s; cp <= e; cp++) arr[cp] = id; }
  for (const [s, e, v] of explicit) { const id = idOf(v); for (let cp = s; cp <= e; cp++) arr[cp] = id; }
  const out = [];
  let s = 0;
  for (let cp = 1; cp <= MAXCP; cp++) {
    if (cp === MAXCP || arr[cp] !== arr[s]) { out.push(s, cp - 1, arr[s]); s = cp; }
  }
  return out;
}

// Intern names into a stable id array.
function interner(seed = []) {
  const names = [...seed];
  const index = new Map(names.map((n, i) => [n, i]));
  return { id: (name) => { let i = index.get(name); if (i === undefined) { i = names.length; names.push(name); index.set(name, i); } return i; }, names };
}

// ---- Bidi_Class ----
const BC = { L: 0, R: 1, AL: 2, EN: 3, ES: 4, ET: 5, AN: 6, CS: 7, NSM: 8, BN: 9, B: 10, S: 11, WS: 12, ON: 13, LRE: 14, LRO: 15, RLE: 16, RLO: 17, PDF: 18, LRI: 19, RLI: 20, FSI: 21, PDI: 22 };
const BC_LONG = {
  Left_To_Right: 'L', Right_To_Left: 'R', Arabic_Letter: 'AL', European_Number: 'EN', European_Separator: 'ES',
  European_Terminator: 'ET', Arabic_Number: 'AN', Common_Separator: 'CS', Nonspacing_Mark: 'NSM', Boundary_Neutral: 'BN',
  Paragraph_Separator: 'B', Segment_Separator: 'S', White_Space: 'WS', Other_Neutral: 'ON',
  Left_To_Right_Embedding: 'LRE', Left_To_Right_Override: 'LRO', Right_To_Left_Embedding: 'RLE', Right_To_Left_Override: 'RLO',
  Pop_Directional_Format: 'PDF', Left_To_Right_Isolate: 'LRI', Right_To_Left_Isolate: 'RLI', First_Strong_Isolate: 'FSI', Pop_Directional_Isolate: 'PDI',
};
const bcId = (v) => BC[BC_LONG[v] ?? v];

// ---- Joining_Type ----
const JT = { U: 0, R: 1, L: 2, D: 3, C: 4, T: 5 };
const JT_LONG = { Non_Joining: 'U', Right_Joining: 'R', Left_Joining: 'L', Dual_Joining: 'D', Join_Causing: 'C', Transparent: 'T' };
const jtId = (v) => JT[JT_LONG[v] ?? v];

// ---- Line_Break (UAX #14) ---- LineBreak.txt uses the 2-letter abbreviations.
const LB = {
  BK: 0, CR: 1, LF: 2, CM: 3, NL: 4, SG: 5, WJ: 6, ZW: 7, GL: 8, SP: 9,
  ZWJ: 10, B2: 11, BA: 12, BB: 13, HY: 14, CB: 15, CL: 16, CP: 17, EX: 18, IN: 19,
  NS: 20, OP: 21, QU: 22, IS: 23, NU: 24, PO: 25, PR: 26, SY: 27, AI: 28, AL: 29,
  CJ: 30, EB: 31, EM: 32, H2: 33, H3: 34, HL: 35, ID: 36, JL: 37, JV: 38, JT: 39,
  RI: 40, SA: 41, XX: 42, AK: 43, AP: 44, AS: 45, VF: 46, VI: 47,
};
const lbId = (v) => (LB[v] !== undefined ? LB[v] : LB.XX);

// ---- East_Asian_Width (for LB30's F/W/H exception) ----
const EA = { N: 0, Na: 1, A: 2, H: 3, W: 4, F: 5 };
const eaId = (v) => (EA[v] !== undefined ? EA[v] : EA.N);

// ---- OpenType tags + RTL scripts ----
const OT_TAGS = {
  Latin: 'latn', Arabic: 'arab', Hebrew: 'hebr', Greek: 'grek', Cyrillic: 'cyrl', Han: 'hani',
  Hiragana: 'kana', Katakana: 'kana', Hangul: 'hang', Thai: 'thai', Lao: 'lao ', Devanagari: 'deva',
  Bengali: 'beng', Gujarati: 'gujr', Gurmukhi: 'guru', Tamil: 'taml', Telugu: 'telu', Kannada: 'knda',
  Malayalam: 'mlym', Oriya: 'orya', Sinhala: 'sinh', Myanmar: 'mymr', Khmer: 'khmr', Tibetan: 'tibt',
  Georgian: 'geor', Armenian: 'armn', Ethiopic: 'ethi', Cherokee: 'cher', Mongolian: 'mong',
  Syriac: 'syrc', Thaana: 'thaa', Nko: 'nkoo', Samaritan: 'samr', Mandaic: 'mand', Adlam: 'adlm',
  Common: 'DFLT', Inherited: 'DFLT', Unknown: 'DFLT',
};
const RTL_SCRIPTS = new Set([
  'Arabic', 'Hebrew', 'Syriac', 'Thaana', 'Nko', 'Samaritan', 'Mandaic', 'Adlam', 'Hanifi_Rohingya',
  'Old_Hungarian', 'Old_North_Arabian', 'Old_South_Arabian', 'Imperial_Aramaic', 'Nabataean', 'Palmyrene',
  'Phoenician', 'Manichaean', 'Psalter_Pahlavi', 'Inscriptional_Pahlavi', 'Inscriptional_Parthian',
  'Avestan', 'Kharoshthi', 'Yezidi', 'Sogdian', 'Old_Sogdian', 'Elymaic', 'Chorasmian', 'Cypriot',
]);

// ---- CCC from UnicodeData.txt (handles First>/Last> range pairs) ----
function parseCcc(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split(';');
    if (f.length < 4) continue;
    const cp = HEX(f[0]);
    const ccc = Number(f[3]);
    if (f[1].endsWith(', First>')) {
      const g = lines[++i].split(';');
      rows.push([cp, HEX(g[0]), ccc]);
    } else {
      rows.push([cp, cp, ccc]);
    }
  }
  return rows;
}

// Quote category from UnicodeData.txt General_Category: Pi -> 1, Pf -> 2, else 0
// (for UAX #14 LB15a/LB15b). Pi/Pf are single code points (never First/Last ranges).
function parseQuoteCat(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const f = line.split(';');
    if (f.length < 3) continue;
    const gc = f[2];
    if (gc === 'Pi' || gc === 'Pf') rows.push([HEX(f[0]), HEX(f[0]), gc === 'Pi' ? 1 : 2]);
  }
  return rows;
}

// P*/S* General_Category from UnicodeData.txt — CommonMark 0.31.2's "Unicode
// punctuation character" (symbols were folded into the definition at 0.31.0).
// Handles the First>/Last> range pairs defensively: no P*/S* block uses one
// today, but the Lo/Co/Cs blocks that do share this file.
function parsePunct(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split(';');
    if (f.length < 3) continue;
    const gc = f[2];
    if (gc[0] !== 'P' && gc[0] !== 'S') continue;
    const cp = HEX(f[0]);
    if (f[1].endsWith(', First>')) { const g = lines[++i].split(';'); rows.push([cp, HEX(g[0]), 1]); }
    else rows.push([cp, cp, 1]);
  }
  return rows;
}

// Full case folding (CaseFolding.txt statuses C and F), keeping ONLY the code
// points whose folding differs from String.prototype.toLowerCase. CommonMark
// matches link labels by case folding, which is not lowercasing: 'ẞ' and 'SS'
// both fold to 'ss' but lowercase to 'ß' and 'ss'. Emitting only the
// divergences keeps the table to a few dozen entries and makes it provably
// complete for the pinned Unicode version.
function parseCaseFoldExceptions(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const s = line.split('#')[0].trim();
    if (!s) continue;
    const [code, status, mapping] = s.split(';').map((x) => x.trim());
    if (status !== 'C' && status !== 'F') continue;
    const ch = String.fromCodePoint(HEX(code));
    const folded = mapping.split(/\s+/).map((h) => String.fromCodePoint(HEX(h))).join('');
    if (ch.toLowerCase() !== folded) out[ch] = folded;
  }
  return out;
}

function fmtFlat(arr, perLine = 15) {
  const lines = [];
  for (let i = 0; i < arr.length; i += perLine) lines.push('  ' + arr.slice(i, i + perLine).join(','));
  return lines.join(',\n');
}

async function main() {
  const paths = await fetchAll();
  const read = (k) => readFileSync(paths[k], 'utf8');

  const bcTxt = read('bidiClass');
  const bc = buildTable(parseRanges(bcTxt), parseMissing(bcTxt), bcId, BC.L);

  const ccc = buildTable(parseCcc(read('unicodeData')), [], Number, 0);

  const scTxt = read('scripts');
  const scNames = interner(['Common', 'Inherited', 'Unknown']); // stable low ids
  const sc = buildTable(parseRanges(scTxt), parseMissing(scTxt), (v) => scNames.id(v), scNames.id('Unknown'));

  const jtTxt = read('joiningType');
  const jt = buildTable(parseRanges(jtTxt), parseMissing(jtTxt), jtId, JT.U);

  const lbTxt = read('lineBreak');
  const lb = buildTable(parseRanges(lbTxt), parseMissing(lbTxt), lbId, LB.XX);

  const eaTxt = read('eastAsian');
  const ea = buildTable(parseRanges(eaTxt), parseMissing(eaTxt), eaId, EA.N);

  // Quote category (Pi/Pf) — sparse; default 0.
  const qc = buildTable(parseQuoteCat(read('unicodeData')), [], Number, 0);

  // Unicode punctuation (P* | S*) for CommonMark emphasis flanking — default 0.
  const pu = buildTable(parsePunct(read('unicodeData')), [], Number, 0);

  const foldExc = parseCaseFoldExceptions(read('caseFolding'));

  const jgNames = interner(['No_Joining_Group']);
  const asRows = parseRanges(read('arabicShaping'), 3).map(([s, e, v]) => [s, e, v]); // field 3 = joining group
  const jg = buildTable(asRows, [], (v) => jgNames.id(v), jgNames.id('No_Joining_Group'));

  // Brackets: [cp, type(0 open/1 close), pair] sorted by cp.
  const brk = [];
  for (const line of read('brackets').split('\n')) {
    const s = line.split('#')[0].trim();
    if (!s) continue;
    const [c, p, t] = s.split(';').map((x) => x.trim());
    brk.push([HEX(c), t === 'o' ? 0 : 1, HEX(p)]);
  }
  brk.sort((a, b) => a[0] - b[0]);
  const brkFlat = brk.flat();

  // Mirroring: [cp, mirror] sorted by cp.
  const mir = [];
  for (const line of read('mirroring').split('\n')) {
    const s = line.split('#')[0].trim();
    if (!s) continue;
    const [c, m] = s.split(';').map((x) => x.trim());
    mir.push([HEX(c), HEX(m)]);
  }
  mir.sort((a, b) => a[0] - b[0]);
  const mirFlat = mir.flat();

  // Script tags parallel to scNames.
  const scTags = scNames.names.map((n) => [OT_TAGS[n] ?? 'DFLT', RTL_SCRIPTS.has(n) ? 1 : 0]);

  const out = `// GENERATED by scripts/gen-ucd.mjs from Unicode ${UNICODE_VERSION} — do not edit.
// Range-compressed UCD lookup tables with binary-search accessors. Pure; zero deps.
/* eslint-disable */

export const BC = { L: 0, R: 1, AL: 2, EN: 3, ES: 4, ET: 5, AN: 6, CS: 7, NSM: 8, BN: 9, B: 10, S: 11, WS: 12, ON: 13, LRE: 14, LRO: 15, RLE: 16, RLO: 17, PDF: 18, LRI: 19, RLI: 20, FSI: 21, PDI: 22 } as const;
export const JT = { U: 0, R: 1, L: 2, D: 3, C: 4, T: 5 } as const;
export const LB = ${JSON.stringify(LB).replace(/"/g, '')} as const;
export const EA = ${JSON.stringify(EA).replace(/"/g, '')} as const;

export const scriptNames: string[] = ${JSON.stringify(scNames.names)};
const _scTags: readonly [string, number][] = ${JSON.stringify(scTags)};

// Flat [start, end, id, ...] range triples (total code-point coverage).
const _bc = [
${fmtFlat(bc)}
];
const _ccc = [
${fmtFlat(ccc)}
];
const _sc = [
${fmtFlat(sc)}
];
const _jt = [
${fmtFlat(jt)}
];
const _lb = [
${fmtFlat(lb)}
];
const _ea = [
${fmtFlat(ea)}
];
const _qc = [
${fmtFlat(qc)}
];
const _jg = [
${fmtFlat(jg)}
];
// Unicode punctuation (General_Category P* | S*), per CommonMark 0.31.2.
const _pu = [
${fmtFlat(pu)}
];
// Flat [cp, type, pair, ...] sorted by cp.
const _brk = [
${fmtFlat(brkFlat)}
];
// Flat [cp, mirror, ...] sorted by cp.
const _mir = [
${fmtFlat(mirFlat)}
];

// Binary search over [start, end, id] triples.
function lookup(t: number[], cp: number): number {
  let lo = 0, hi = (t.length / 3) - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, s = t[m * 3];
    if (cp < s) hi = m - 1;
    else if (cp > t[m * 3 + 1]) lo = m + 1;
    else return t[m * 3 + 2];
  }
  return -1;
}
// Binary search over a flat [key, ...payload] table; returns the base index or -1.
function find(t: number[], cp: number, stride: number): number {
  let lo = 0, hi = (t.length / stride) - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, k = t[m * stride];
    if (cp < k) hi = m - 1;
    else if (cp > k) lo = m + 1;
    else return m * stride;
  }
  return -1;
}

export function bidiClass(cp: number): number { return lookup(_bc, cp); }
export function combiningClass(cp: number): number { return lookup(_ccc, cp); }
export function script(cp: number): number { return lookup(_sc, cp); }
export function joiningType(cp: number): number { return lookup(_jt, cp); }
export function lineBreak(cp: number): number { return lookup(_lb, cp); }
export function eastAsianWidth(cp: number): number { return lookup(_ea, cp); }
export function quoteClass(cp: number): number { const v = lookup(_qc, cp); return v < 0 ? 0 : v; }
/** General_Category P* or S* — CommonMark 0.31.2's "Unicode punctuation
 *  character", which decides emphasis flanking. Symbols count: the definition
 *  gained them at 0.31.0. */
export function unicodePunctuation(cp: number): boolean { return lookup(_pu, cp) === 1; }

// Code points whose full case folding differs from toLowerCase().
const _foldExc: Record<string, string> = ${JSON.stringify(foldExc)};

/** Unicode full case folding — what CommonMark means by "case fold" when it
 *  matches a link reference label. NOT the same as lowercasing: 'ẞ' folds to
 *  'ss' but lowercases to 'ß', so \`[ẞ]\` would not find \`[SS]: /url\`.
 *  Folding is context-free, so folding per code point is correct. */
export function caseFold(s: string): string {
  let out = '';
  for (const ch of s) {
    out += Object.prototype.hasOwnProperty.call(_foldExc, ch) ? _foldExc[ch] : ch.toLowerCase();
  }
  return out;
}
export function joiningGroup(cp: number): number { return lookup(_jg, cp); }
export function bracket(cp: number): { type: 0 | 1; pair: number } | undefined {
  const i = find(_brk, cp, 3);
  return i < 0 ? undefined : { type: _brk[i + 1] as 0 | 1, pair: _brk[i + 2] };
}
export function mirror(cp: number): number {
  const i = find(_mir, cp, 2);
  return i < 0 ? cp : _mir[i + 1];
}
export function scriptTag(scriptId: number): { tag: string; rtl: boolean } {
  const t = _scTags[scriptId];
  return t ? { tag: t[0], rtl: t[1] === 1 } : { tag: 'DFLT', rtl: false };
}
`;

  writeFileSync(join(root, 'src/unicode-data.ts'), out);
  const fixture = join(root, 'test/fixtures/unicode/BidiCharacterTest.txt');
  mkdirSync(dirname(fixture), { recursive: true });
  writeFileSync(fixture, read('bidiTest'));
  writeFileSync(join(root, 'test/fixtures/unicode/LineBreakTest.txt'), read('lineBreakTest'));
  process.stdout.write(`wrote src/unicode-data.ts (${(out.length / 1024) | 0} KB) and test fixtures\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
