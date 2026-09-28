import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isRef, isStream } from './types.js';
import { matchStd14 } from './metrics.js';
import { standardEncodingNames, winAnsiEncodingNames, macRomanEncodingNames } from './encoding.js';
import { decodeStream } from './filters.js';
import { Type1Font } from './type1.js';
import { CffFont } from './cff.js';
import { rethrowLimit } from './errors.js';
import { budgetFor } from './decodebudget.js';

export interface UnembeddedFont {
  baseFont: string;
  /** Raw bytes of the program stream, when nothing else still references it
   *  (0 when another descriptor keeps it alive). */
  bytesSaved: number;
}

export interface UnembedSkip {
  baseFont: string;
  reason: string;
}

export interface UnembedResult {
  unembedded: UnembeddedFont[];
  skipped: UnembedSkip[];
  /** The font dicts whose program was removed, so the subsetting pass that runs
   *  next does not report them as "not embedded". */
  fonts: Set<PdfDict>;
}

const PROGRAM_KEYS = ['FontFile', 'FontFile2', 'FontFile3'] as const;
const BASE_ENCODINGS: ReadonlySet<string> = new Set(['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding']);

/** Every glyph name one of the three Latin base encodings names — a name a
 *  viewer's built-in Latin Standard-14 face is certain to define. */
const LATIN_NAMES: ReadonlySet<string> = new Set(
  [standardEncodingNames, winAnsiEncodingNames, macRomanEncodingNames]
    .flatMap((t) => t.filter((n): n is string => n !== undefined)),
);

const stripSubset = (n: string): string => (/^[A-Z]{6}\+/.test(n) ? n.slice(7) : n);

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
}

/** Every `/Type /Font` dict anywhere in the object graph, direct ones included —
 *  a descriptor shared with a font dict written inline must veto just as one
 *  shared with an indirect dict does. */
function allFontDicts(doc: Document): PdfDict[] {
  const out: PdfDict[] = [];
  const seen = new Set<object>();
  const visit = (o: PdfObject): void => {
    if (isArray(o)) { for (const v of o) visit(v); return; }
    if (isStream(o)) { visit(o.dict); return; }
    if (!isDict(o) || seen.has(o)) return;
    seen.add(o);
    if (nameOf(doc, o.get('Type')) === 'Font') out.push(o);
    for (const v of o.values()) visit(v);
  };
  for (const [, obj] of doc.objectEntries()) visit(obj);
  return out;
}

/** Whether a font dict's code -> glyph-name mapping stays the same when the
 *  program is replaced by a viewer's built-in Latin face, or why not. */
function encodingSurvives(doc: Document, font: PdfDict, program: PdfStream, key: string): string | undefined {
  const enc = doc.resolve(font.get('Encoding'));
  if (isName(enc)) return BASE_ENCODINGS.has(enc.name) ? undefined : `encoding ${enc.name} is not a Latin base encoding`;
  if (isDict(enc)) {
    // 9.6.6.1: a /Differences with no /BaseEncoding differs from the EMBEDDED
    // program's built-in encoding, which unembedding replaces with Standard.
    const base = nameOf(doc, enc.get('BaseEncoding'));
    if (base === undefined) return '/Differences has no /BaseEncoding, so it is relative to the embedded program';
    if (!BASE_ENCODINGS.has(base)) return `base encoding ${base} is not a Latin base encoding`;
    const diffs = doc.resolve(enc.get('Differences'));
    if (isArray(diffs)) {
      for (const d of diffs) {
        const r = doc.resolve(d);
        if (isName(r) && r.name !== '.notdef' && !LATIN_NAMES.has(r.name)) {
          return `/Differences names /${r.name}, which a built-in Standard-14 face may not define`;
        }
      }
    }
    return undefined;
  }
  if (enc !== undefined && enc !== null) return '/Encoding is neither a name nor a dictionary';

  // No /Encoding: the program's own built-in encoding governs, and unembedding
  // swaps it for StandardEncoding. Only a program that ALREADY uses Standard
  // keeps every code where it was.
  try {
    if (key === 'FontFile') {
      if (new Type1Font(decodeStream(program), budgetFor(program).limits).builtinEncodingNames() === undefined) return undefined;
    } else if (key === 'FontFile3' && nameOf(doc, program.dict.get('Subtype')) === 'Type1C') {
      if (new CffFont(decodeStream(program), budgetFor(program).limits).usesStandardEncoding()) return undefined;
    } else {
      return 'no /Encoding, and the embedded program\'s built-in encoding cannot be read';
    }
  } catch (caught) { rethrowLimit(caught); return 'no /Encoding, and the embedded program failed to parse'; }
  return 'no /Encoding, and the embedded program\'s built-in encoding is not StandardEncoding';
}

