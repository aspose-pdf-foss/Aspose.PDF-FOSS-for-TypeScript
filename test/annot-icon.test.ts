import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

/** `v0tz.1`: a /Text or /FileAttachment annotation with no /AP draws the
 *  icon a viewer would, rather than nothing. The fixture page is 200x200 and
 *  the annotation's /Rect is [50 50 150 150], so at the default scale the
 *  icon square covers device pixels 50..150 on both axes. */

function page(annot: string, extra: string[] = []): Uint8Array {
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R] >>',
    annot,
    ...extra,
  ]);
}
const note = (entries = '') => page(`<< /Type /Annot /Subtype /Text /Rect [50 50 150 150] ${entries} >>`);
const attach = (entries = '') => page(`<< /Type /Annot /Subtype /FileAttachment /Rect [50 50 150 150] ${entries} >>`);

const render = (bytes: Uint8Array): DecodedPng => decodePng(Document.Open(bytes).Pages[0].ToImage());
const hash = (bytes: Uint8Array) => createHash('sha256').update(Document.Open(bytes).Pages[0].ToImage()).digest('hex');

/** Pixels in the device box [x0,x1) x [y0,y1) satisfying `pred`. */
function count(img: DecodedPng, pred: (p: [number, number, number, number]) => boolean,
  x0 = 0, y0 = 0, x1 = img.width, y1 = img.height): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pred(img.at(x, y))) n++;
  return n;
}
const dark = ([r, g, b]: number[]) => r < 80 && g < 80 && b < 80;
const red = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
const notWhite = ([r, g, b]: number[]) => r < 250 || g < 250 || b < 250;

const TEXT_ICONS = ['Comment', 'Key', 'Note', 'Help', 'NewParagraph', 'Paragraph', 'Insert'];
const ATTACH_ICONS = ['PushPin', 'Graph', 'Paperclip', 'Tag'];

