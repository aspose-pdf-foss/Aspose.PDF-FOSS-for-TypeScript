import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';

// g72b: tagged text drawn through a Form XObject, marked by the page's own
// /P << /MCID 0 >> BDC around the Do -- the shape every MCID consumer in this
// library resolves through the page's /StructParents. Reflow excluded form
// glyphs from its paragraph key and its language lookup, so it refused the
// paragraph as not-found and never saw the element's /Lang.
const enc = (s: string) => new TextEncoder().encode(s);
const LINES = ['The quick brown fox jumps over the lazy', 'internationalization dog and then keeps', 'running far away into the woods'];

function build(where: 'page' | 'form', lang: string): Uint8Array {
  const text = 'BT /F1 12 Tf 0 0 Td ' + LINES.map((l, i) => (i ? '0 -14 Td ' : '') + `(${l}) Tj`).join(' ') + ' ET';
  const page = `/P << /MCID 0 >> BDC q 1 0 0 1 72 700 cm ${where === 'page' ? text : '/Fm0 Do'} Q EMC`;
  const s = (c: string, x = '') => `<< ${x} /Length ${enc(c).length} >>\nstream\n${c}\nendstream`;
  const o: string[] = [];
  o[1] = '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>';
  o[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>';
  o[3] = '<< /Type /Page /Parent 2 0 R /StructParents 0 /Resources << /Font << /F1 6 0 R >> /XObject << /Fm0 5 0 R >> >> /Contents 4 0 R >>';
  o[4] = s(page);
  o[5] = s(text, '/Type /XObject /Subtype /Form /BBox [0 -100 400 20] /Resources << /Font << /F1 6 0 R >> >>');
  o[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  o[7] = '<< /Type /StructTreeRoot /K [8 0 R] /ParentTree 9 0 R /ParentTreeNextKey 1 >>';
  o[8] = `<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R ${lang} /K 0 >>`;
  o[9] = '<< /Nums [0 [8 0 R]] >>';
  let b = '%PDF-1.7\n';
  const off: number[] = [];
  for (let n = 1; n <= 9; n++) { off[n] = enc(b).length; b += `${n} 0 obj\n${o[n]}\nendobj\n`; }
  const x = enc(b).length;
  b += 'xref\n0 10\n0000000000 65535 f \n' + off.slice(1).map((v) => `${String(v).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return enc(b);
}

// 'quite remarkably very quick' pushes 'internationalization' across a line
// end, where it splits in English and stays whole with no language.
const reflow = (where: 'page' | 'form', lang: string): string => {
  const doc = Document.Open(build(where, lang));
  doc.Pages[0].ReplaceText('quick', 'quite remarkably very quick', { adjust: 'reflow', hyphenate: {} });
  return doc.Pages[0].GetText();
};

describe('reflow of tagged text inside a Form XObject (g72b)', () => {
  it('reflows it as one paragraph, as it does page-level text', () => {
    expect(reflow('form', '')).toBe(reflow('page', ''));
    expect(reflow('form', '')).toContain('The quite remarkably very quick brown\nfox');
  });

  it('hyphenates in the /Lang of the element that marked it', () => {
    expect(reflow('form', '/Lang (en)')).toContain('internationaliza­\ntion');
    expect(reflow('form', '/Lang (en)')).toBe(reflow('page', '/Lang (en)'));
    expect(reflow('form', '')).not.toContain('­');   // the language is what splits it
  });
});