/** The object number of every indirect reference anywhere in the graph, counted. */
function refCounts(doc: Document): Map<number, number> {
  const counts = new Map<number, number>();
  const visit = (o: PdfObject): void => {
    if (isRef(o)) { counts.set(o.num, (counts.get(o.num) ?? 0) + 1); return; }
    if (isArray(o)) { for (const v of o) visit(v); return; }
    if (isStream(o)) { visit(o.dict); return; }
    if (isDict(o)) for (const v of o.values()) visit(v);
  };
  for (const [, obj] of doc.objectEntries()) visit(obj);
  visit(doc.trailer);
  return counts;
}

/**
 * Remove the embedded program of every simple `/Type1` font whose `/BaseFont`
 * names one of the twelve Latin Standard-14 faces exactly (a subset prefix
 * stripped) — every viewer draws those from built-in outlines. Only the
 * descriptor's `/FontFile*` key goes; `/Widths`, `/Encoding` and the descriptor
 * itself stay, so text keeps its advances.
 *
 * Declined, with the reason, whenever the swap could change what a code draws:
 * an encoding the embedded program defines, a `/Differences` name outside the
 * Latin sets, a descriptor shared with a font dict that does not qualify, the
 * symbolic faces (Symbol, ZapfDingbats — their built-in encodings are not
 * checkable here), and a document that declares PDF/A, where unembedding breaks
 * the conformance `ConvertToPdfA` established.
 */
export function unembedStandard14(doc: Document): UnembedResult {
  const result: UnembedResult = { unembedded: [], skipped: [], fonts: new Set() };

  // Group every font dict by the descriptor it reaches: the key is removed from
  // the DESCRIPTOR, so every dict sharing one must qualify.
  const groups = new Map<PdfDict, { fonts: PdfDict[]; std: PdfDict[]; veto?: string }>();
  for (const font of allFontDicts(doc)) {
    const fd = doc.resolve(font.get('FontDescriptor'));
    if (!isDict(fd) || !PROGRAM_KEYS.some((k) => isStream(doc.resolve(fd.get(k))))) continue;
    let g = groups.get(fd);
    if (!g) { g = { fonts: [], std: [] }; groups.set(fd, g); }
    g.fonts.push(font);
    const base = stripSubset(nameOf(doc, font.get('BaseFont')) ?? '');
    const std = matchStd14(base) === base ? base : undefined;
    if (std === undefined) { g.veto ??= 'its font descriptor is shared with a font that is not Standard-14'; continue; }
    g.std.push(font);
  }

  const pdfa = doc.GetXmp().pdfaPart;
  let counts: Map<number, number> | undefined;

  for (const [fd, g] of groups) {
    if (g.std.length === 0) continue;                    // a custom face: silently untouched
    const baseFont = nameOf(doc, g.std[0].get('BaseFont')) ?? '(unnamed)';
    const skip = (reason: string): void => { result.skipped.push({ baseFont, reason }); };
    if (pdfa !== undefined) { skip(`document declares PDF/A-${pdfa}, which requires embedded fonts`); continue; }
    if (g.veto) { skip(g.veto); continue; }

    const key = PROGRAM_KEYS.find((k) => isStream(doc.resolve(fd.get(k))))!;
    const program = doc.resolve(fd.get(key)) as PdfStream;
    let why: string | undefined;
    for (const font of g.std) {
      const base = stripSubset(nameOf(doc, font.get('BaseFont'))!);
      if (base === 'Symbol' || base === 'ZapfDingbats') { why = `${base} is a symbolic face whose built-in encoding cannot be checked`; break; }
      if (nameOf(doc, font.get('Subtype')) !== 'Type1') { why = 'not a simple /Type1 font'; break; }
      why = encodingSurvives(doc, font, program, key);
      if (why) break;
    }
    if (why) { skip(why); continue; }

    counts ??= refCounts(doc);
    const raw = fd.get(key);
    // The program is saved only if this descriptor held its last reference.
    const saved = isRef(raw) && counts.get(raw.num) === 1 ? program.raw.length : 0;
    fd.delete(key);
    if (isRef(raw)) counts.set(raw.num, (counts.get(raw.num) ?? 1) - 1);
    result.unembedded.push({ baseFont, bytesSaved: saved });
    for (const f of g.fonts) result.fonts.add(f);
  }
  return result;
}
