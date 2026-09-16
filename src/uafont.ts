/** ISO 14289-2 clause 8.4.5 — fonts and CMaps, the 15 rules `q7hc.4.3` added.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.4 Text representation for content/8.4.5 Fonts/**`, plus
 *  `GFGlyph.java` for the glyph model's CACHE KEY, fetched 2026-09-15. A
 *  TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *
 *  **Invariant:** its own module beside `uaannot.ts`, both over `uarule.ts`.
 *  The split is by subject, which is what keeps `structvalidate.ts` the
 *  structure tree's rules and the three free of an import cycle.
 *
 *  **Invariant:** the per-font rules reuse `validatectx.ts`'s `enumerateFonts`,
 *  which `pdfavalidate.ts` and `pdfxvalidate.ts` already consume — a third font
 *  walk is how three validators come to disagree about which fonts a document
 *  has. A `validatectx.Ctx` is built from the `UaCtx` for that one purpose.
 *
 *  **Invariant:** NOTHING here is converted. Embedding a font, synthesizing
 *  `/ToUnicode` and correcting `/Widths` are things `ConvertToPdfA` does under
 *  its own opt-in; doing them here would silently re-encode a document the
 *  caller asked only to validate. Every rule lands in `unresolved`. @internal */
import { isDict, isName, isStream, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import { uaClause, vctx, type Rule, type UaCtx } from './uarule.js';
import {
  descendantFont, enumerateFonts, hasFontProgram, nameOf,
} from './validatectx.js';
import { gidForCid, gidForProgram, loadEmbeddedProgram, programAdvance } from './glyphprogram.js';
import { glyphToUnicode } from './encoding.js';
import { parseCidCMap } from './cidcmap.js';
import { predefinedCMapInfo } from './predefcmap.js';
import { distinctGlyphs as fineGlyphs, type DistinctGlyph } from './uaglyph.js';
import type { ValidationIssue } from './validation.js';
import { inflateStream } from './flate.js';

// `vctx` moved to uarule.ts in `q7hc.4.4`: three rule modules need it now and
// none may import another.

/** `loadEmbeddedProgram`'s two callbacks, over this document. `raster.ts`'s
 *  route — the inflate is `flate.ts`'s free function, never a `Document`
 *  method, which does not exist. */
const progArgs = (ctx: UaCtx): [(o: PdfObject | undefined) => PdfObject,
  (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array] => [
  (o: PdfObject | undefined) => ctx.doc.resolve(o),
  (s) => inflateStream(s as Parameters<typeof inflateStream>[0]),
];

/** 32000-2 Table 121 font descriptor flags. Bit 3 is Symbolic, and the flags
 *  are bit POSITIONS counted from 1, so its value is 2^(3-1) = 4. */
const FLAG_SYMBOLIC = 4;

/** True when the descriptor sets Symbolic. */
function isSymbolic(ctx: UaCtx, descriptor: PdfObject | undefined): boolean {
  const fd = ctx.doc.resolve(descriptor);
  if (!isDict(fd)) return false;
  const flags = ctx.doc.resolve(fd.get('Flags'));
  return typeof flags === 'number' && (flags & FLAG_SYMBOLIC) !== 0;
}
// ---- the deduped glyph walk -------------------------------------------------

/** The glyph walk at the granularity the FONT rules use — `uaglyph.ts`'s fine
 *  records collapsed back to `(font dict, code, renderMode)`.
 *
 *  **Invariant, and it is what keeps `q7hc.4.3`'s report unmoved:** a font that
 *  is not embedded and is drawn in five hundred elements is ONE finding, not
 *  five hundred. `uaglyph.ts` keys on the MCID and the artifact flag because
 *  ISO 14289-2 8.4.3-1 needs them — it must tell a PUA glyph under an element
 *  carrying `/Alt` from one under an element carrying none — and NO font rule
 *  does. Splitting on them here would turn every font finding on a tagged
 *  document into one per marked-content sequence.
 *
 *  **Note, measured, and it covers NOTHING:** returning `fineGlyphs(ctx)`
 *  unchanged reddens not one case, because every fixture in
 *  `test/pdfua2-font.test.ts` is UNTAGGED — `mcid` is `undefined` throughout,
 *  so the two granularities coincide there. The collapse is held by reasoning
 *  rather than by the suite; do not read the green suite as covering it, and do
 *  not "simplify" it away. */
const FONT_GLYPHS = new WeakMap<UaCtx, DistinctGlyph[]>();
function distinctGlyphs(ctx: UaCtx): DistinctGlyph[] {
  let out = FONT_GLYPHS.get(ctx);
  if (out !== undefined) return out;
  // Keyed on the dict IDENTITY plus the code and mode, so no id counter is
  // needed and two fonts provably cannot collide.
  const seen = new Map<PdfDict, Map<string, DistinctGlyph>>();
  for (const g of fineGlyphs(ctx)) {
    let byCode = seen.get(g.fontDict);
    if (byCode === undefined) { byCode = new Map(); seen.set(g.fontDict, byCode); }
    const k = `${g.code}|${g.renderMode}`;
    if (!byCode.has(k)) byCode.set(k, g);
  }
  out = [...seen.values()].flatMap((m) => [...m.values()]);
  FONT_GLYPHS.set(ctx, out);
  return out;
}


/** Does any glyph drawn in this font use a render mode other than 3?
 *
 *  Render mode 3 is invisible text, which is the OCR layer of every scanned
 *  page — the population 8.4.5.5.1-1's exemption exists for. A font drawn only
 *  invisibly is not "rendered" in the sense the clause means. */
function rendersVisibly(ctx: UaCtx, fontDict: PdfDict): boolean {
  return distinctGlyphs(ctx).some(
    (g) => g.fontDict === fontDict && g.renderMode !== 3,
  );
}

// ---- 8.4.5.5.1 — embedding --------------------------------------------------

/** 8.4.5.5.1-1: every rendered font shall be embedded.
 *
 *  **Note the three exemptions are the profile's own:** Type3 (its glyphs are
 *  content streams, so there is no program to embed), Type0 (the rule applies
 *  to its DESCENDANT, which 8.4.5.3.2 covers) and render mode 3. */
const fontNotEmbeddedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    const subtype = nameOf(c, dict, 'Subtype');
    if (subtype === 'Type3' || subtype === 'Type0') continue;
    if (hasFontProgram(c, dict.get('FontDescriptor'))) continue;
    if (!rendersVisibly(ctx, dict)) continue;
    issues.push({
      rule: 'FontNotEmbedded', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.5.1' }), object: ref,
      message: `Font '${nameOf(c, dict, 'BaseFont') ?? '(unnamed)'}' is rendered `
        + 'but has no embedded font program.',
    });
  }
  return issues;
};

