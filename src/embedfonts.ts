// `doc.EmbedFonts()` (g0ky.2): embed a font the document names and did not
// embed, from a face in a folder registered with `RegisterFontFolder` /
// `RegisterSystemFonts`, when that face draws what the page shows.
//
// **Invariant:** the face is found by NAME only, never by coverage. Embedding a
// face is a statement that it IS the font the document named; a face that
// merely covers the characters is `RegisterRenderFontFolder`'s substitution,
// which changes nothing in the file. So `/BaseFont` (subset tag stripped) is
// matched against the face's PostScript name first, then its family part
// (before a `,` or a `-`) against the face's family with spaces ignored --
// `TimesNewRoman,Bold` is Word's spelling of Times New Roman Bold -- and the
// face's style must then EQUAL the font's (`fontStyleOf`): a family hit in the
// wrong weight is no face at all, since a monospaced bold and regular share
// their widths and the width check could not tell them apart.
//
// **Invariant:** whether the face agrees with what is shown is
// `simpleembed.ts`'s per-shown-code check, shared with ConvertToPdfA's
// Standard-14 pass. Faces with CFF outlines and composite fonts are declined
// and reported, never guessed at.

import type { Document } from './document.js';
import { isDict, isName, type PdfDict } from './types.js';
import { fontStyleOf } from './font.js';
import { deriveStyle } from './fontmatch.js';
import type { FaceRecord } from './fontsource.js';
import { embedSimpleFonts, hasProgram, heldFonts, type SimpleEmbedDecline, type SimpleEmbedRequest } from './simpleembed.js';
import { std14Request, stripSubset } from './pdfastd14.js';
import { fontFamilyKeys, squashFontName as squash } from './fontsubstrules.js';
import { readType1Header } from './type1header.js';
import { embedCidFonts, type CidEmbedRequest } from './cidembed.js';

/** Options for {@link Document.EmbedFonts}. */
export interface EmbedFontsOptions {
  /** Shrink each embedded program to the glyphs the document shows. Glyph
   *  slots are kept, so nothing is renumbered. Default true. */
  subset?: boolean;
  /** A non-embedded font naming one of the twelve Latin Standard-14 faces
   *  (`Helvetica`, `Times-Bold`, ...) with no registered face of that name
   *  gets the bundled metric-compatible Liberation substitute -- the face
   *  `ConvertToPdfA` embeds. Default false. */
  bundledStandard14?: boolean;
}

/** Why a font was not embedded. The {@link SimpleEmbedDecline} reasons are
 *  the face disagreeing with the font; `no-face` is no registered face of
 *  that name and style. A composite font is embedded since g0ky.7 and
 *  declines with the same reasons. */
export type EmbedFontSkipReason = 'no-face' | SimpleEmbedDecline;

/** A font {@link Document.EmbedFonts} embedded. */
export interface EmbeddedFontRecord {
  /** `/BaseFont` without its subset tag. */
  name: string;
  /** The font dictionary's object number; undefined for a font dictionary
   *  written directly in a resource dictionary, which has none. */
  object?: number;
  /** For a font with no object number: the 1-based pages whose resources
   *  declare it, so it can still be found. */
  pages?: number[];
  /** A registered face, or the bundled Standard-14 substitute. */
  source: 'registered' | 'bundled';
  /** The embedded face's PostScript name, when it states one. */
  postScriptName?: string;
  /** For a registered face: its file and face index within it. */
  path?: string;
  faceIndex?: number;
}

/** A non-embedded font {@link Document.EmbedFonts} left as it was. */
export interface EmbedFontSkip {
  /** `/BaseFont` without its subset tag; undefined when it states none. */
  name?: string;
  /** The font dictionary's object number; undefined for a font dictionary
   *  written directly in a resource dictionary, which has none. */
  object?: number;
  /** For a font with no object number: the 1-based pages whose resources
   *  declare it, so it can still be found. */
  pages?: number[];
  reason: EmbedFontSkipReason;
  /** For `glyph` and `width-mismatch`: which code, and what disagreed. */
  detail?: string;
}

