import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfStream, isDict, isStream, isName, isArray,
} from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { collectGlyphUsage, UsageMap } from './glyphusage.js';
import { shrinkGlyf, shrinkCff, shrinkNameKeyedCff, ShrinkResult } from './fontshrink.js';
import { dedupStreams } from './dedup.js';
import { recompressStreams } from './recompress.js';
import { optimizeImages, OptimizeImageOptions, ImageOptimization, SkippedImage } from './imageopt.js';
import { pruneDefaultResources, DrPruneResult } from './drprune.js';
import { parseSfnt } from './sfnt.js';
import { hasSignatureField } from './signature.js';
import { decodeStream, encodeStream } from './filters.js';

/** Which concerns to run. fonts/dedup/compress are lossless and default to true;
 *  `images` is LOSSY and runs only when supplied. */
export interface OptimizeOptions {
  fonts?: boolean;
  dedup?: boolean;
  compress?: boolean;
  /** Prune /AcroForm /DR entries nothing in the document names. Lossless. */
  dr?: boolean;
  /** LOSSY: recompress images to JPEG. Off unless set. There is deliberately no
   *  `true` shorthand — it would mean "degrade my images at settings I did not
   *  choose". */
  images?: OptimizeImageOptions;
}

export type { OptimizeImageOptions, ImageOptimization, SkippedImage, DrPruneResult };

export interface FontOptimization {
  baseFont: string;
  gidsKept: number;
  gidsDropped: number;
  bytesSaved: number;
}

export interface SkippedFont {
  baseFont: string;
  reason: string;
}

export interface OptimizeReport {
  fonts: FontOptimization[];
  /** Fonts left untouched, and why. The first place to look when Optimize
   *  under-delivers. */
  skipped: SkippedFont[];
  /** Images recompressed. Empty unless `images` was supplied. */
  images: ImageOptimization[];
  /** Images left untouched, and why. */
  skippedImages: SkippedImage[];
  /** True when the images concern ran: output is no longer visually identical. */
  lossy: boolean;
  dedup: { merged: number; bytesSaved: number };
  compress: { streams: number; bytesSaved: number };
  /** /AcroForm /DR entries removed, and the bytes that orphaned. */
  dr: DrPruneResult;
  /** Estimated: the sum of per-stream raw byte deltas. Not a file-size delta —
   *  only Save() produces bytes. */
  bytesSaved: number;
}

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
}

const baseFontOf = (doc: Document, font: PdfDict): string =>
  nameOf(doc, font.get('BaseFont')) ?? '(unnamed)';

/** The descendant CIDFont of a Type0, or the font itself for a simple font. */
function descendantOf(doc: Document, font: PdfDict): PdfDict {
  const desc = doc.resolve(font.get('DescendantFonts'));
  if (isArray(desc)) {
    const d0 = doc.resolve(desc[0]);
    if (isDict(d0)) return d0;
  }
  return font;
}

interface FontProgram { descriptor: PdfDict; key: 'FontFile2' | 'FontFile3'; stream: PdfStream }

/** Locate a font's embedded program: its descriptor key and stream. */
function fontProgram(doc: Document, font: PdfDict): FontProgram | undefined {
  const fd = doc.resolve(descendantOf(doc, font).get('FontDescriptor'));
  if (!isDict(fd)) return undefined;
  for (const key of ['FontFile2', 'FontFile3'] as const) {
    const s = doc.resolve(fd.get(key));
    if (isStream(s)) return { descriptor: fd, key, stream: s };
  }
  return undefined;
}

/** Font subtypes that never resolve a glyph by name: a Type0 goes code -> CID ->
 *  GID through `/CIDToGIDMap` or a CFF charset.
 *
 *  The CIDFont descendants are excluded for the same reason, and excluding them
 *  is load-bearing rather than tidy: a Type0's `/FontDescriptor` hangs off its
 *  descendant, not off the Type0 dict itself (see `fontProgram`, which reaches it
 *  via `descendantOf`). A descendant is a `/Type /Font` dict with
 *  `/Subtype /CIDFontType2` — "not Type0" — so a rule that excluded only `Type0`
 *  would veto every Type0 program through its own descendant and quietly reduce
 *  this whole pass to a no-op. A descendant is only ever reachable through its
 *  Type0 parent, which already stands in for it (glyphusage.ts:382-388 documents
 *  the same trap for the usage scan). */
const NAME_FREE_SUBTYPES: ReadonlySet<string> = new Set(['Type0', 'CIDFontType0', 'CIDFontType2']);

