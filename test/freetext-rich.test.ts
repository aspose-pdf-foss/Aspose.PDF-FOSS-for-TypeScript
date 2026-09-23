import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { regenerateAppearance } from '../src/annotdraw.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { PdfDict, PdfObject, isDict, isStream, name } from '../src/types.js';

const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

/** The /AP /N stream bytes regenerateAppearance installs for a FreeText. */
function regenerated(entries: [string, PdfObject][]): Uint8Array {
  const doc = Document.Open(buildAnnotTarget());
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Annot')], ['Subtype', name('FreeText')], ...entries]);
  expect(regenerateAppearance(doc, dict)).toBe(true);
  const ap = doc.resolve(dict.get('AP'));
  const n = isDict(ap) ? doc.resolve(ap.get('N')) : undefined;
  if (!isStream(n)) throw new Error('no /AP /N');
  return n.raw;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const PLAIN: [string, PdfObject][] = [
  ['Rect', [0, 0, 160, 80]],
  ['Contents', str('A plain comment that wraps onto a second line of text')],
  ['DA', str('0 0 1 rg /Helv 11 Tf')],
  ['Q', 1],
  ['RD', [2, 3, 2, 3]],
  ['C', [1, 0, 0]],
  ['IC', [1, 1, 0.8]],
  ['CL', [0, 0, 20, 20, 30, 30]],
];

describe('plain FreeText regeneration is unchanged (fence)', () => {
  it('matches the bytes written before v0tz.3', () => {
    expect(sha(regenerated(PLAIN))).toBe('514dc423f04d89764a20cc2178abb264613fc3017096c5380da821f6991a118f');
  });
});

import { freeTextParts } from '../src/annotdraw.js';
import { decodePng } from './helpers/decode-png.js';

const RC = '<body xmlns="http://www.w3.org/1999/xhtml"><p>Plain <b>BOLD</b> <span style="color:#FF0000">RED</span> <i>ital</i></p><p style="font-size:20pt;font-family:Times">Big</p></body>';

describe('regenerateAppearance draws /RC', () => {
  it('uses one font key per face, each registered in the form', () => {
    const doc = Document.Open(buildAnnotTarget());
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('FreeText')], ['Rect', [0, 0, 300, 120]],
      ['Contents', str('Plain BOLD RED ital Big')], ['RC', str(RC)], ['DA', str('0 g /Helv 12 Tf')],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const ap = doc.resolve(dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N'));
    if (!isStream(n)) throw new Error('no stream');
    const fonts = doc.resolve((n.dict.get('Resources') as PdfDict).get('Font')) as PdfDict;
    const base = [...fonts.keys()].map((k) => {
      const f = doc.resolve(fonts.get(k)) as PdfDict;
      return [k, (f.get('BaseFont') as { name: string }).name];
    });
    expect(base).toEqual([['F0', 'Helvetica'], ['F1', 'Helvetica-Bold'], ['F2', 'Helvetica-Oblique'], ['F3', 'Times-Roman']]);
  });

  it('falls back to plain /Contents when /RC will not parse', () => {
    expect(sha(regenerated([...PLAIN, ['RC', str('<p>broken')]]))).toBe(sha(regenerated(PLAIN)));
  });

  it('falls back to plain /Contents when /RC has no text', () => {
    expect(sha(regenerated([...PLAIN, ['RC', str('<p> </p>')]]))).toBe(sha(regenerated(PLAIN)));
  });

  it('draws /RC even with no /Contents', () => {
    const b = new TextDecoder('latin1').decode(regenerated([['Rect', [0, 0, 200, 60]], ['RC', str('<p>only rich</p>')]]));
    expect(b).toContain('(only rich) Tj');
  });

  it('freeTextParts allocates nothing', () => {
    const doc = Document.Open(buildAnnotTarget());
    const before = [...doc.objectEntries()].length;
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('FreeText')], ['Rect', [0, 0, 200, 60]], ['RC', str(RC)],
    ]);
    expect(freeTextParts(doc, dict)).toBeDefined();
    expect([...doc.objectEntries()].length).toBe(before);
  });
});