/** What {@link Document.EmbedFonts} did. */
export interface EmbedFontsReport {
  embedded: EmbeddedFontRecord[];
  skipped: EmbedFontSkip[];
}

/** The registered face that IS the font `baseFont` names, in `style`. */
export function faceForFont(
  faces: readonly FaceRecord[], baseFont: string, style: { bold: boolean; italic: boolean },
): FaceRecord | undefined {
  const want = baseFont.trim().toLowerCase();
  if (want === '') return undefined;
  const byPs = faces.find((f) => f.names.postScriptName?.trim().toLowerCase() === want);
  if (byPs) return byPs;
  const families = fontFamilyKeys(baseFont);
  for (const fam of families) {
    const hit = faces.find((f) => {
      if (squash(f.names.typographicFamily ?? f.names.family) !== fam && squash(f.names.family) !== fam) return false;
      const s = deriveStyle(f.names);
      return (s.weight >= 600) === style.bold && s.italic === style.italic;
    });
    if (hit) return hit;
  }
  return undefined;
}

function checkOpts(opts: EmbedFontsOptions): void {
  if (opts === null || typeof opts !== 'object') throw new TypeError('EmbedFonts options must be an object');
  for (const k of ['subset', 'bundledStandard14'] as const) {
    if (opts[k] !== undefined && typeof opts[k] !== 'boolean') throw new TypeError(`EmbedFonts: ${k} must be a boolean`);
  }
}

