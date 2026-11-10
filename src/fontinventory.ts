// The document's font inventory (g0ky.1), behind `doc.Fonts`: every font a
// page's resources reach, with what it is, whether it is embedded, and which
// pages declare it and which actually draw with it.
//
// **Invariant:** it is NOT a third font walk. Which fonts exist, and which
// pages DECLARE them, is `validatectx.ts`'s `enumerateFonts` -- the walk the
// PDF/A, PDF/X and PDF/UA rules already share -- and which pages DRAW with one
// is `visitContent`'s glyph events, joined through `TextFont.dict`, which is
// the very dict `enumerateFonts` yields (`visitContent` memoizes a TextFont
// per dict). Two walks deciding "which fonts does this document have" is how
// a validator and an inventory come to disagree.

import type { Document } from './document.js';
import { isArray, isDict, isName, isStream, type PdfDict, type PdfObject } from './types.js';
import { enumerateFonts, descendantFont, hasFontProgram, type Ctx } from './validatectx.js';
import { visitContent } from './text.js';
import { rethrowLimit } from './errors.js';

/** What kind of font program a font embeds: the descriptor key and, for
 *  `/FontFile3`, its `/Subtype` (32000-1 Table 124). `Type3` for a Type 3
 *  font, whose glyphs are content streams in the document itself. */
export type FontProgramKind = 'Type1' | 'TrueType' | 'Type1C' | 'CIDFontType0C' | 'OpenType' | 'Type3';

/** One font of {@link Document.Fonts}. */
export interface DocumentFont {
  /** `/BaseFont` without its subset tag, e.g. `Arial-BoldMT`. Undefined when
   *  the font names none (a Type 3 font may not). */
  name?: string;
  /** The six-letter subset tag (`ABCDEF` of `ABCDEF+Arial`), when present. */
  subsetTag?: string;
  /** `/Subtype`: `Type1`, `MMType1`, `TrueType`, `Type3` or `Type0`. */
  subtype?: string;
  /** For a `Type0` font, its descendant's `/Subtype`: `CIDFontType0` or
   *  `CIDFontType2`. */
  descendantSubtype?: string;
  /** Whether the document carries the glyphs: an embedded program, or a Type 3
   *  font's glyph procedures. */
  embedded: boolean;
  /** The embedded program's kind; undefined when nothing is embedded, or when
   *  a `/FontFile3` names a `/Subtype` outside the three the format defines. */
  program?: FontProgramKind;
  /** The encoding as named: a predefined name (`WinAnsiEncoding`,
   *  `Identity-H`), the `/BaseEncoding` of an encoding dictionary, or an
   *  embedded CMap's `/CMapName`. Undefined when the font states none and
   *  uses its built-in encoding. */
  encoding?: string;
  /** True when the encoding is customised: an encoding dictionary with
   *  `/Differences`, or an embedded CMap stream. */
  customEncoding: boolean;
  /** 1-based pages whose resources (forms included) declare the font. */
  declaredOn: number[];
  /** 1-based pages whose content (forms included) draws at least one glyph in
   *  it -- a subset of `declaredOn` in a well-formed document. A font declared
   *  and never drawn has `usedOn: []`. */
  usedOn: number[];
  /** The live font dictionary. */
  dict: PdfDict;
}

/** Implementation of {@link Document.Fonts}. */
export function documentFonts(doc: Document): DocumentFont[] {
  const ctx: Ctx = {
    doc, catalog: doc.catalog(), R: (o) => doc.resolve(o), cache: new Map(),
  };
  const fonts = enumerateFonts(ctx);
  const used = new Map<PdfDict, number[]>();
  doc.Pages.forEach((page, i) => {
    try {
      visitContent(doc, page, {
        glyph: (e) => {
          const d = e.font.dict;
          const list = used.get(d) ?? [];
          if (list[list.length - 1] !== i + 1) list.push(i + 1);
          used.set(d, list);
        },
      });
    } catch (caught) { rethrowLimit(caught);
      // A page whose content will not walk draws nothing we can attribute.
    }
  });
  return fonts.map(({ dict, pages }) => describe(ctx, dict, pages, used.get(dict) ?? []));
}

const nameOf = (ctx: Ctx, o: PdfObject | undefined): string | undefined => {
  const r = ctx.R(o);
  return isName(r) ? r.name : undefined;
};

function describe(ctx: Ctx, dict: PdfDict, declaredOn: number[], usedOn: number[]): DocumentFont {
  const subtype = nameOf(ctx, dict.get('Subtype'));
  const base = nameOf(ctx, dict.get('BaseFont'));
  const tagged = base === undefined ? undefined : /^([A-Z]{6})\+(.+)$/.exec(base);
  const desc = subtype === 'Type0' ? descendantFont(ctx, dict) : undefined;
  const fd = (desc ?? dict).get('FontDescriptor');
  const program = subtype === 'Type3' ? 'Type3' : programKind(ctx, fd);
  const { encoding, customEncoding } = encodingOf(ctx, dict.get('Encoding'));
  return {
    name: tagged ? tagged[2] : base,
    subsetTag: tagged ? tagged[1] : undefined,
    subtype,
    descendantSubtype: desc ? nameOf(ctx, desc.get('Subtype')) : undefined,
    embedded: subtype === 'Type3' || hasFontProgram(ctx, fd),
    program,
    encoding,
    customEncoding,
    declaredOn: [...declaredOn],
    usedOn,
    dict,
  };
}

/** The program a font descriptor embeds, by the key it is stored under. */
function programKind(ctx: Ctx, fdObj: PdfObject | undefined): FontProgramKind | undefined {
  const fd = ctx.R(fdObj);
  if (!isDict(fd)) return undefined;
  if (isStream(ctx.R(fd.get('FontFile')))) return 'Type1';
  if (isStream(ctx.R(fd.get('FontFile2')))) return 'TrueType';
  const ff3 = ctx.R(fd.get('FontFile3'));
  if (!isStream(ff3)) return undefined;
  const st = nameOf(ctx, ff3.dict.get('Subtype'));
  return st === 'Type1C' || st === 'CIDFontType0C' || st === 'OpenType' ? st : undefined;
}

function encodingOf(ctx: Ctx, o: PdfObject | undefined): { encoding?: string; customEncoding: boolean } {
  const e = ctx.R(o);
  if (isName(e)) return { encoding: e.name, customEncoding: false };
  if (isStream(e)) return { encoding: nameOf(ctx, e.dict.get('CMapName')), customEncoding: true };
  if (isDict(e)) {
    const diffs = ctx.R(e.get('Differences'));
    return { encoding: nameOf(ctx, e.get('BaseEncoding')), customEncoding: isArray(diffs) && diffs.length > 0 };
  }
  return { customEncoding: false };
}
