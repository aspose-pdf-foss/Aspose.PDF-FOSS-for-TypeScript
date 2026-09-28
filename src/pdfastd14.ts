import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isStream, name } from './types.js';
import { matchStd14, type StdFont } from './metrics.js';
import { standardEncodingNames, winAnsiEncodingNames, macRomanEncodingNames, glyphToUnicode } from './encoding.js';
import { std14Widths } from './font.js';
import { getStd14Sfnt } from './std14fonts.js';
import { encodeStream } from './filters.js';
import { collectGlyphUsage } from './glyphusage.js';
import { shrinkGlyf } from './fontshrink.js';
import type { SfntFont } from './sfnt.js';
import type { ConvertAction } from './conversion.js';

const PROGRAM_KEYS = ['FontFile', 'FontFile2', 'FontFile3'];
/** The bundled substitute's face name, for the action text only. */
const SUBSTITUTE: Record<string, string> = { Helvetica: 'Liberation Sans', Times: 'Liberation Serif', Courier: 'Liberation Mono' };

const stripSubset = (n: string): string => (/^[A-Z]{6}\+/.test(n) ? n.slice(7) : n);

/** One of the twelve Latin Standard-14 faces, named exactly (subset prefix
 *  aside). Symbol and ZapfDingbats are excluded: their bundled substitutes are
 *  symbolic, and PDF/A's symbolic-TrueType rules are a different conversion. */
function latinStd14(baseFont: string): StdFont | undefined {
  const b = stripSubset(baseFont);
  const std = matchStd14(b);
  return std === b && std !== 'Symbol' && std !== 'ZapfDingbats' ? std : undefined;
}

/** `code -> glyph name` for a NON-embedded simple font, per 32000-1 9.6.6.1:
 *  a named base encoding, else StandardEncoding (a Latin face's built-in), with
 *  `/Differences` over it. `undefined` when the base is not a Latin one. */
function finalNames(doc: Document, font: PdfDict): (string | undefined)[] | undefined {
  const enc = doc.resolve(font.get('Encoding'));
  const table = (n: string | undefined): readonly (string | undefined)[] | undefined =>
    n === undefined || n === 'StandardEncoding' ? standardEncodingNames
      : n === 'WinAnsiEncoding' ? winAnsiEncodingNames
      : n === 'MacRomanEncoding' ? macRomanEncodingNames : undefined;
  if (enc === undefined || enc === null) return [...standardEncodingNames];
  if (isName(enc)) return table(enc.name)?.slice();
  if (!isDict(enc)) return undefined;
  const b = doc.resolve(enc.get('BaseEncoding'));
  const base = table(isName(b) ? b.name : undefined);
  if (!base) return undefined;
  const out = base.slice();
  const diffs = doc.resolve(enc.get('Differences'));
  if (isArray(diffs)) {
    let code = 0;
    for (const d of diffs) {
      const r = doc.resolve(d);
      if (typeof r === 'number') code = r;
      else if (isName(r)) out[code++ & 0xff] = r.name;
    }
  }
  return out;
}

/** The `/Encoding` a non-symbolic TrueType may carry under PDF/A — a WinAnsi or
 *  MacRoman base (ISO 19005-2 6.2.11.6) — expressing exactly `names`. Codes a
 *  base defines and `names` does not become `/.notdef`, so no code starts
 *  drawing a glyph it did not draw before. */
function encodingFor(doc: Document, font: PdfDict, names: (string | undefined)[]): PdfObject {
  const enc = doc.resolve(font.get('Encoding'));
  const keepBase = isName(enc) ? enc.name : isDict(enc) ? (doc.resolve(enc.get('BaseEncoding')) as { name?: string })?.name : undefined;
  const baseName = keepBase === 'MacRomanEncoding' ? 'MacRomanEncoding' : 'WinAnsiEncoding';
  const base = baseName === 'MacRomanEncoding' ? macRomanEncodingNames : winAnsiEncodingNames;
  const diffs: PdfObject[] = [];
  let last = -2;
  for (let c = 0; c < 256; c++) {
    if (names[c] === base[c]) continue;
    if (c !== last + 1) diffs.push(c);
    diffs.push(name(names[c] ?? '.notdef'));
    last = c;
  }
  if (diffs.length === 0) return name(baseName);
  return new Map<string, PdfObject>([
    ['Type', name('Encoding')], ['BaseEncoding', name(baseName)], ['Differences', diffs],
  ]);
}

function hasProgram(doc: Document, font: PdfDict): boolean {
  const fd = doc.resolve(font.get('FontDescriptor'));
  return isDict(fd) && PROGRAM_KEYS.some((k) => fd.has(k));
}

/** Descriptor flags for a Latin face: Nonsymbolic, plus FixedPitch, Serif and
 *  Italic as the face is. */
function latinFlags(std: StdFont): number {
  let f = 32;
  if (std.startsWith('Courier')) f |= 1;
  if (std.startsWith('Times')) f |= 2;
  if (/Italic|Oblique/.test(std)) f |= 64;
  return f;
}

function newDescriptor(font: PdfDict, sfnt: SfntFont, std: StdFont): PdfDict {
  const k = 1000 / sfnt.unitsPerEm;
  const s = (v: number): number => Math.round(v * k);
  return new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', font.get('BaseFont')!],
    ['Flags', latinFlags(std)], ['FontBBox', sfnt.bbox.map(s)],
    ['ItalicAngle', sfnt.italicAngle], ['Ascent', s(sfnt.ascent)], ['Descent', s(sfnt.descent)],
    ['CapHeight', s(sfnt.capHeight)], ['StemV', sfnt.stemV || 80],
  ]);
}