// ---- 8.4.5.7 — TrueType encodings and cmaps ---------------------------------

/** 8.4.5.7-3: a symbolic TrueType shall state no /Encoding. */
const trueTypeSymbolicEncodingRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'TrueType') continue;
    if (!isSymbolic(ctx, dict.get('FontDescriptor'))) continue;
    // Presence on the RAW dict: `doc.resolve(undefined)` is `null`, so
    // comparing a resolved value against `undefined` is true for every ABSENT
    // key — the trap `pdfxvalidate.ts` and `pdfatransparency.ts` both record.
    if (!dict.has('Encoding')) continue;
    issues.push({
      rule: 'TrueTypeSymbolicEncoding', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
      message: 'Symbolic TrueType font states an /Encoding; it must state none.',
    });
  }
  return issues;
};

/** Every name in a /Differences array resolves to a Unicode code point.
 *
 *  Through `encoding.ts`'s Adobe-glyph-name resolver, which is the one owner of
 *  that question — a name it cannot resolve is one no consumer can map to text.
 *  Only the NAMES are read; the numbers between them are the codes they apply
 *  to and say nothing about Unicode. */
function differencesUnicodeCompliant(ctx: UaCtx, encDict: PdfDict): boolean {
  const diffs = ctx.doc.resolve(encDict.get('Differences'));
  if (!Array.isArray(diffs)) return true;
  for (const entry of diffs) {
    const v = ctx.doc.resolve(entry);
    if (!isName(v)) continue;
    if (glyphToUnicode(v.name) === undefined) return false;
  }
  return true;
}

