import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { stampCaption } from '../src/annotstamp.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

/** `v0tz.2`: a /Stamp with no /AP draws a legible caption box rather than
 *  nothing. Page 300x200; the stamp's /Rect is [50 50 250 150]. */

function page(annot: string, extra: string[] = []): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Annots [4 0 R] >>',
    annot,
    ...extra,
  ]);
}
const stamp = (entries = '') => page(`<< /Type /Annot /Subtype /Stamp /Rect [50 50 250 150] ${entries} >>`);

/** The text the stamp's drawn appearance reads as. */
function caption(bytes: Uint8Array): string {
  const hits = Document.Open(bytes).Pages[0].SearchAnnotations(/.+/);
  return hits.map((h) => h.text).join('|');
}

function count(img: DecodedPng, pred: (p: number[]) => boolean): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (pred(img.at(x, y))) n++;
  return n;
}
const red = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
const blue = ([r, g, b]: number[]) => r < 60 && g < 60 && b > 200;
const notWhite = ([r, g, b]: number[]) => r < 250 || g < 250 || b < 250;
const render = (bytes: Uint8Array) => decodePng(Document.Open(bytes).Pages[0].ToImage());

describe('stampCaption', () => {
  it('spells the 14 standard names the way a rubber stamp reads', () => {
    expect(stampCaption('Approved')).toBe('APPROVED');
    expect(stampCaption('NotApproved')).toBe('NOT APPROVED');
    expect(stampCaption('AsIs')).toBe('AS IS');
    expect(stampCaption('ForPublicRelease')).toBe('FOR PUBLIC RELEASE');
    expect(stampCaption('NotForPublicRelease')).toBe('NOT FOR PUBLIC RELEASE');
    expect(stampCaption('TopSecret')).toBe('TOP SECRET');
    expect(stampCaption('ForComment')).toBe('FOR COMMENT');
    for (const n of ['Experimental', 'Expired', 'Confidential', 'Final', 'Sold', 'Departmental', 'Draft'])
      expect(stampCaption(n)).toBe(n.toUpperCase());
  });

  it('draws any other name as written, and matches the standard ones exactly', () => {
    expect(stampCaption('ReviewedByLegal')).toBe('ReviewedByLegal');
    expect(stampCaption('approved')).toBe('approved');
    expect(stampCaption('constructor')).toBe('constructor');
  });
});

describe('a /Stamp with no /AP (v0tz.2)', () => {
  it('draws its standard /Name as a legible caption', () => {
    expect(caption(stamp('/Name /Approved'))).toBe('APPROVED');
    expect(caption(stamp('/Name /NotApproved'))).toBe('NOT APPROVED');
  });

  it('draws a custom /Name as written', () => {
    expect(caption(stamp('/Name /Reviewed'))).toBe('Reviewed');
  });

  it('with no /Name, draws the first non-empty line of /Contents', () => {
    expect(caption(stamp('/Contents (\\nChecked by QA\\nsecond line)'))).toBe('Checked by QA');
  });

  it('with neither, draws DRAFT — the spec default /Name (12.5.6.12)', () => {
    expect(caption(stamp(''))).toBe('DRAFT');
    expect(caption(stamp('/Contents ()'))).toBe('DRAFT');
  });

  it('/Name outranks /Contents', () => {
    expect(caption(stamp('/Name /Final /Contents (something else)'))).toBe('FINAL');
  });

  it('is red by default and honours /C', () => {
    expect(count(render(stamp('/Name /Approved')), red)).toBeGreaterThan(200);
    const b = render(stamp('/Name /Approved /C [0 0 1]'));
    expect(count(b, blue)).toBeGreaterThan(200);
    expect(count(b, red)).toBe(0);
  });

  it('an empty /C is still drawn red: a transparent stamp is an invisible one', () => {
    expect(count(render(stamp('/Name /Approved /C []')), red)).toBeGreaterThan(200);
  });

  it('draws only inside its /Rect', () => {
    const img = render(stamp('/Name /Approved'));
    let outside = 0;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const inside = x >= 48 && x <= 252 && y >= 48 && y <= 152;
      if (!inside && notWhite(img.at(x, y))) outside++;
    }
    expect(outside).toBe(0);
  });

  it('an existing /AP wins', () => {
    const bytes = page(
      '<< /Type /Annot /Subtype /Stamp /Rect [50 50 250 150] /Name /Approved /AP << /N 5 0 R >> >>',
      ['<< /Type /XObject /Subtype /Form /BBox [0 0 200 100] /Length 0 >>\nstream\n\nendstream'],
    );
    expect(count(render(bytes), notWhite)).toBe(0);
  });

  it('a Hidden stamp stays blank', () => {
    expect(count(render(stamp('/Name /Approved /F 2')), notWhite)).toBe(0);
  });

  it('survives FlattenAnnotations', () => {
    const d = Document.Open(stamp('/Name /Approved'));
    d.FlattenAnnotations();
    const re = Document.Open(d.Save());
    expect(re.Pages[0].Annotations.length).toBe(0);
    expect(re.Pages[0].GetText()).toContain('APPROVED');
  });

  it('rendering writes nothing: no /AP and no new object', () => {
    const d = Document.Open(stamp('/Name /Approved'));
    const before = [...d.objectEntries()].length;
    d.Pages[0].ToImage();
    d.Pages[0].ToSvg();
    expect([...d.objectEntries()].length).toBe(before);
    expect(d.Pages[0].Annotations[0].Dict.has('AP')).toBe(false);
  });
});

describe('AddStamp captions (v0tz.2)', () => {
  const doc = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };

  it('a standard name is drawn as a rubber stamp reads', () => {
    const d = doc();
    d.Pages[0].AddStamp({ rect: [50, 50, 300, 120], name: 'NotApproved' });
    expect(d.Pages[0].SearchAnnotations(/.+/).map((h) => h.text)).toEqual(['NOT APPROVED']);
  });

  it('custom text is drawn exactly as given', () => {
    const d = doc();
    d.Pages[0].AddStamp({ rect: [50, 50, 300, 120], text: 'NotApproved' });
    expect(d.Pages[0].SearchAnnotations(/.+/).map((h) => h.text)).toEqual(['NotApproved']);
  });

  it('agrees with the fallback about what a stamp says', () => {
    const d = doc();
    d.Pages[0].AddStamp({ rect: [50, 50, 250, 150], name: 'TopSecret' });
    expect(d.Pages[0].SearchAnnotations(/.+/)[0].text).toBe(caption(stamp('/Name /TopSecret')));
  });
});