/**
 * Font dicts whose program no font dict can resolve glyphs by name against, and
 * whose `post` names are therefore safe to drop. A dict outside
 * NAME_FREE_SUBTYPES vetoes the program it reaches — including one with an
 * unrecognized `/Subtype`, which vetoes by default — and that veto covers every
 * other dict reaching the same program.
 *
 * The veto is decided per program but *answered* per font dict, and both happen
 * here, before `optimizeFonts` mutates anything. That ordering is the whole point:
 * `shrinkOne` replaces a shrunk program with a freshly allocated stream, so when
 * two font dicts share a `/FontDescriptor`, the second dict resolves to a stream
 * the first pass just created. A set keyed on stream identity and consulted at
 * shrink time cannot recognize it, silently drops the names, and defeats itself
 * on precisely the shared-program case it exists to protect. Resolving every
 * program up front, on the pristine graph, and handing back plain dict membership
 * keeps stream churn out of the answer.
 *
 * The scan walks the whole object graph rather than reading `collectGlyphUsage`'s
 * UsageMap, which would answer this today — its safety net already sweeps in every
 * unreached font dict. That reuse is declined on purpose: it would make this
 * veto's correctness a downstream effect of a net written for another purpose,
 * which a later change could narrow with no signal here and a silent, visual
 * failure.
 */
function glyphNameDroppableFonts(doc: Document): Set<PdfDict> {
  const programOf = new Map<PdfDict, PdfStream>();
  const vetoed = new Set<PdfStream>();

  for (const [, obj] of doc.objectEntries()) {
    if (!isDict(obj)) continue;
    if (nameOf(doc, obj.get('Type')) !== 'Font') continue;
    const prog = fontProgram(doc, obj);
    if (!prog) continue;
    programOf.set(obj, prog.stream);
    const subtype = nameOf(doc, obj.get('Subtype'));
    if (subtype === undefined || !NAME_FREE_SUBTYPES.has(subtype)) vetoed.add(prog.stream);
  }

  const droppable = new Set<PdfDict>();
  for (const [font, stream] of programOf) if (!vetoed.has(stream)) droppable.add(font);
  return droppable;
}

/** Shrink one font program in place; a reason string when it cannot be handled. */
function shrinkOne(
  doc: Document, prog: FontProgram, gids: Set<number>, dropGlyphNames: boolean,
): { result: ShrinkResult; bytesSaved: number } | { reason: string } {
  let plain: Uint8Array;
  try { plain = decodeStream(prog.stream); }
  catch { return { reason: 'font program failed to decode' }; }

  let result: ShrinkResult;
  try {
    if (prog.key === 'FontFile2') {
      result = shrinkGlyf(parseSfnt(plain), gids, { dropGlyphNames });
    } else {
      const sub = nameOf(doc, prog.stream.dict.get('Subtype'));
      // CID-keyed and name-keyed CFFs resolve in opposite directions, and each
      // needs the shrink that preserves its own chain: shrinkCff re-assembles
      // CID-keyed, which would leave a simple font dict with no names to resolve
      // against. See shrinkNameKeyedCff.
      if (sub === 'CIDFontType0C') result = shrinkCff(plain, gids);
      else if (sub === 'Type1C') result = shrinkNameKeyedCff(plain, gids);
      else if (sub === 'OpenType') {
        const f = parseSfnt(plain);
        if (f.outlines !== 'glyf') return { reason: 'OpenType FontFile3 is CFF-outlined' };
        result = shrinkGlyf(f, gids, { dropGlyphNames });
      } else return { reason: `unsupported FontFile3 subtype: ${sub ?? 'none'}` };
    }
  } catch (e) {
    return { reason: `shrink failed: ${(e as Error).message}` };
  }

  const extra: PdfDict = new Map(prog.stream.dict);
  extra.delete('Filter');
  extra.delete('DecodeParms');
  extra.delete('DP');
  extra.delete('Length');
  if (prog.key === 'FontFile2') extra.set('Length1', result.bytes.length);
  const replacement = encodeStream(result.bytes, 'FlateDecode', extra);
  const bytesSaved = prog.stream.raw.length - replacement.raw.length;
  // Blanking trades glyph bytes against fixed rebuild overhead (for CFF, the
  // CID-keyed wrapper). On a small font that trade can lose, so keep the
  // original unless the rewrite is strictly smaller — same rule as recompress.
  if (bytesSaved <= 0) return { reason: 'shrunk program would not be smaller' };
  prog.descriptor.set(prog.key, doc.allocObject(replacement));
  return { result, bytesSaved };
}

/** Every font dict that reaches one program, and what they jointly need from it. */
interface ProgramGroup {
  prog: FontProgram;
  fonts: PdfDict[];
  /** The union of the gid sets of every dict in `fonts`. */
  gids: Set<number>;
  /** Set when any dict's usage is incomplete: the whole program is then off
   *  limits, since that dict could have shown any glyph in it. */
  incomplete?: string;
}