/** 8.4.5.7-2: a non-symbolic TrueType's /Encoding shall be MacRomanEncoding or
 *  WinAnsiEncoding, and any /Differences shall be Unicode compliant. */
const trueTypeNonSymbolicEncodingRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'TrueType') continue;
    if (isSymbolic(ctx, dict.get('FontDescriptor'))) continue;
    const enc = ctx.doc.resolve(dict.get('Encoding'));
    const base = isName(enc) ? enc.name
      : isDict(enc) ? nameOf(c, enc, 'BaseEncoding') : undefined;
    const baseOk = base === 'MacRomanEncoding' || base === 'WinAnsiEncoding';
    const diffsOk = !isDict(enc) || differencesUnicodeCompliant(ctx, enc);
    if (baseOk && diffsOk) continue;
    issues.push({
      rule: 'TrueTypeNonSymbolicEncoding', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
      message: baseOk
        ? 'Non-symbolic TrueType /Differences names a glyph with no Unicode value.'
        : `Non-symbolic TrueType /Encoding is '${base ?? '(absent)'}', expected `
          + 'MacRomanEncoding or WinAnsiEncoding.',
    });
  }
  return issues;
};

/** 8.4.5.7-1 and -4: the embedded program's cmap subtables.
 *
 *  Non-symbolic needs (3,1) or (1,0); symbolic needs (3,0) or (1,0). Both are
 *  read through `SfntFont.cmapSubtable`, which returns exactly the NAMED
 *  subtable rather than the best Unicode one — the distinction that whole
 *  accessor exists for.
 *
 *  A font with no readable program is skipped: that is 8.4.5.5.1-1's defect,
 *  and reporting it here too would report twice for one fault. */
const trueTypeCmapRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'TrueType') continue;
    const prog = loadEmbeddedProgram(dict.get('FontDescriptor'), ...progArgs(ctx));
    const sfnt = prog.sfnt;
    if (sfnt === undefined) continue;
    const has = (p: number, e: number): boolean => sfnt.cmapSubtable(p, e) !== undefined;
    const symbolic = isSymbolic(ctx, dict.get('FontDescriptor'));
    if (!symbolic && !has(3, 1) && !has(1, 0)) {
      issues.push({
        rule: 'TrueTypeNonSymbolicCmap', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
        message: 'Non-symbolic TrueType program has neither a (3,1) nor a (1,0) '
          + 'cmap subtable.',
      });
    }
    if (symbolic && !has(3, 0) && !has(1, 0)) {
      issues.push({
        rule: 'TrueTypeSymbolicCmap', severity: 'error',
        clause: uaClause(ctx.part, { 2: '8.4.5.7' }), object: ref,
        message: 'Symbolic TrueType program has neither a (3,0) nor a (1,0) '
          + 'cmap subtable.',
      });
    }
  }
  return issues;
};

// ---- 8.4.5.3 and 8.4.5.4 — CIDFonts and CMaps -------------------------------

/** The predefined CMap names ISO 32000-2 Table 116 sanctions.
 *
 *  **Invariant: SIXTY-ONE, and this is NOT `predefcmap.ts`'s set.**
 *  `cmapdata.ts` bundles **195** predefined Adobe CMaps — every one Adobe
 *  published, including the deprecated Japan2 collection — where Table 116 is
 *  the subset PDF 2.0 still sanctions. "Do we have this CMap bundled" and "does
 *  PDF 2.0 sanction it" are different questions and the bundled set is three
 *  times the size; answering the first would silently pass 134 CMaps this rule
 *  exists to report. Transcribed from the profile's own test expression, which
 *  spells every name out.
 *
 *  Asserted by SIZE in `test/pdfua2-font-coverage.test.ts`, so a half-pasted
 *  list is a red build — the rule `htmlforeign.ts` sets for its five tables. */
