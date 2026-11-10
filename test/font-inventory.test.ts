// g0ky.1: doc.Fonts -- one record per font a page's resources reach, with the
// pages that DECLARE it and the pages that actually DRAW with it.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { type3Pdf } from './helpers/build-type3.js';

const enc = (s: string) => new TextEncoder().encode(s);
const len = (s: string) => enc(s).length;
const stream = (c: string, d = '') => `<< ${d} /Length ${len(c)} >>\nstream\n${c}\nendstream`;

/** Two pages SHARING one indirect /Resources that declares /F1, /F2 and the\n *  form /Fm0; only /F1 is drawn on both. Only page 2 draws /Fm0, whose own\n *  resources declare /F3 (and /F1 again) and draw with it. */
function buildFontsPdf(): Uint8Array {
  const o: string[] = [];
  o[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  o[2] = '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 200 200] >>';
  o[3] = '<< /Type /Page /Parent 2 0 R /Resources 11 0 R /Contents 5 0 R >>';
  o[4] = '<< /Type /Page /Parent 2 0 R /Resources 11 0 R /Contents 6 0 R >>';
  o[11] = '<< /Font << /F1 7 0 R /F2 8 0 R >> /XObject << /Fm0 10 0 R >> >>';
  o[5] = stream('BT /F1 12 Tf 10 10 Td (aa) Tj ET');
  o[6] = stream('BT /F1 12 Tf 10 10 Td (bb) Tj ET /Fm0 Do');
  o[7] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  o[8] = '<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Times-Roman /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /B] >> >>';
  o[9] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>';
  o[10] = stream('BT /F3 10 Tf 20 50 Td (c) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /Font << /F3 9 0 R /F1 7 0 R >> >>');
  let body = '%PDF-1.7\n';
  const off: number[] = [];
  for (let n = 1; n < o.length; n++) { off[n] = len(body); body += `${n} 0 obj\n${o[n]}\nendobj\n`; }
  const x = len(body);
  body += `xref\n0 ${o.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < o.length; n++) body += `${String(off[n]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${o.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return enc(body);
}

const plain = (f: { dict: unknown }) => { const { dict: _d, ...rest } = f as Record<string, unknown>; return rest; };

describe('doc.Fonts', () => {
  it('reports each font once, in the order first met, with declared and used pages apart', () => {
    const fonts = Document.Open(buildFontsPdf()).Fonts;
    expect(fonts.map(plain)).toEqual([
      { name: 'Helvetica', subtype: 'Type1', embedded: false, encoding: 'WinAnsiEncoding', customEncoding: false, declaredOn: [1, 2], usedOn: [1, 2] },
      { name: 'Times-Roman', subsetTag: 'ABCDEF', subtype: 'Type1', embedded: false, encoding: 'WinAnsiEncoding', customEncoding: true, declaredOn: [1, 2], usedOn: [] },
      { name: 'Courier', subtype: 'Type1', embedded: false, customEncoding: false, declaredOn: [1, 2], usedOn: [2] },
    ]);
  });

  it('hands back the live font dictionary', () => {
    const doc = Document.Open(buildFontsPdf());
    const [f1] = doc.Fonts;
    expect(f1.dict.get('BaseFont')).toEqual({ kind: 'name', name: 'Helvetica' });
  });

  it('describes an embedded TrueType written by AddFont', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.custom(200, 200));
    const font = doc.AddFont(readFileSync('test/fixtures/fonts/LiberationSans-Regular.woff2'));
    doc.Pages[0].AddText('Hi', 10, 10, { font });
    const [f] = Document.Open(doc.Save()).Fonts;
    expect(plain(f)).toEqual({
      name: 'LiberationSans', subsetTag: expect.stringMatching(/^[A-Z]{6}$/), subtype: 'Type0',
      descendantSubtype: 'CIDFontType2', embedded: true, program: 'TrueType',
      encoding: 'Identity-H', customEncoding: false, declaredOn: [1], usedOn: [1],
    });
  });

  it('describes an embedded CFF written by AddFont', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.custom(200, 200));
    const font = doc.AddFont(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf'));
    doc.Pages[0].AddText('Hi', 10, 10, { font });
    const [f] = Document.Open(doc.Save()).Fonts;
    expect(f).toMatchObject({ subtype: 'Type0', descendantSubtype: 'CIDFontType0', embedded: true, program: 'CIDFontType0C' });
  });

  it('counts a Type 3 font as embedded', () => {
    const [f] = Document.Open(type3Pdf()).Fonts;
    expect(f).toMatchObject({ subtype: 'Type3', embedded: true, program: 'Type3', usedOn: [1] });
  });

  it('is empty for a document with no fonts', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.custom(100, 100));
    expect(doc.Fonts).toEqual([]);
  });
});
