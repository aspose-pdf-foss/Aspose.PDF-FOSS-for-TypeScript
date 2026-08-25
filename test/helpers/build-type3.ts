// Type 3 font fixtures: a font whose glyphs are content streams in /CharProcs,
// drawn in glyph space and mapped to text space by /FontMatrix.
//
// The default font matrix is deliberately NOT the 1/1000 one every other font
// uses: at 1/100 a glyph-space width of 100 is one text-space em, so a renderer
// that divides /Widths by 1000 places the second glyph in the middle of the
// first rather than beside it.

import { buildSvgPdf } from './build-svg-fixtures.js';

const enc = (s: string) => new TextEncoder().encode(s);

export interface Type3Opts {
  /** Page content stream. Default: two glyphs of the default font at (20,20). */
  content?: string;
  /** /FontMatrix entries. Default `0.01 0 0 0.01 0 0` (glyph space = 1/100). */
  fontMatrix?: string;
  /** The glyph procedure for code 97 (`a`). Default: a filled 100x100 box. */
  charProc?: string;
  /** /Widths, in glyph space. Default `[100]` for the single code 97. */
  widths?: string;
  /** The font's own /Resources dict body. Default an empty dict. */
  fontResources?: string;
  /** Page /Resources body. Default: /Font << /T3 5 0 R >>. */
  pageResources?: string;
  /** Extra objects, numbered from 8 up. */
  extra?: Record<number, string | { dict: string; raw: Uint8Array }>;
}

/** A one-page PDF showing text in a Type 3 font. Object 5 is the font, 6 its
 *  /CharProcs dict and 7 the glyph procedure for code 97. */
export function type3Pdf(opts: Type3Opts = {}): Uint8Array {
  const proc = enc(opts.charProc ?? '100 0 0 0 100 100 d1 0 0 100 100 re f');
  return buildSvgPdf({
    mediaBox: [0, 0, 200, 200],
    resources: opts.pageResources ?? '<< /Font << /T3 5 0 R >> >>',
    content: opts.content ?? 'BT /T3 50 Tf 1 0 0 rg 20 20 Td (aa) Tj ET',
    extra: {
      5: '<< /Type /Font /Subtype /Type3'
        + ` /FontBBox [0 0 100 100] /FontMatrix [${opts.fontMatrix ?? '0.01 0 0 0.01 0 0'}]`
        + ' /CharProcs 6 0 R /Encoding << /Type /Encoding /Differences [97 /square] >>'
        + ` /FirstChar 97 /LastChar 97 /Widths ${opts.widths ?? '[100]'}`
        + ` /Resources ${opts.fontResources ?? '<< >>'} >>`,
      6: '<< /square 7 0 R >>',
      7: { dict: `<< /Length ${proc.length} >>`, raw: proc },
      ...opts.extra,
    },
  });
}
