import type { Document } from './document.js';
import { EmbeddedFont } from './embeddedfont.js';
import { registerFontIn, validateFont, type AuthoringFont } from './stamp.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import { ensureAcroForm } from './formcreate.js';
import { isDict, isName, isStream, type PdfDict, type PdfObject, type PdfStream } from './types.js';
import { normalizeFont } from './metrics.js';
import { TextFont } from './font.js';
import { inflateStream } from './flate.js';
import { winAnsiDriver, type FontDriver } from './layout.js';
import { normalEntry } from './appearance.js';

// An embedded handle can still add glyphs until Save, when its reserved font
// object is filled. A fresh wrapper around the same annotation must share it.
const selected = new WeakMap<PdfDict, { key: string; entry: PdfObject; font: AuthoringFont }>();

export function checkFreeTextFont(doc: Document, font: AuthoringFont): void {
  validateFont(font);
  if (font instanceof EmbeddedFont && !doc.ownsEmbeddedFont(font))
    throw new TypeError('FreeText font must be registered with the annotation document');
}

export function registerFreeTextFont(doc: Document, dict: PdfDict, font?: AuthoringFont): string {
  if (font === undefined && resource(doc, dict, 'Helv') === undefined) return 'Helv';
  font ??= 'Helvetica';
  const page = doc.annotationPageIndex(dict);
  const resources = page !== undefined ? ensureOwnResources(doc, doc.Pages[page])
    : ensureOwnSubdict(doc, ensureAcroForm(doc), 'DR');
  const fonts = ensureOwnSubdict(doc, resources, 'Font');
  const key = registerFontIn(doc, fonts, font);
  selected.set(dict, { key, entry: fonts.get(key)!, font });
  return key;
}

function fontIn(doc: Document, resources: PdfObject | undefined, key: string): PdfObject | undefined {
  const res = doc.resolve(resources);
  if (!isDict(res)) return undefined;
  const fonts = doc.resolve(res.get('Font'));
  return isDict(fonts) ? fonts.get(key) : undefined;
}

function resource(doc: Document, dict: PdfDict, key: string): PdfObject | undefined {
  const ap = doc.resolve(normalEntry(doc, dict));
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const local = fontIn(doc, isStream(ap) ? ap.dict.get('Resources') : undefined, key)
    ?? fontIn(doc, dict.get('DR'), key);
  if (local !== undefined) return local;
  const page = doc.annotationPageIndex(dict);
  return fontIn(doc, page !== undefined ? doc.Pages[page].Resources : undefined, key)
    ?? fontIn(doc, isDict(acro) ? acro.get('DR') : undefined, key);
}

function importedDriver(doc: Document, dict: PdfDict): FontDriver {
  const font = new TextFont(dict, value => doc.resolve(value), stream => inflateStream(stream as PdfStream));
  const codes = new Map<string, Uint8Array | undefined>();
  const encode = (text: string): Uint8Array => {
    const bytes: number[] = [];
    for (const ch of text) {
      if (!codes.has(ch)) codes.set(ch, font.drawCode(ch));
      const code = codes.get(ch);
      if (code) bytes.push(...code);
    }
    return Uint8Array.from(bytes);
  };
  return {
    encode, measure: (text, size) => font.decodeRun(encode(text)).width * size,
    probe: text => encode(text).length,
  };
}

/** Use already registered character codes during viewer fallback. Rendering a
 *  missing appearance must never add glyphs to a future subset. */
function readOnlyDriver(font: EmbeddedFont): FontDriver {
  const codes = new Map<string, number>();
  for (const [code, text] of font.toUnicode) codes.set(text, code);
  const encode = (text: string) => {
    const bytes: number[] = [];
    for (const ch of text) {
      const code = codes.get(ch);
      if (code !== undefined) bytes.push(code >> 8, code & 255);
    }
    return Uint8Array.from(bytes);
  };
  return { encode, measure: (text, size) => font.measure(text, size), probe: text => encode(text).length };
}

export function freeTextFont(doc: Document, dict: PdfDict, key: string, writing = false) {
  const own = selected.get(dict);
  if (own?.key === key) {
    const font = own.font;
    return {
      name: typeof font === 'string' ? font : font.sfnt.postScriptName ?? key,
      entry: own.entry,
      driver: typeof font === 'string' ? winAnsiDriver(font) : writing ? font.driver() : readOnlyDriver(font),
    };
  }
  const entry = resource(doc, dict, key);
  const font = doc.resolve(entry);
  if (isDict(font)) {
    const base = doc.resolve(font.get('BaseFont'));
    return { name: isName(base) ? base.name : key, entry, driver: importedDriver(doc, font) };
  }
  const std = normalizeFont(key);
  return { name: std, entry: undefined, driver: winAnsiDriver(std) };
}