/** Implementation of {@link Document.EmbedFonts}. */
export function embedFonts(doc: Document, opts: EmbedFontsOptions = {}): EmbedFontsReport {
  checkOpts(opts);
  const report: EmbedFontsReport = { embedded: [], skipped: [] };
  const faces = doc.registeredFontFaces();
  const requests: SimpleEmbedRequest[] = [];
  const faceOf = new Map<SimpleEmbedRequest, FaceRecord>();
  const cidRequests: CidEmbedRequest[] = [];
  const cidFaceOf = new Map<CidEmbedRequest, FaceRecord>();
  const nameOf = (font: PdfDict): string | undefined => {
    const bf = doc.resolve(font.get('BaseFont'));
    return isName(bf) ? stripSubset(bf.name) : undefined;
  };

  // Where a record says the font is: its object number, else its pages.
  const where = new Map<PdfDict, { object: number } | { pages: number[] }>();
  const at = (font: PdfDict): { object: number } | { pages: number[] } => where.get(font)!;
  const held0 = heldFonts(doc);
  // A descendant two Type0 dicts name is ONE program for both: embedding it
  // for one changes what the other draws, unchecked (final review).
  const descendantOf = (font: PdfDict): PdfDict | undefined => {
    const d = doc.resolve(font.get('DescendantFonts'));
    const d0 = Array.isArray(d) ? doc.resolve(d[0]) : undefined;
    return isDict(d0) ? d0 : undefined;
  };
  const sharers = new Map<PdfDict, number>();
  for (const h of held0) {
    const sub = doc.resolve(h.dict.get('Subtype'));
    if (!isName(sub) || sub.name !== 'Type0') continue;
    const d0 = descendantOf(h.dict);
    if (d0) sharers.set(d0, (sharers.get(d0) ?? 0) + 1);
  }
  for (const held of held0) {
    const obj = held.dict;
    if ((obj.get('Type') as { name?: string })?.name !== 'Font') continue;
    where.set(obj, held.ref ? { object: held.ref.num } : { pages: held.pages });
    const object = held.ref;
    const sub = doc.resolve(obj.get('Subtype'));
    const subtype = isName(sub) ? sub.name : undefined;
    const fontName = nameOf(obj);
    if (subtype === 'Type0') {
      // A composite font gets a TrueType face as a CIDFontType2 (g0ky.7).
      const d0 = descendantOf(obj);
      if (!d0) {
        report.skipped.push({ name: fontName, ...at(obj), reason: 'usage', detail: 'the Type0 font has no descendant font' });
        continue;
      }
      if (hasProgram(doc, d0)) continue;
      if ((sharers.get(d0) ?? 0) > 1) {
        report.skipped.push({ name: fontName, ...at(obj), reason: 'shared', detail: 'its descendant font is shared with another Type0 font' });
        continue;
      }
      const face = fontName === undefined ? undefined : faceForFont(faces, fontName, fontStyleOf(obj, (o) => doc.resolve(o)));
      if (face && doc.registeredFaceType1(face)) {
        report.skipped.push({ name: fontName, ...at(obj), reason: 'outlines', detail: 'only a face with TrueType outlines is embedded into a composite font' });
        continue;
      }
      const sfnt = face ? doc.registeredFaceSfnt(face) : undefined;
      if (face && sfnt) {
        const r: CidEmbedRequest = { object, font: obj, sfnt };
        cidFaceOf.set(r, face);
        cidRequests.push(r);
      } else report.skipped.push({ name: fontName, ...at(obj), reason: 'no-face' });
      continue;
    }
    if (subtype !== 'Type1' && subtype !== 'MMType1' && subtype !== 'TrueType') continue;
    if (hasProgram(doc, obj)) continue;

    const face = fontName === undefined ? undefined : faceForFont(faces, fontName, fontStyleOf(obj, (o) => doc.resolve(o)));
    // A Type 1 face is embedded as ITSELF (g0ky.7): the sfnt it parses to is
    // a CID-keyed CFF conversion a simple font cannot select glyphs from.
    const type1 = face ? doc.registeredFaceType1(face) : undefined;
    const sfnt = face && !type1 ? doc.registeredFaceSfnt(face) : undefined;
    if (face && (type1 || sfnt)) {
      const r: SimpleEmbedRequest = type1 ? { object, font: obj, type1 } : { object, font: obj, sfnt };
      faceOf.set(r, face);
      requests.push(r);
      continue;
    }
    const bundled = opts.bundledStandard14 ? std14Request(doc, object, obj) : undefined;
    if (bundled) { requests.push(bundled); continue; }
    report.skipped.push({ name: fontName, ...at(obj), reason: 'no-face' });
  }

  for (const o of embedSimpleFonts(doc, requests, { subset: opts.subset ?? true }, held0)) {
    const { request } = o;
    const fontName = nameOf(request.font);
    if (!o.embedded) {
      report.skipped.push({
        name: fontName, ...at(request.font), reason: o.reason!,
        ...(o.detail !== undefined ? { detail: o.detail } : {}),
      });
      continue;
    }
    const face = faceOf.get(request);
    const ps = request.type1 ? readType1Header(request.type1.raw).fontName : request.sfnt?.postScriptName;
    report.embedded.push({
      name: fontName ?? '', ...at(request.font),
      source: face ? 'registered' : 'bundled',
      ...(ps !== undefined ? { postScriptName: ps } : {}),
      ...(face ? { path: face.path, faceIndex: face.faceIndex } : {}),
    });
  }
  for (const o of embedCidFonts(doc, cidRequests, { subset: opts.subset ?? true })) {
    const { request } = o;
    const fontName = nameOf(request.font);
    if (!o.embedded) {
      report.skipped.push({
        name: fontName, ...at(request.font), reason: o.reason!,
        ...(o.detail !== undefined ? { detail: o.detail } : {}),
      });
      continue;
    }
    const face = cidFaceOf.get(request)!;
    report.embedded.push({
      name: fontName ?? '', ...at(request.font), source: 'registered',
      ...(request.sfnt.postScriptName !== undefined ? { postScriptName: request.sfnt.postScriptName } : {}),
      path: face.path, faceIndex: face.faceIndex,
    });
  }
  // Indirect fonts by object number, then direct ones by first page.
  const key = (r: EmbedFontSkip): number => r.object ?? 2 ** 40 + (r.pages?.[0] ?? 0);
  report.skipped.sort((a, b) => key(a) - key(b));
  return report;
}