const TABLE_116_CMAPS = new Set([
  'Identity-H', 'Identity-V',
  'GB-EUC-H', 'GB-EUC-V', 'GBpc-EUC-H', 'GBpc-EUC-V', 'GBK-EUC-H', 'GBK-EUC-V',
  'GBKp-EUC-H', 'GBKp-EUC-V', 'GBK2K-H', 'GBK2K-V',
  'UniGB-UCS2-H', 'UniGB-UCS2-V', 'UniGB-UTF16-H', 'UniGB-UTF16-V',
  'B5pc-H', 'B5pc-V', 'HKscs-B5-H', 'HKscs-B5-V', 'ETen-B5-H', 'ETen-B5-V',
  'ETenms-B5-H', 'ETenms-B5-V', 'CNS-EUC-H', 'CNS-EUC-V',
  'UniCNS-UCS2-H', 'UniCNS-UCS2-V', 'UniCNS-UTF16-H', 'UniCNS-UTF16-V',
  '83pv-RKSJ-H', '90ms-RKSJ-H', '90ms-RKSJ-V', '90msp-RKSJ-H', '90msp-RKSJ-V',
  '90pv-RKSJ-H', 'Add-RKSJ-H', 'Add-RKSJ-V', 'EUC-H', 'EUC-V',
  'Ext-RKSJ-H', 'Ext-RKSJ-V', 'H', 'V',
  'UniJIS-UCS2-H', 'UniJIS-UCS2-V', 'UniJIS-UCS2-HW-H', 'UniJIS-UCS2-HW-V',
  'UniJIS-UTF16-H', 'UniJIS-UTF16-V',
  'KSC-EUC-H', 'KSC-EUC-V', 'KSCms-UHC-H', 'KSCms-UHC-V',
  'KSCms-UHC-HW-H', 'KSCms-UHC-HW-V', 'KSCpc-EUC-H',
  'UniKS-UCS2-H', 'UniKS-UCS2-V', 'UniKS-UTF16-H', 'UniKS-UTF16-V',
]);

/** Exported for the census, which asserts the SIZE. @internal */
export const TABLE_116_SIZE = TABLE_116_CMAPS.size;

/** A PDF string's bytes as text. `/Registry` and `/Ordering` are byte strings
 *  naming an ASCII collection, so latin1 is exact for every real value. */
function stringOf(o: PdfObject | undefined): string | undefined {
  if (o === null || o === undefined) return undefined;
  const s = o as { kind?: string; bytes?: Uint8Array };
  if (s.kind !== 'string' || s.bytes === undefined) return undefined;
  return String.fromCharCode(...s.bytes);
}

/** The Type0 fonts of this document, with their `/Encoding` resolved once. */
function type0Fonts(
  ctx: UaCtx,
): { dict: PdfDict; ref?: PdfRef; enc: PdfObject }[] {
  const c = vctx(ctx);
  const out: { dict: PdfDict; ref?: PdfRef; enc: PdfObject }[] = [];
  for (const { dict, ref } of enumerateFonts(c)) {
    if (nameOf(c, dict, 'Subtype') !== 'Type0') continue;
    out.push({ dict, ref, enc: ctx.doc.resolve(dict.get('Encoding')) });
  }
  return out;
}

/** 8.4.5.4-1: a CMap outside Table 116 shall be embedded. */
const cmapEmbeddedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { ref, enc } of type0Fonts(ctx)) {
    // An embedded CMap is a STREAM; a predefined one is a NAME.
    if (isStream(enc)) continue;
    const cmapName = isName(enc) ? enc.name : undefined;
    if (cmapName !== undefined && TABLE_116_CMAPS.has(cmapName)) continue;
    issues.push({
      rule: 'CMapEmbedded', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.4' }), object: ref,
      message: `CMap '${cmapName ?? '(absent)'}' is not one of the predefined `
        + 'CMaps ISO 32000-2 Table 116 lists, and is not embedded.',
    });
  }
  return issues;
};

