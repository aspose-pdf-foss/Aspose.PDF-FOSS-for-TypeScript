import type { Document } from '../../src/document.js';
import { isDict, type PdfDict } from '../../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

interface Obj { [n: number]: string }

/** Serialize numbered objects (1..maxObj) into a classic-xref PDF. */
function serialize(objects: Obj, maxObj: number, rootInfo = '/Root 1 0 R'): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} ${rootInfo} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function contentObj(stream: string): string {
  return `<< /Length ${byteLen(stream)} >>\nstream\n${stream}\nendstream`;
}

/** Page with a single simple Type1 font (F1) and a given content stream. The
 *  font carries no /Widths, so it exercises the Standard-14 metrics path.
 *  `encoding: null` omits /Encoding entirely (the font's built-in governs). */
export function buildSimpleTextPdf(
  stream: string,
  opts: { encoding?: string | null; baseFont?: string; differences?: string } = {},
): Uint8Array {
  const e = opts.encoding === undefined ? 'WinAnsiEncoding' : opts.encoding;
  const enc = opts.differences !== undefined
    ? `/Encoding << /Type /Encoding ${e ? `/BaseEncoding /${e} ` : ''}/Differences [${opts.differences}] >> `
    : e ? `/Encoding /${e} ` : '';
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /${opts.baseFont ?? 'Helvetica'} ${enc}>>`,
  };
  return serialize(objects, 5);
}

/**
 * A non-embedded simple font carrying a `/FontDescriptor` with `/Flags`.
 *
 * The shape a real symbol font takes: `/Wingdings-Regular`, `/Flags 4`
 * (Symbolic), NO `/Encoding` — its codes index the font's own symbol cmap and
 * mean nothing outside it. `encoding` states one, which is what a mis-flagged
 * TEXT font does and what must keep rendering as letters.
 */
export function buildDescriptorFontPdf(
  stream: string,
  opts: { baseFont: string; flags: number; encoding?: string; differences?: string },
): Uint8Array {
  const enc = opts.differences !== undefined
    ? `/Encoding << /Type /Encoding ${opts.encoding ? `/BaseEncoding /${opts.encoding} ` : ''}/Differences [${opts.differences}] >> `
    : opts.encoding ? `/Encoding /${opts.encoding} ` : '';
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /TrueType /BaseFont /${opts.baseFont} ${enc}/FontDescriptor 6 0 R >>`,
    6: `<< /Type /FontDescriptor /FontName /${opts.baseFont} /Flags ${opts.flags} `
       + `/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 `
       + `/FontBBox [0 -200 1000 800] >>`,
  };
  return serialize(objects, 6);
}

/** Page whose font carries a /ToUnicode CMap (uncompressed). */
export function buildToUnicodePdf(stream: string, cmap: string): Uint8Array {
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /AAAAAA+Foo /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>`,
    6: contentObj(cmap),
  };
  return serialize(objects, 6);
}

/** Page with a Type0 Identity-H font + ToUnicode (2-byte codes). */
export function buildType0Pdf(
  stream: string, cmap: string,
  opts: { baseFont?: string; ordering?: string; toUnicode?: boolean } = {},
): Uint8Array {
  // Defaults reproduce the pre-lqcs.2 strings EXACTLY, so every existing caller
  // is byte-identical.
  const base = opts.baseFont ?? 'AAAAAA+Foo';
  const ordering = opts.ordering ?? 'Identity';
  const tu = opts.toUnicode === false ? '' : ' /ToUnicode 6 0 R';
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [7 0 R]${tu} >>`,
    6: contentObj(cmap),
    7: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 0 >> >>`,
  };
  return serialize(objects, 7);
}

/** The /F1 font dict of a fixture built by this module, opened and resolved. */
export function fontDictOf(doc: Document): PdfDict {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  if (!isDict(fonts)) throw new Error('fixture has no /Font');
  const f1 = doc.resolve(fonts.get('F1'));
  if (!isDict(f1)) throw new Error('fixture has no /F1');
  return f1;
}

/** Simple Type1 font (F1) carrying /FirstChar + /Widths. */
export function buildSimpleTextPdfWithWidths(
  stream: string, firstChar: number, widths: number[],
): Uint8Array {
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ` +
       `/FirstChar ${firstChar} /Widths [${widths.join(' ')}] >>`,
  };
  return serialize(objects, 5);
}

/** Multiple pages sharing one simple Type1 font (F1), one content stream each. */
export function buildMultiPageTextPdf(streams: string[]): Uint8Array {
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    3: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  };
  const kids: string[] = [];
  streams.forEach((stream, i) => {
    const pageObj = 4 + 2 * i;
    const contentObjNum = 5 + 2 * i;
    kids.push(`${pageObj} 0 R`);
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum} 0 R >>`;
    objects[contentObjNum] = contentObj(stream);
  });
  objects[2] = `<< /Type /Pages /Count ${streams.length} /Kids [${kids.join(' ')}] /MediaBox [0 0 300 300] >>`;
  return serialize(objects, 3 + 2 * streams.length);
}

/** Page with NO text-showing operators: a single image XObject /Im0 placed by a
 *  `cm` so it occupies device-space [50,50,150,150]. */
export function buildImageOnlyPdf(): Uint8Array {
  const stream = `q 100 0 0 100 50 50 cm /Im0 Do Q`;
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ` +
       `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream`,
  };
  return serialize(objects, 5);
}
