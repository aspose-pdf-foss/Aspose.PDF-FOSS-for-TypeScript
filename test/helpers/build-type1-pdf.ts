// A one-page PDF whose only font is an embedded Type 1 program under /FontFile.
// Byte-based rather than string-based like build-pdf.ts's buildClassicPdf: the
// program is binary, so the xref offsets must be counted in bytes and the
// stream written verbatim.
import { fontFileLengths } from './build-type1.js';

const enc = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface Type1PdfOptions {
  text: string;
  size: number;
  /** A base encoding name for the font dict's /Encoding, e.g. 'WinAnsiEncoding'.
   *  Omitted => no /Encoding, so the program's own encoding governs. */
  encoding?: string;
  /** [code, glyphName] pairs for an /Encoding /Differences array. */
  differences?: [number, string][];
  /** Omit /Widths entirely, so the font must measure from its own program. */
  omitWidths?: boolean;
}

export function buildType1Pdf(program: Uint8Array, opts: Type1PdfOptions): Uint8Array {
  const { l1, l2, l3 } = fontFileLengths(program);
  const content = `BT /F1 ${opts.size} Tf 10 20 Td (${opts.text}) Tj ET`;

  let encEntry = '';
  if (opts.differences) {
    const items = opts.differences.map(([c, n]) => `${c} /${n}`).join(' ');
    const be = opts.encoding ? ` /BaseEncoding /${opts.encoding}` : '';
    encEntry = ` /Encoding << /Type /Encoding${be} /Differences [${items}] >>`;
  } else if (opts.encoding) {
    encEntry = ` /Encoding /${opts.encoding}`;
  }

  // 1 Catalog, 2 Pages, 3 Page, 4 Font, 5 Contents, 6 FontDescriptor, 7 FontFile
  const objs: Uint8Array[] = [];
  objs[1] = enc('<< /Type /Catalog /Pages 2 0 R >>');
  objs[2] = enc('<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 240 100] >>');
  objs[3] = enc('<< /Type /Page /Parent 2 0 R '
    + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  const widths = opts.omitWidths
    ? ''
    : ` /FirstChar 65 /LastChar 90 /Widths [${Array(26).fill(1000).join(' ')}]`;
  objs[4] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /TestFont'
    + `${encEntry}${widths} /FontDescriptor 6 0 R >>`);
  objs[5] = enc(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs[6] = enc('<< /Type /FontDescriptor /FontName /TestFont /Flags 4 '
    + '/FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 '
    + '/CapHeight 1000 /StemV 80 /FontFile 7 0 R >>');
  objs[7] = concat([
    enc(`<< /Length ${program.length} /Length1 ${l1} /Length2 ${l2} /Length3 ${l3} >>\nstream\n`),
    program,
    enc('\nendstream'),
  ]);

  const parts: Uint8Array[] = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let at = parts[0].length;
  const offsets: number[] = new Array(objs.length).fill(0);
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = at;
    const head = enc(`${n} 0 obj\n`);
    const tail = enc('\nendobj\n');
    parts.push(head, objs[n], tail);
    at += head.length + objs[n].length + tail.length;
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  parts.push(enc(xref));
  parts.push(enc(`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return concat(parts);
}