/** 8.4.5.4-2: an embedded CMap's /WMode shall match the one its stream dict
 *  states.
 *
 *  **Note absence is not a disagreement.** A stream dict that states no /WMode
 *  says nothing, and the CMap program's own value stands; presence is tested on
 *  the RAW dict, because `doc.resolve(undefined)` is `null`, which would read as
 *  a stated 0 and report every vertical CMap that declined to repeat itself. */
const cmapWModeRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { ref, enc } of type0Fonts(ctx)) {
    if (!isStream(enc)) continue;
    if (!enc.dict.has('WMode')) continue;
    const declared = ctx.doc.resolve(enc.dict.get('WMode'));
    if (typeof declared !== 'number') continue;
    const parsed = parseCidCMap(inflateStream(enc)).wmode;
    if (declared === parsed) continue;
    issues.push({
      rule: 'CMapWModeMatch', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.4' }), object: ref,
      message: `Embedded CMap stream states /WMode ${declared}, but the CMap `
        + `program declares ${parsed}.`,
    });
  }
  return issues;
};

/** 8.4.5.4-3: a CMap shall not reference a CMap outside Table 116.
 *
 *  The reference is the `/Name usecmap` in the CMap program, which
 *  `cidcmap.ts`'s parser already reports — re-implementing that grammar here is
 *  how the bundled data and a document's own CMap come to be read differently. */
const cmapReferenceRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { ref, enc } of type0Fonts(ctx)) {
    if (!isStream(enc)) continue;
    const used = parseCidCMap(inflateStream(enc)).usecmap;
    if (used === undefined || TABLE_116_CMAPS.has(used)) continue;
    issues.push({
      rule: 'CMapReference', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.4' }), object: ref,
      message: `Embedded CMap references '${used}', which is not one of the `
        + 'predefined CMaps ISO 32000-2 Table 116 lists.',
    });
  }
  return issues;
};

/** 8.4.5.3.2-1: an embedded CIDFontType2 shall state /CIDToGIDMap.
 *
 *  **Note the escape is the profile's own** (`containsFontFile == false`):
 *  reporting a missing map on a font with no program would report twice for one
 *  defect, which 8.4.5.5.1-1 already names. */
const cidToGidMapRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref } of type0Fonts(ctx)) {
    const cid = descendantFont(c, dict);
    if (cid === undefined) continue;
    if (nameOf(c, cid, 'Subtype') !== 'CIDFontType2') continue;
    if (cid.has('CIDToGIDMap')) continue;
    if (!hasFontProgram(c, cid.get('FontDescriptor'))) continue;
    issues.push({
      rule: 'CidToGidMap', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.3.2' }), object: ref,
      message: 'Embedded CIDFontType2 does not state /CIDToGIDMap.',
    });
  }
  return issues;
};

/** 8.4.5.3.1-1: a CIDFont's /CIDSystemInfo shall agree with the CMap's.
 *
 *  Registry and ordering must be EQUAL; the font's supplement must be no HIGHER
 *  than the CMap's — a font may be older than its CMap, never newer.
 *
 *  **Note the Identity exemption is the profile's own, by name.** Identity-H
 *  and Identity-V belong to no character collection, so there is nothing for a
 *  /CIDSystemInfo to agree with; every predefined Adobe CMap's registry is
 *  'Adobe', which is why `predefinedCMapInfo` reports an ordering and a
 *  supplement and no registry.
 *
 *  An EMBEDDED CMap states its own /CIDSystemInfo, read through the same
 *  `cidcmap.ts` parser rather than off the stream dict, so one owner answers
 *  what a CMap declares. */
const cidSystemInfoRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const { dict, ref, enc } of type0Fonts(ctx)) {
    let want: { registry?: string; ordering?: string; supplement?: number };
    if (isStream(enc)) {
      const parts = parseCidCMap(inflateStream(enc));
      want = { registry: parts.registry, ordering: parts.ordering, supplement: parts.supplement };
    } else if (isName(enc)) {
      if (enc.name === 'Identity-H' || enc.name === 'Identity-V') continue;
      const info = predefinedCMapInfo(enc.name);
      if (info === undefined) continue;   // 8.4.5.4-1's defect, not this one.
      want = { registry: 'Adobe', ordering: info.ordering, supplement: info.supplement };
    } else continue;

    const cid = descendantFont(c, dict);
    if (cid === undefined) continue;
    const csi = ctx.doc.resolve(cid.get('CIDSystemInfo'));
    if (!isDict(csi)) continue;
    const registry = stringOf(ctx.doc.resolve(csi.get('Registry')));
    const ordering = stringOf(ctx.doc.resolve(csi.get('Ordering')));
    const supplement = ctx.doc.resolve(csi.get('Supplement'));

    const bad: string[] = [];
    if (want.registry !== undefined && registry !== undefined && registry !== want.registry) {
      bad.push(`registry '${registry}' against '${want.registry}'`);
    }
    if (want.ordering !== undefined && ordering !== undefined && ordering !== want.ordering) {
      bad.push(`ordering '${ordering}' against '${want.ordering}'`);
    }
    if (want.supplement !== undefined && typeof supplement === 'number'
      && supplement > want.supplement) {
      bad.push(`supplement ${supplement} above the CMap's ${want.supplement}`);
    }
    if (bad.length === 0) continue;
    issues.push({
      rule: 'CidSystemInfoMatch', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.3.1' }), object: ref,
      message: `CIDFont /CIDSystemInfo disagrees with its CMap: ${bad.join('; ')}.`,
    });
  }
  return issues;
};

// ---- 8.4.5.5.1-2, 8.4.5.6, 8.4.5.8, 8.4.5.9 — the glyph rules ---------------

/** The code points 8.4.5.8-2 forbids a /ToUnicode value to contain: NUL, and
 *  the two byte-order marks, one of which is not even a valid character.
 *  Transcribed from the profile's own `toUnicode.indexOf(...)` tests — these
 *  are the three a consumer cannot render as text. */
const RESERVED_UNICODE = [' ', '﻿', '￾'];

/** The glyphs that are DRAWN — every distinct glyph except the invisible ones.
 *
 *  Render mode 3 is the OCR layer of a scanned page, and four of the five glyph
 *  rules exempt it. 8.4.5.9-1 deliberately does NOT and reads
 *  `distinctGlyphs` directly. */
const drawn = (ctx: UaCtx): DistinctGlyph[] =>
  distinctGlyphs(ctx).filter((g) => g.renderMode !== 3);

/** The embedded program behind a distinct glyph, plus the gid its code selects
 *  and the `/CIDToGIDMap` a composite font states. Loaded once per FONT rather
 *  than once per glyph — the dedup bounds the cost, but a document with many
 *  distinct glyphs in one font would still reload the program per glyph. */
interface FontProgram {
  prog: ReturnType<typeof loadEmbeddedProgram>;
  cidToGid?: Uint8Array;
  embedded: boolean;
}

