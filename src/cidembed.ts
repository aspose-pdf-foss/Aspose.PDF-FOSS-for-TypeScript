// Embedding a TrueType program into a NON-embedded composite (`Type0`) font,
// for `doc.EmbedFonts` (g0ky.7). The composite counterpart of
// `simpleembed.ts`, and built the same way: decide what needs no scan before
// anything is touched, embed, scan once, check every SHOWN CID, and put a
// font back from a snapshot when its program does not draw what is shown.
//
// **Invariant:** the descendant becomes a `CIDFontType2` with the program in
// `/FontFile2` and a `/CIDToGIDMap` stream. A non-embedded CIDFont names CIDs
// in a collection the face knows nothing about, so the map is built from the
// font's own statement of what each CID MEANS -- its `/ToUnicode`, else the
// published Adobe table for its `/CIDSystemInfo` ordering (`cidunicode.ts`) --
// and the face's (3,1) cmap. Every CID that resolves is mapped, not only the
// shown ones, so a CID drawn somewhere the scan cannot see still draws --
// under `subset: false`; a subset keeps outlines for the shown glyphs only.
//
// **Invariant:** a descendant shared by two Type0 dicts never reaches here:
// `embedFonts` declines both `shared`, since one program would serve both.
//
// **Invariant:** only the `Identity-H` encoding, where a code IS its CID --
// the shape `glyphusage.ts` can scan. Another encoding is reported, never
// guessed at; a vertical one would also need `/W2` checked against vertical
// metrics no TrueType face here states.
//
// **Invariant:** a shown CID must map to a glyph, and its `/W` width (else
// `/DW`, else 1000) must agree with the face's advance within 1/1000 em --
// `simpleembed.ts`'s rule, per CID instead of per code.

import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isStream, name } from './types.js';
import { encodeStream } from './filters.js';
import { inflateStream } from './flate.js';
import { parseCMap } from './cmap.js';
import { getCidToUnicode } from './cidunicode.js';
import { TextFont, cidSystemOrdering } from './font.js';
import { collectGlyphUsage } from './glyphusage.js';
import { shrinkGlyf } from './fontshrink.js';
import type { SfntFont } from './sfnt.js';
import { newDescriptor, type SimpleEmbedDecline } from './simpleembed.js';
import { rethrowLimit } from './errors.js';

/** One composite font to embed a face into. */
export interface CidEmbedRequest {
  /** The Type0 font dict's object; undefined for a direct dict. */
  object?: PdfRef;
  font: PdfDict;
  sfnt: SfntFont;
}

/** What happened to one {@link CidEmbedRequest}. */
export interface CidEmbedOutcome {
  request: CidEmbedRequest;
  embedded: boolean;
  reason?: SimpleEmbedDecline;
  detail?: string;
}

const snapshot = (d: PdfDict): (() => void) => {
  const saved = new Map(d);
  return () => { d.clear(); for (const [k, v] of saved) d.set(k, v); };
};

/** CID -> Unicode code point, from `/ToUnicode` (Identity-H: code = CID), and
 *  for every CID it does not state -- a partial CMap, or one that will not
 *  parse -- the collection's table (g0ky.9: the table was never consulted when
 *  a `/ToUnicode` existed). A CID either source maps to SEVERAL characters is
 *  in `multi`: no one glyph of a face draws it. */
function cidUnicodes(doc: Document, font: PdfDict): { map: Map<number, number>; multi: Set<number> } {
  const map = new Map<number, number>();
  const multi = new Set<number>();
  const take = (cid: number, s: string | undefined): void => {
    if (s === undefined || s === '' || map.has(cid) || multi.has(cid)) return;
    if ([...s].length === 1) map.set(cid, s.codePointAt(0)!);
    else multi.add(cid);
  };
  const tu = doc.resolve(font.get('ToUnicode'));
  if (isStream(tu)) {
    try {
      for (const [code, s] of parseCMap(inflateStream(tu), doc.loadLimits).entries()) take(code, s);
    } catch (caught) { rethrowLimit(caught); }
  }
  const ordering = cidSystemOrdering(font, (o) => doc.resolve(o));
  const table = ordering === undefined ? undefined : getCidToUnicode(ordering);
  if (table) for (let cid = 0; cid <= 0xffff; cid++) take(cid, table.lookup(cid));
  return { map, multi };
}

/**
 * Embed each request's face, then keep only those whose program draws every
 * shown CID at its stated width. Outcomes come back in request order.
 */
