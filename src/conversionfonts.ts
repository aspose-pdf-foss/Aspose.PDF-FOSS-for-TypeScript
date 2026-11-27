import type { Document } from './document.js';
import type { ConvertAction } from './conversion.js';
import { embedFonts, type ConversionFontTarget, type EmbedFontsReport } from './embedfonts.js';
import { heldFonts, hasProgram, type HeldFont } from './simpleembed.js';
import { isArray, isDict, isName, isStream, ref, type PdfDict, type PdfStream } from './types.js';
import { collectGlyphUsage } from './glyphusage.js';
import { usedCidSet } from './cidembed.js';
import { parseCidCMap } from './cidcmap.js';
import { inflateStream } from './flate.js';
import { rethrowLimit } from './errors.js';
import { loadEmbeddedProgram } from './glyphprogram.js';

/** All archival and accessible targets require matching CMap writing modes.
 *  Correct the declaration only when the program explicitly defines its mode. */
function repairWritingMode(doc: Document, font: HeldFont, actions: ConvertAction[]): void {
  const enc = doc.resolve(font.dict.get('Encoding'));
  if (!isStream(enc) || !enc.dict.has('WMode')) return;
  const declared = doc.resolve(enc.dict.get('WMode'));
  if (typeof declared !== 'number') return;
  let mode: number | undefined;
  try { mode = parseCidCMap(inflateStream(enc)).declaredWMode; }
  catch (caught) { rethrowLimit(caught); return; }
  if (mode === undefined || declared === mode) return;
  const corrected = new Map(enc.dict).set('WMode', mode);
  font.dict.set('Encoding', doc.allocObject({ ...enc, dict: corrected }));
  actions.push({ rule: 'CMapWModeMatch', object: font.ref, action: `Matched the CMap dictionary to the program's /WMode ${mode}.` });
}

/** An existing subset can also need a CIDSet, for example after standalone
 *  embedding. All parents sharing a descendant must have complete CID usage. */
function repairMissingCidSets(doc: Document, subsets: Map<PdfDict, HeldFont[]>, actions: ConvertAction[]): void {
  if (!subsets.size) return;
  const usage = collectGlyphUsage(doc);
  for (const [descendant, parents] of subsets) {
    const old = doc.resolve(descendant.get('FontDescriptor'));
    if (!isDict(old)) continue;
    const program = loadEmbeddedProgram(old, o => doc.resolve(o), s => inflateStream(s as PdfStream));
    const glyphCount = program.cff?.numGlyphs ?? program.sfnt?.numGlyphs;
    if (!glyphCount) continue;
    const codes = new Set<number>();
    const complete = parents.every(({ dict }) => {
      const used = usage.get(dict);
      if (!used?.complete) return false;
      for (const gid of used.gids) if (gid >= glyphCount) return false;
      for (const cid of used.codes) codes.add(cid);
      return true;
    });
    if (!complete) continue;
    const copy = new Map(old).set('CIDSet', doc.allocObject(usedCidSet(codes)));
    descendant.set('FontDescriptor', doc.allocObject(copy));
    actions.push({ rule: 'FontCIDSet', object: parents[0].ref, action: 'Added the used CIDs to the embedded subset descriptor.' });
  }
}

export function embedConversionFonts(doc: Document, target: ConversionFontTarget, actions: ConvertAction[]): EmbedFontsReport {
  const fonts = heldFonts(doc);
  const report = embedFonts(doc, { bundledStandard14: target !== 'pdfua' }, target, fonts);
  for (const font of report.embedded) {
    actions.push({
      rule: target === 'pdfua' ? 'FontNotEmbedded' : 'FontEmbedded',
      action: `Embedded ${font.source} face '${font.postScriptName ?? font.name}' for '${font.name}'.`,
      object: font.object === undefined ? undefined : ref(font.object),
      page: font.pages?.length ? doc.Pages[font.pages[0] - 1] : undefined,
    });
  }
  const subsets = new Map<PdfDict, HeldFont[]>();
  for (const font of fonts) {
    const sub = doc.resolve(font.dict.get('Subtype'));
    if (!isName(sub) || sub.name !== 'Type0') continue;
    repairWritingMode(doc, font, actions);
    if (target === 'pdfua' || target === 4) continue;
    const descendants = doc.resolve(font.dict.get('DescendantFonts'));
    const desc = isArray(descendants) ? doc.resolve(descendants[0]) : undefined;
    if (!isDict(desc) || !hasProgram(doc, desc)) continue;
    const descriptor = doc.resolve(desc.get('FontDescriptor'));
    if (!isDict(descriptor)) continue;
    if (target === 2 || target === 3) {
      // These parts allow omission. A used-CID bitmap inherited from PDF/A-1
      // cannot establish membership of every CID in the embedded program.
      if (descriptor.has('CIDSet')) {
        const copy = new Map(descriptor);
        copy.delete('CIDSet');
        desc.set('FontDescriptor', doc.allocObject(copy));
        actions.push({ rule: 'FontCIDSet', object: font.ref, action: 'Omitted the optional CIDSet from the font descriptor.' });
      }
      continue;
    }
    const base = doc.resolve(desc.get('BaseFont'));
    if (!isName(base) || !/^[A-Z]{6}\+/.test(base.name)) continue;
    if (isStream(doc.resolve(descriptor.get('CIDSet')))) continue;
    const parents = subsets.get(desc);
    if (parents) parents.push(font);
    else subsets.set(desc, [font]);
  }
  repairMissingCidSets(doc, subsets, actions);
  return report;
}