const PROGRAMS = new WeakMap<UaCtx, Map<PdfDict, FontProgram>>();
function programOf(ctx: UaCtx, fontDict: PdfDict): FontProgram {
  let byFont = PROGRAMS.get(ctx);
  if (byFont === undefined) { byFont = new Map(); PROGRAMS.set(ctx, byFont); }
  let got = byFont.get(fontDict);
  if (got !== undefined) return got;

  const c = vctx(ctx);
  // A composite font's program and its /CIDToGIDMap live on the DESCENDANT.
  const isType0 = nameOf(c, fontDict, 'Subtype') === 'Type0';
  const owner = isType0 ? descendantFont(c, fontDict) ?? fontDict : fontDict;
  const fd = owner.get('FontDescriptor');
  const prog = loadEmbeddedProgram(fd, ...progArgs(ctx));
  let cidToGid: Uint8Array | undefined;
  const map = ctx.doc.resolve(owner.get('CIDToGIDMap'));
  if (isStream(map)) cidToGid = inflateStream(map);
  got = { prog, cidToGid, embedded: hasFontProgram(c, fd) };
  byFont.set(fontDict, got);
  return got;
}

/** The glyph id a distinct glyph selects in its embedded program, or
 *  `undefined` when the program defines none for it.
 *
 *  **Invariant:** a composite font goes through `gidForCid` and a simple one
 *  through `gidForProgram` — the split `glyphprogram.ts` owns. A code is not a
 *  CID except under Identity, and both numbers are valid glyph ids, so using
 *  one route for both draws a confident wrong answer rather than failing. */
function gidOf(ctx: UaCtx, g: DistinctGlyph): number | undefined {
  const { prog, cidToGid } = programOf(ctx, g.fontDict);
  const c = vctx(ctx);
  if (nameOf(c, g.fontDict, 'Subtype') === 'Type0') {
    return gidForCid(prog, g.cid, cidToGid);
  }
  return gidForProgram(prog, g.code, g.text, undefined);
}

/** 8.4.5.5.1-2: an embedded font shall define every glyph the document shows.
 *
 *  Only EMBEDDED fonts: a font with no program is 8.4.5.5.1-1's defect, and
 *  reporting it here too would report twice for one fault. `gidForProgram`
 *  answers `undefined` rather than 0 on a cmap miss, so this rule and
 *  8.4.5.9-1 below are disjoint by construction rather than by a check. */
const glyphNotPresentRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const g of drawn(ctx)) {
    const { prog, embedded } = programOf(ctx, g.fontDict);
    if (!embedded) continue;
    const gid = gidOf(ctx, g);
    const count = prog.sfnt?.numGlyphs;
    const missing = gid === undefined
      || (count !== undefined && count > 0 && gid >= count);
    if (!missing) continue;
    issues.push({
      rule: 'GlyphNotPresent', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.5.1' }),
      message: `The embedded font program defines no glyph for code ${g.code}.`,
    });
  }
  return issues;
};

/** 8.4.5.6-1: the width in the font dictionary and the width in the program
 *  shall agree within 1.
 *
 *  **Note the ONE place the two unit spaces meet.** `programAdvance` is already
 *  normalised to 1/1000 em — CLAUDE.md records that skipping that division
 *  reports a TrueType 2.048x too wide — while `dictWidth` is in em, so the
 *  dictionary value is multiplied by 1000 here and nowhere else.
 *
 *  It reads `dictWidth` and NOT `Glyph.width`, and a code the dictionary does
 *  not cover is skipped — the profile's own `widthFromDictionary == null`
 *  escape.
 *
 *  **Note, MEASURED, and it covers NOTHING — the plan predicted the opposite.**
 *  Falling back to `Glyph.width` where `dictWidth` is undefined reddens not one
 *  case, and PROVABLY cannot. `TextFont.advance` returns the dictionary's value
 *  wherever the dictionary has one, so for a COVERED code the two are equal;
 *  and where it has none, `advance` falls through to the very
 *  `programWidth`/`programAdvance` answer this rule compares against, so the
 *  comparison becomes the program against itself and is silent under both
 *  readings. Every remaining branch of `advance` (the AFM table, the estimate)
 *  is reached only when the program has no width for the code, where this rule
 *  has already skipped at `gid === undefined`.
 *
 *  `dictWidth` is retained as the honest spelling of the question the clause
 *  asks — "what does the DICTIONARY say" — and as defence if `advance`'s
 *  fallback order ever changes. Do not cite the green suite as covering it, and
 *  do not "simplify" it back to `Glyph.width`. */
const glyphWidthRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const c = vctx(ctx);
  const issues: ValidationIssue[] = [];
  for (const g of drawn(ctx)) {
    const { prog, embedded } = programOf(ctx, g.fontDict);
    if (!embedded) continue;
    const isType0 = nameOf(c, g.fontDict, 'Subtype') === 'Type0';
    const dict = g.font.dictWidth(isType0 ? g.cid : g.code);
    if (dict === undefined) continue;
    const gid = gidOf(ctx, g);
    if (gid === undefined) continue;          // 8.4.5.5.1-2's defect, not this one.
    const fromProgram = programAdvance(prog, gid);
    if (fromProgram === undefined) continue;
    const stated = dict * 1000;
    if (Math.abs(fromProgram - stated) <= 1) continue;
    issues.push({
      rule: 'GlyphWidthMismatch', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.6' }),
      message: `Code ${g.code} is ${stated.toFixed(0)} wide in the font `
        + `dictionary and ${fromProgram.toFixed(0)} in the font program.`,
    });
  }
  return issues;
};

/** 8.4.5.8-1: every code shown shall map to a Unicode value.
 *
 *  `Glyph.text` IS that composite answer — `/ToUnicode` first, then the
 *  encoding through the Adobe glyph list, then the CID collection's bundled
 *  table — which is the same chain veraPDF's `PDFont.toUnicode` walks. An empty
 *  string means no route reached one.
 *
 *  **Note what that makes a fixture for this rule:** a SIMPLE font always
 *  resolves through its encoding, so omitting `/ToUnicode` from one measures
 *  nothing. Only a composite font in the Identity ordering has no route at all.
 *  Measured, not reasoned about. */
const toUnicodeMissingRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const g of drawn(ctx)) {
    if (g.text !== '') continue;
    issues.push({
      rule: 'ToUnicodeMissing', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.8' }),
      message: `Code ${g.code} maps to no Unicode value.`,
    });
  }
  return issues;
};

/** 8.4.5.8-2: a Unicode value shall not contain U+0000, U+FEFF or U+FFFE. */
const toUnicodeReservedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const g of drawn(ctx)) {
    const bad = RESERVED_UNICODE.find((ch) => g.text.includes(ch));
    if (bad === undefined) continue;
    issues.push({
      rule: 'ToUnicodeReserved', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.8' }),
      message: `Code ${g.code} maps to a Unicode value containing U+`
        + `${bad.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}, `
        + 'which is reserved.',
    });
  }
  return issues;
};

/** 8.4.5.9-1: no text-showing operator shall reference .notdef.
 *
 *  **Invariant: this rule alone does NOT exempt render mode 3**, and it reads
 *  `distinctGlyphs` rather than `drawn`. The profile carries no such escape
 *  here: a .notdef in an invisible OCR layer still stands for text that is
 *  lost, and the exemption the other four carry is about INK rather than about
 *  meaning. It reads like an inconsistency, so it is asserted directly.
 *
 *  Glyph 0 is `.notdef` by definition in both sfnt and CFF. */
const notdefUsedRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const g of distinctGlyphs(ctx)) {
    if (!programOf(ctx, g.fontDict).embedded) continue;
    if (gidOf(ctx, g) !== 0) continue;
    issues.push({
      rule: 'NotdefUsed', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.5.9' }),
      message: `Code ${g.code} selects the .notdef glyph.`,
    });
  }
  return issues;
};

export const FONT_RULES: Rule[] = [
  fontNotEmbeddedRule, trueTypeSymbolicEncodingRule,
  trueTypeNonSymbolicEncodingRule, trueTypeCmapRules,
  cmapEmbeddedRule, cmapWModeRule, cmapReferenceRule,
  cidToGidMapRule, cidSystemInfoRule,
  glyphNotPresentRule, glyphWidthRule,
  toUnicodeMissingRule, toUnicodeReservedRule, notdefUsedRule,
];