/** An XFDF carrying one FreeText with rich text and no appearance. */
function xfdf(rc: string): Uint8Array {
  return new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
    + '<freetext page="0" rect="20,40,280,180" name="ft1">'
    + '<contents>Plain BOLD RED ital Big</contents>'
    + `<contents-richtext>${rc}</contents-richtext>`
    + '<defaultappearance>0 g /Helv 12 Tf</defaultappearance>'
    + '</freetext></annots></xfdf>');
}

describe('an imported styled FreeText flattens with its styling (v0tz.3)', () => {
  function flattened() {
    const d = Document.Open(buildAnnotTarget());
    d.ImportXfdf(xfdf(RC), { annotations: true });
    d.FlattenAnnotations();
    return Document.Open(d.Save());
  }

  it('keeps each word in its own face and size', () => {
    const frags = flattened().Pages[0].GetTextFragments();
    const of = (t: string) => frags.find((f) => f.text.includes(t));
    expect(of('BOLD')?.fontName).toMatch(/Helvetica-Bold/);
    expect(of('ital')?.fontName).toMatch(/Helvetica-Oblique/);
    expect(of('Big')?.fontName).toMatch(/Times-Roman/);
    expect(of('Big')?.fontSize).toBe(20);
    expect(of('Plain')?.fontName).toMatch(/^(?!.*Bold)/);
  });

  it('paints the red word red', () => {
    const img = decodePng(flattened().Pages[0].ToImage());
    let red = 0;
    // Only inside the FreeText's rect (20,40)-(280,180), device y 20..160:
    // buildAnnotTarget also carries a red sticky note at [10 20 30 40], which
    // v0tz.1 draws, and counting the whole page passed on the unfixed code.
    for (let y = 22; y < 158; y++) for (let x = 22; x < 278; x++) {
      const [r, g, b] = img.at(x, y);
      if (r > 200 && g < 60 && b < 60) red++;
    }
    expect(red).toBeGreaterThan(20);
  });
});

import { buildRawPdf } from './helpers/build-page-tree-pdf.js';

function freeTextPage(entries: string): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Annots [4 0 R] >>',
    `<< /Type /Annot /Subtype /FreeText /Rect [20 20 380 180] ${entries} >>`,
  ]);
}
const RC_PDF = '(<p>Plain <b>BOLD</b> <span style="color:#FF0000">RED</span></p>)';

describe('a FreeText with no /AP is drawn from /RC (v0tz.3)', () => {
  it('draws its styled text, readable by SearchAnnotations', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF}`));
    expect(d.Pages[0].SearchAnnotations('BOLD').length).toBe(1);
  });

  it('with no /RC draws plain /Contents', () => {
    const d = Document.Open(freeTextPage('/DA (0 g /Helv 12 Tf) /Contents (hello there)'));
    expect(d.Pages[0].SearchAnnotations('hello').length).toBe(1);
  });

  it('flattens with its styling', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF}`));
    d.FlattenAnnotations();
    const frags = Document.Open(d.Save()).Pages[0].GetTextFragments();
    expect(frags.find((f) => f.text.includes('BOLD'))?.fontName).toMatch(/Helvetica-Bold/);
  });

  it('rendering allocates nothing and writes no /AP', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF}`));
    const before = [...d.objectEntries()].length;
    d.Pages[0].ToImage();
    d.Pages[0].ToSvg();
    expect([...d.objectEntries()].length).toBe(before);
    expect(d.Pages[0].Annotations[0].Dict.has('AP')).toBe(false);
  });

  it('a present /AP is respected', () => {
    const d = Document.Open(freeTextPage(`/DA (0 g /Helv 12 Tf) /RC ${RC_PDF} /AP << /N << /On 9 0 R >> >> /AS /Off`));
    expect(d.Pages[0].SearchAnnotations('BOLD').length).toBe(0);
  });
});