interface Embedded {
  object: PdfRef;
  font: PdfDict;
  std: StdFont;
  sfnt: SfntFont;
  names: (string | undefined)[];
  descriptor: PdfDict;
  programRef: PdfRef;
  /** Everything needed to put the font back exactly as it was. */
  restore: () => void;
}

const snapshot = (d: PdfDict): (() => void) => {
  const saved = new Map(d);
  return () => { d.clear(); for (const [k, v] of saved) d.set(k, v); };
};

/** The advance of `gid` in the substitute, in 1/1000 em. */
const advance = (s: SfntFont, gid: number): number => (s.advanceWidth(gid) * 1000) / s.unitsPerEm;

/**
 * Embed the bundled substitute for every non-embedded simple `/Type1` font
 * naming one of the twelve Latin Standard-14 faces (`29z6.6`).
 *
 * The font becomes a non-symbolic `/TrueType` with the substitute as
 * `/FontFile2`. Its encoding is rewritten to express the SAME code -> glyph-name
 * map over a base PDF/A permits, and `/Widths` is kept, or written from the AFM
 * metrics every viewer — this library's renderer included — lays the text out
 * with. The program is then shrunk to the glyphs the page shows.
 *
 * Declined, and the font put back exactly as it was, when the usage scan cannot
 * account for every code the font shows, when a shown code has no glyph in the
 * substitute, or when a shown code's `/Widths` entry disagrees with the
 * substitute's advance by more than 1/1000 em. PDF/A requires the two to agree,
 * and moving the author's text to make them agree is not this pass's call.
 * The validator then reports the font `FontEmbedded`, as before.
 */
export function embedStandard14(doc: Document): ConvertAction[] {
  const done: Embedded[] = [];
  for (const [object, obj] of doc.objectEntries()) {
    if (!isDict(obj) || (obj.get('Type') as { name?: string })?.name !== 'Font') continue;
    const sub = doc.resolve(obj.get('Subtype'));
    const bf = doc.resolve(obj.get('BaseFont'));
    if (!isName(sub) || sub.name !== 'Type1' || !isName(bf)) continue;
    const std = latinStd14(bf.name);
    if (!std || hasProgram(doc, obj)) continue;
    const names = finalNames(doc, obj);
    const sfnt = getStd14Sfnt(std);
    if (!names || !sfnt) continue;

    const restoreFont = snapshot(obj);
    const fdRaw = doc.resolve(obj.get('FontDescriptor'));
    const restoreFd = isDict(fdRaw) ? snapshot(fdRaw) : () => {};
    const descriptor = isDict(fdRaw) ? fdRaw : newDescriptor(obj, sfnt, std);
    if (isDict(fdRaw)) {
      const f = doc.resolve(fdRaw.get('Flags'));
      fdRaw.set('Flags', ((typeof f === 'number' ? f : 0) & ~4) | 32);
    } else obj.set('FontDescriptor', doc.allocObject(descriptor));

    if (!obj.has('Widths')) {
      const unicode = names.map((n) => (n === undefined ? undefined : glyphToUnicode(n)));
      obj.set('FirstChar', 0); obj.set('LastChar', 255); obj.set('Widths', std14Widths(std, unicode));
    }
    obj.set('Encoding', encodingFor(doc, obj, names));
    obj.set('Subtype', name('TrueType'));
    const programRef = doc.allocObject(encodeStream(sfnt.raw, 'FlateDecode', new Map([['Length1', sfnt.raw.length]])));
    descriptor.set('FontFile2', programRef);
    done.push({
      object, font: obj, std, sfnt, names, descriptor, programRef,
      restore: () => { restoreFont(); restoreFd(); doc.deleteObject(programRef.num); },
    });
  }
  if (done.length === 0) return [];

  // One scan for all of them, now that each is a TrueType the scan can map.
  const usage = collectGlyphUsage(doc);
  const actions: ConvertAction[] = [];
  for (const e of done) {
    const u = usage.get(e.font);
    const cmap = e.sfnt.cmapSubtable(3, 1);
    const widths = doc.resolve(e.font.get('Widths'));
    const first = doc.resolve(e.font.get('FirstChar'));
    let ok = !!u && u.complete && !!cmap && isArray(widths) && typeof first === 'number';
    if (ok) {
      for (const code of u!.codes) {
        const ch = e.names[code] === undefined ? undefined : glyphToUnicode(e.names[code]!);
        const gid = ch === undefined || [...ch].length !== 1 ? undefined : cmap!.get(ch.codePointAt(0)!);
        const w = doc.resolve((widths as PdfObject[])[code - (first as number)]);
        if (gid === undefined || typeof w !== 'number' || Math.abs(w - advance(e.sfnt, gid)) > 1) { ok = false; break; }
      }
    }
    if (!ok) { e.restore(); continue; }

    // Shrink to the glyphs shown; keep the whole face if that is not smaller.
    const shrunk = shrinkGlyf(e.sfnt, u!.gids);
    if (shrunk.bytes.length < e.sfnt.raw.length) {
      doc.replaceObject(e.programRef.num, encodeStream(shrunk.bytes, 'FlateDecode', new Map([['Length1', shrunk.bytes.length]])));
    }
    const family = e.std.split('-')[0];
    actions.push({
      rule: 'FontEmbedded', object: e.object,
      action: `Embedded the bundled ${SUBSTITUTE[family] ?? family} substitute for Standard-14 font '${stripSubset((e.font.get('BaseFont') as { name: string }).name)}'.`,
    });
  }
  return actions;
}