/**
 * Group the usage map by program identity rather than by font dict.
 *
 * A program is what gets shrunk, and one program can serve several font dicts —
 * a producer embedding a face once and referencing it from both a Type0 and a
 * simple dict, or from two simple dicts with different `/Encoding`s. Shrinking
 * per dict would run once per dict against the *previous pass's output*, so each
 * pass narrows the program to its own gid set and the survivors are the
 * intersection: glyphs the other dicts show get blanked, silently and visually.
 *
 * Grouping happens up front, on the pristine graph, for the same reason
 * `glyphNameDroppableFonts` resolves early — `shrinkOne` replaces a program with
 * a freshly allocated stream, so stream identity is only a reliable key before
 * any shrink runs.
 */
function groupByProgram(doc: Document, usage: UsageMap, report: OptimizeReport): ProgramGroup[] {
  const groups = new Map<PdfStream, ProgramGroup>();
  for (const [font, u] of usage) {
    const prog = fontProgram(doc, font);
    if (!prog) {
      // Nothing to shrink and nothing to veto. An incomplete scan of a font with
      // no program still says more about why than the missing program does.
      report.skipped.push({
        baseFont: baseFontOf(doc, font),
        reason: u.complete ? 'font program is not embedded' : u.reason ?? 'usage could not be determined',
      });
      continue;
    }
    let g = groups.get(prog.stream);
    if (!g) { g = { prog, fonts: [], gids: new Set() }; groups.set(prog.stream, g); }
    g.fonts.push(font);
    if (!u.complete) g.incomplete ??= u.reason ?? 'usage could not be determined';
    else for (const gid of u.gids) g.gids.add(gid);
  }
  return [...groups.values()];
}

function optimizeFonts(doc: Document, report: OptimizeReport): void {
  // Must precede every shrink: shrinkOne swaps in a new program stream, which
  // this answer must not depend on. See glyphNameDroppableFonts.
  const nameDroppable = glyphNameDroppableFonts(doc);
  const usage: UsageMap = collectGlyphUsage(doc);
  for (const g of groupByProgram(doc, usage, report)) {
    // One program, one entry: reporting per dict would double-count the bytes a
    // single shrink saved.
    const baseFont = baseFontOf(doc, g.fonts[0]);
    if (g.incomplete !== undefined) {
      report.skipped.push({ baseFont, reason: g.incomplete });
      continue;
    }
    // Names are droppable only when every dict reaching the program licenses it.
    const dropNames = g.fonts.every((f) => nameDroppable.has(f));
    const out = shrinkOne(doc, g.prog, g.gids, dropNames);
    if ('reason' in out) { report.skipped.push({ baseFont, reason: out.reason }); continue; }
    report.fonts.push({
      baseFont,
      gidsKept: out.result.gidsKept,
      gidsDropped: out.result.gidsDropped,
      bytesSaved: out.bytesSaved,
    });
  }
}

/**
 * Shrink the live model. Passes run images -> fonts -> dedup -> compress: images
 * and fonts rewrite stream payloads, dedup then merges payloads those passes just
 * made identical, and compress re-deflates the rest.
 *
 * Lossless unless `opts.images` is supplied, which enables a lossy JPEG
 * recompression pass; `report.lossy` records whether it ran.
 */
export function optimizeDocument(doc: Document, opts: OptimizeOptions = {}): OptimizeReport {
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      'Optimize would invalidate an existing signature; optimize before signing',
    );
  }
  const report: OptimizeReport = {
    fonts: [], skipped: [],
    images: [], skippedImages: [],
    lossy: false,
    dedup: { merged: 0, bytesSaved: 0 },
    compress: { streams: 0, bytesSaved: 0 },
    dr: { removed: [], bytesSaved: 0 },
    bytesSaved: 0,
  };

  // First of all the passes. A /DR entry this removes orphans a font program,
  // and running later means optimizeFonts shrinks that program and
  // recompressStreams re-deflates it — both reporting bytesSaved for bytes the
  // output file never contains.
  if (opts.dr ?? true) report.dr = pruneDefaultResources(doc);

  // Images run first for the same reason fonts precede dedup: a pass that
  // rewrites stream payloads must run before dedup, so dedup can merge the
  // payloads it just made byte-identical (a photo repeated once per page
  // recompresses to N identical streams). compress then skips the DCT streams
  // this wrote, since re-wrapping an image codec only grows it.
  if (opts.images) {
    const r = optimizeImages(doc, opts.images);
    report.images = r.images;
    report.skippedImages = r.skippedImages;
    report.lossy = true;
  }
  if (opts.fonts ?? true) optimizeFonts(doc, report);
  if (opts.dedup ?? true) report.dedup = dedupStreams(doc);
  if (opts.compress ?? true) report.compress = recompressStreams(doc);

  report.bytesSaved =
    report.fonts.reduce((n, f) => n + f.bytesSaved, 0) +
    report.images.reduce((n, i) => n + i.bytesSaved, 0) +
    report.dr.bytesSaved + report.dedup.bytesSaved + report.compress.bytesSaved;
  doc.markModified();
  return report;
}