describe('a /Text note with no /AP (v0tz.1)', () => {
  it('draws ink inside its /Rect and nothing outside it', () => {
    const img = render(note('/Name /Note'));
    expect(count(img, dark, 50, 50, 150, 150)).toBeGreaterThan(100);
    expect(count(img, notWhite, 0, 0, 200, 45)).toBe(0);
    expect(count(img, notWhite, 0, 155, 200, 200)).toBe(0);
  });

  it('fills with /C', () => {
    const img = render(note('/Name /Note /C [1 0 0]'));
    expect(count(img, red, 50, 50, 150, 150)).toBeGreaterThan(1000);
  });

  it('an empty /C draws the outline only (transparent, 12.5.2)', () => {
    const img = render(note('/Name /Note /C []'));
    expect(count(img, dark, 50, 50, 150, 150)).toBeGreaterThan(100);
    // Only the outline and rules are ink: the body stays white.
    expect(count(img, notWhite, 50, 50, 150, 150)).toBeLessThan(3000);
  });

  it('no /C defaults to a yellow note', () => {
    const img = render(note('/Name /Note'));
    const yellow = ([r, g, b]: number[]) => r > 200 && g > 200 && b < 80;
    expect(count(img, yellow, 50, 50, 150, 150)).toBeGreaterThan(1000);
  });

  it('squares and centres the icon in a wide /Rect', () => {
    const img = decodePng(Document.Open(page(
      '<< /Type /Annot /Subtype /Text /Rect [0 50 200 150] /Name /Note /C [1 0 0] >>',
    )).Pages[0].ToImage());
    // A 100x100 square centred in a 200x100 rect spans x 50..150.
    expect(count(img, red, 0, 50, 45, 150)).toBe(0);
    expect(count(img, red, 155, 50, 200, 150)).toBe(0);
    expect(count(img, red, 50, 50, 150, 150)).toBeGreaterThan(1000);
  });

  it('an unknown /Name draws the Note icon, as a viewer does', () => {
    expect(hash(note('/Name /NoSuchIcon'))).toBe(hash(note('/Name /Note')));
    expect(hash(note(''))).toBe(hash(note('/Name /Note')));
  });

  it('a name from Object.prototype is unknown too, not a property lookup', () => {
    // A /Name comes out of the document, so `in` would find
    // Object.prototype.constructor here and draw nothing (predefcmap.ts's trap).
    expect(hash(note('/Name /constructor'))).toBe(hash(note('/Name /Note')));
  });

  it('only /Text and /FileAttachment get an icon: a /Link with no /AP stays blank', () => {
    // /Name /PushPin is a real icon name, so a build that dropped the subtype
    // gate would find artwork for it and draw.
    //
    // The subtype here was a /Square until kapw, which gave every shape and
    // text-markup subtype a no-/AP fallback of its own — so a /Square is no
    // longer blank, and proves nothing about the ICON gate. A /Link has no
    // visual at all and is what is left.
    const bytes = page('<< /Type /Annot /Subtype /Link /Rect [50 50 150 150] /Name /PushPin >>');
    expect(count(render(bytes), notWhite)).toBe(0);
  });

  it('every standard name reaches its own artwork', () => {
    const hashes = TEXT_ICONS.map((n) => hash(note(`/Name /${n}`)));
    expect(new Set(hashes).size).toBe(TEXT_ICONS.length);
  });

  it('an existing /AP wins over the icon', () => {
    const bytes = page(
      '<< /Type /Annot /Subtype /Text /Rect [50 50 150 150] /Name /Note /C [1 0 0] /AP << /N 5 0 R >> >>',
      ['<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Length 0 >>\nstream\n\nendstream'],
    );
    expect(count(render(bytes), notWhite)).toBe(0);
  });

  it('a present but unusable /AP is respected: nothing is drawn', () => {
    // /N is a state dict and /AS names no state in it.
    const bytes = note('/Name /Note /AP << /N << /On 5 0 R >> >> /AS /Off');
    expect(count(render(bytes), notWhite)).toBe(0);
  });

  it('a Hidden note stays blank', () => {
    expect(count(render(note('/Name /Note /F 2')), notWhite)).toBe(0);
  });

  it('draws in ToSvg too', () => {
    const svg = Document.Open(note('/Name /Note /C [1 0 0]')).Pages[0].ToSvg();
    expect(svg).toContain('fill="#ff0000"');
  });

  it('survives FlattenAnnotations as page content', () => {
    const d = Document.Open(note('/Name /Note /C [1 0 0]'));
    d.FlattenAnnotations();
    const re = Document.Open(d.Save());
    expect(re.Pages[0].Annotations.length).toBe(0);
    expect(count(decodePng(re.Pages[0].ToImage()), red, 50, 50, 150, 150)).toBeGreaterThan(1000);
  });

  it('rendering does not write an /AP into the document', () => {
    const d = Document.Open(note('/Name /Note'));
    d.Pages[0].ToImage();
    expect(d.Pages[0].Annotations[0].Dict.has('AP')).toBe(false);
  });

  it('AddTextNote still writes no /AP: viewers draw their own icon', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const n = d.Pages[0].AddTextNote({ rect: [10, 10, 30, 30] });
    expect(n.Dict.has('AP')).toBe(false);
    expect(count(decodePng(d.Pages[0].ToImage()), dark)).toBeGreaterThan(0);
  });
});

describe('a /FileAttachment with no /AP (v0tz.1)', () => {
  it('draws ink inside its /Rect', () => {
    expect(count(render(attach('/Name /PushPin')), dark, 50, 50, 150, 150)).toBeGreaterThan(50);
  });

  it('an unknown or absent /Name draws the PushPin icon', () => {
    expect(hash(attach('/Name /Nope'))).toBe(hash(attach('/Name /PushPin')));
    expect(hash(attach(''))).toBe(hash(attach('/Name /PushPin')));
  });

  it('every standard name reaches its own artwork', () => {
    const hashes = ATTACH_ICONS.map((n) => hash(attach(`/Name /${n}`)));
    expect(new Set(hashes).size).toBe(ATTACH_ICONS.length);
  });

  it('fills with /C', () => {
    expect(count(render(attach('/Name /Tag /C [1 0 0]')), red, 50, 50, 150, 150)).toBeGreaterThan(200);
  });

  it('a /Text name on an attachment is unknown there', () => {
    expect(hash(attach('/Name /Note'))).toBe(hash(attach('/Name /PushPin')));
  });
});
