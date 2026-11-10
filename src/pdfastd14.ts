import type { Document } from './document.js';
import { isDict, isName, type PdfDict, type PdfRef } from './types.js';
import { matchStd14, type StdFont } from './metrics.js';
import { getStd14Sfnt } from './std14fonts.js';
import { embedSimpleFonts, hasProgram, type SimpleEmbedRequest } from './simpleembed.js';
import type { ConvertAction } from './conversion.js';

/** The bundled substitute's face name, for the action text only. */
const SUBSTITUTE: Record<string, string> = { Helvetica: 'Liberation Sans', Times: 'Liberation Serif', Courier: 'Liberation Mono' };

export const stripSubset = (n: string): string => (/^[A-Z]{6}\+/.test(n) ? n.slice(7) : n);

/** One of the twelve Latin Standard-14 faces, named exactly (subset prefix
 *  aside). Symbol and ZapfDingbats are excluded: their bundled substitutes are
 *  symbolic, and PDF/A's symbolic-TrueType rules are a different conversion. */
export function latinStd14(baseFont: string): StdFont | undefined {
  const b = stripSubset(baseFont);
  const std = matchStd14(b);
  return std === b && std !== 'Symbol' && std !== 'ZapfDingbats' ? std : undefined;
}

/** The bundled-substitute request for a non-embedded `/Type1` font naming a
 *  Latin Standard-14 face, or `undefined`. */
export function std14Request(doc: Document, object: PdfRef | undefined, font: PdfDict): SimpleEmbedRequest | undefined {
  const sub = doc.resolve(font.get('Subtype'));
  const bf = doc.resolve(font.get('BaseFont'));
  if (!isName(sub) || sub.name !== 'Type1' || !isName(bf)) return undefined;
  const std = latinStd14(bf.name);
  if (!std || hasProgram(doc, font)) return undefined;
  const sfnt = getStd14Sfnt(std);
  return sfnt ? { object, font, sfnt, std } : undefined;
}

/**
 * Embed the bundled substitute for every non-embedded simple `/Type1` font
 * naming one of the twelve Latin Standard-14 faces (`29z6.6`), through
 * `simpleembed.ts`'s engine: the font becomes a non-symbolic `/TrueType` with
 * the substitute as `/FontFile2`, shrunk to the glyphs the page shows.
 *
 * Declined, and the font put back exactly as it was, when the usage scan cannot
 * account for every code the font shows, when a shown code has no glyph in the
 * substitute, or when a shown code's `/Widths` entry disagrees with the
 * substitute's advance by more than 1/1000 em. PDF/A requires the two to agree,
 * and moving the author's text to make them agree is not this pass's call.
 * The validator then reports the font `FontEmbedded`, as before.
 */
export function embedStandard14(doc: Document): ConvertAction[] {
  const requests: SimpleEmbedRequest[] = [];
  for (const [object, obj] of doc.objectEntries()) {
    if (!isDict(obj) || (obj.get('Type') as { name?: string })?.name !== 'Font') continue;
    const r = std14Request(doc, object, obj);
    if (r) requests.push(r);
  }
  if (requests.length === 0) return [];
  const actions: ConvertAction[] = [];
  for (const o of embedSimpleFonts(doc, requests, { subset: true })) {
    if (!o.embedded) continue;
    const family = o.request.std!.split('-')[0];
    actions.push({
      rule: 'FontEmbedded', object: o.request.object,
      action: `Embedded the bundled ${SUBSTITUTE[family] ?? family} substitute for Standard-14 font '${stripSubset((o.request.font.get('BaseFont') as { name: string }).name)}'.`,
    });
  }
  return actions;
}