export function embedCidFonts(
  doc: Document, requests: readonly CidEmbedRequest[], opts: { subset: boolean },
): CidEmbedOutcome[] {
  const outcomes: CidEmbedOutcome[] = requests.map((request) => ({ request, embedded: false }));
  const wasModified = doc.isModifiedInternal();
  interface Live { outcome: CidEmbedOutcome; map: Uint8Array; programRef: PdfRef; multi: Set<number>; restore: () => void }
  const live: Live[] = [];

  for (const outcome of outcomes) {
    const { font, sfnt } = outcome.request;
    const decline = (reason: SimpleEmbedDecline, detail?: string): void => {
      outcome.reason = reason;
      if (detail !== undefined) outcome.detail = detail;
    };
    const enc = doc.resolve(font.get('Encoding'));
    const encName = isName(enc) ? enc.name : 'an embedded CMap';
    if (encName !== 'Identity-H') { decline('encoding', `the Type0 encoding is ${encName}, not Identity-H`); continue; }
    const desc = doc.resolve(font.get('DescendantFonts'));
    const d0 = isArray(desc) ? doc.resolve(desc[0]) : undefined;
    if (!isDict(d0)) { decline('usage', 'the Type0 font has no descendant font'); continue; }
    if (sfnt.outlines !== 'glyf') { decline('outlines', 'only a face with TrueType outlines is embedded into a composite font'); continue; }
    const uni = sfnt.cmapSubtable(3, 1);
    if (!uni) { decline('cmap'); continue; }

    let maxCid = -1;
    const gidOf = new Map<number, number>();
    const { map: unicodes, multi } = cidUnicodes(doc, font);
    for (const [cid, cp] of unicodes) {
      const gid = uni.get(cp);
      if (!gid) continue;
      gidOf.set(cid, gid);
      if (cid > maxCid) maxCid = cid;
    }
    if (gidOf.size === 0) { decline('cmap', 'no CID of the font has a Unicode value the face has a glyph for'); continue; }
    const map = new Uint8Array((maxCid + 1) * 2);
    for (const [cid, gid] of gidOf) { map[cid * 2] = gid >> 8; map[cid * 2 + 1] = gid & 0xff; }

    const restoreFont = snapshot(font);
    const restoreD0 = snapshot(d0);
    const allocated: number[] = [];
    // The descriptor is COPIED, never written in place: a CIDFont's descriptor
    // may be shared, and nothing reads the copy but this descendant.
    const fdRaw = doc.resolve(d0.get('FontDescriptor'));
    const descriptor: PdfDict = isDict(fdRaw) ? new Map(fdRaw) : newDescriptor(d0, sfnt, undefined);
    // A glyph set from another program describes nothing in this one (g0ky.9).
    descriptor.delete('CIDSet');
    descriptor.delete('CharSet');
    const programRef = doc.allocObject(encodeStream(sfnt.raw, 'FlateDecode', new Map<string, PdfObject>([['Length1', sfnt.raw.length]])));
    allocated.push(programRef.num);
    descriptor.set('FontFile2', programRef);
    const fdRef = doc.allocObject(descriptor);
    allocated.push(fdRef.num);
    const mapRef = doc.allocObject(encodeStream(map, 'FlateDecode'));
    allocated.push(mapRef.num);
    d0.set('Subtype', name('CIDFontType2'));
    d0.set('FontDescriptor', fdRef);
    d0.set('CIDToGIDMap', mapRef);
    live.push({
      outcome, map, programRef, multi,
      restore: () => { restoreFont(); restoreD0(); for (const n of allocated) doc.deleteObject(n); },
    });
  }
  if (live.length === 0) return outcomes;

  const usage = collectGlyphUsage(doc);
  let kept = 0;
  for (const e of live) {
    const { font, sfnt } = e.outcome.request;
    const u = usage.get(font);
    if (!u || !u.complete) {
      e.outcome.reason = 'usage';
      if (u?.reason !== undefined) e.outcome.detail = u.reason;
      e.restore();
      continue;
    }
    const tf = new TextFont(font, (o) => doc.resolve(o), (s) => inflateStream(s as Parameters<typeof inflateStream>[0]));
    for (const cid of [...u.codes].sort((a, b) => a - b)) {
      const gid = cid * 2 + 1 < e.map.length ? (e.map[cid * 2] << 8) | e.map[cid * 2 + 1] : 0;
      if (gid === 0) {
        e.outcome.reason = 'glyph';
        e.outcome.detail = e.multi.has(cid)
          ? `CID ${cid} stands for several characters, which no one glyph of the face draws`
          : `CID ${cid} has no glyph in the face`;
        break;
      }
      const w = (tf.dictWidth(cid) ?? 1) * 1000;
      const a = (sfnt.advanceWidth(gid) * 1000) / sfnt.unitsPerEm;
      if (!(Math.abs(w - a) <= 1)) {
        e.outcome.reason = 'width-mismatch';
        e.outcome.detail = `CID ${cid}: /W ${Math.round(w)}, face ${Math.round(a)}`;
        break;
      }
    }
    if (e.outcome.reason) { e.restore(); continue; }
    if (opts.subset) {
      let shrunk: Uint8Array | undefined;
      try { shrunk = shrinkGlyf(sfnt, u.gids).bytes; } catch (caught) { rethrowLimit(caught); shrunk = undefined; }
      if (shrunk && shrunk.length < sfnt.raw.length) {
        doc.replaceObject(e.programRef.num, encodeStream(shrunk, 'FlateDecode', new Map<string, PdfObject>([['Length1', shrunk.length]])));
      }
    }
    e.outcome.embedded = true;
    kept++;
  }
  if (kept === 0 && !wasModified) doc.clearModifiedInternal();
  return outcomes;
}
