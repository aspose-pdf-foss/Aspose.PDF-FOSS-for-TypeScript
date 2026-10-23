// krf2.1: page decoration written as TYPED pagination artifacts, behind an
// `artifact` option that is off by default, so existing output does not move.
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);
const target = () => Document.Open(buildDecorateTarget({ count: 2 }));
const kinds = (page: Page) => page.Artifacts.map((a) => ({ type: a.type, subtype: a.subtype, attached: a.attached }));

describe('off by default', () => {
  it('writes no artifact unless asked, byte for byte as before', () => {
    const a = target(), b = target();
    a.AddWatermark({ text: 'DRAFT' });
    a.AddHeaderFooter({ header: { center: 'H' }, footer: { right: '{page}' } });
    a.AddBatesNumbering();
    b.AddWatermark({ text: 'DRAFT', artifact: false });
    b.AddHeaderFooter({ header: { center: 'H' }, footer: { right: '{page}' }, artifact: false });
    b.AddBatesNumbering({ artifact: false });
    expect(decoded(a.Pages[0])).not.toContain('Artifact');
    expect(decoded(a.Pages[0])).toBe(decoded(b.Pages[0]));
  });
});

describe('AddWatermark({ artifact: true })', () => {
  it('marks a text watermark /Pagination /Watermark on every selected page', () => {
    const doc = target();
    doc.AddWatermark({ text: 'DRAFT', artifact: true });
    for (const p of doc.Pages) {
      expect(kinds(p)).toEqual([{ type: 'Pagination', subtype: 'Watermark', attached: undefined }]);
      expect(p.Artifacts[0].bbox).toBeDefined();
    }
  });

  it('marks an underlay watermark, drawn first', () => {
    const doc = target();
    doc.AddWatermark({ text: 'DRAFT', artifact: true, mode: 'underlay' });
    expect(decoded(doc.Pages[0]).startsWith('/Artifact <</Type /Pagination /Subtype /Watermark>> BDC')).toBe(true);
  });

  it('marks an image watermark', () => {
    const doc = target();
    doc.AddWatermark({ image: buildPngRgb(), artifact: true, pages: [1] });
    expect(kinds(doc.Pages[0])).toEqual([{ type: 'Pagination', subtype: 'Watermark', attached: undefined }]);
    expect(doc.Pages[1].Artifacts).toEqual([]);
  });

  it('refuses a non-boolean artifact before touching the document', () => {
    const doc = target();
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddWatermark({ text: 'X', artifact: 'yes' as unknown as boolean })).toThrow(TypeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});

describe('AddHeaderFooter({ artifact: true })', () => {
  it('marks each header cell /Header attached Top and each footer cell /Footer attached Bottom', () => {
    const doc = target();
    doc.AddHeaderFooter({ header: { left: 'L', right: 'R' }, footer: { center: '{page}' }, artifact: true });
    expect(kinds(doc.Pages[1])).toEqual([
      { type: 'Pagination', subtype: 'Header', attached: ['Top'] },
      { type: 'Pagination', subtype: 'Header', attached: ['Top'] },
      { type: 'Pagination', subtype: 'Footer', attached: ['Bottom'] },
    ]);
  });

  it('refuses a non-boolean artifact', () => {
    expect(() => target().AddHeaderFooter({ header: { center: 'H' }, artifact: 1 as unknown as boolean }))
      .toThrow(TypeError);
  });
});

describe('AddBatesNumbering({ artifact: true })', () => {
  it('takes its subtype from its band: bottom is a Footer, top a Header', () => {
    const bottom = target();
    bottom.AddBatesNumbering({ artifact: true });
    expect(kinds(bottom.Pages[0])).toEqual([{ type: 'Pagination', subtype: 'Footer', attached: ['Bottom'] }]);
    const top = target();
    top.AddBatesNumbering({ artifact: true, position: 'top-left' });
    expect(kinds(top.Pages[0])).toEqual([{ type: 'Pagination', subtype: 'Header', attached: ['Top'] }]);
  });

  it('states no subtype at a position in neither band', () => {
    const doc = target();
    doc.AddBatesNumbering({ artifact: true, position: 'center' });
    expect(kinds(doc.Pages[0])).toEqual([{ type: 'Pagination', subtype: undefined, attached: undefined }]);
  });

  it('refuses a non-boolean artifact before numbering anything', () => {
    const doc = target();
    expect(() => doc.AddBatesNumbering({ artifact: 'no' as unknown as boolean })).toThrow(TypeError);
    expect(decoded(doc.Pages[0])).not.toContain('000001');
  });
});

describe('in a tagged document', () => {
  const tagged = () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    doc.AutoTag();
    return doc;
  };
  const untagged = (doc: Document) => doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

  it('a decoration marked as an artifact is not untagged content', () => {
    const plain = tagged();
    expect(untagged(plain)).toBe(false);
    plain.AddWatermark({ text: 'DRAFT' });
    expect(untagged(plain)).toBe(true);
    const marked = tagged();
    marked.AddWatermark({ text: 'DRAFT', artifact: true });
    marked.AddHeaderFooter({ footer: { center: '{page}' }, artifact: true });
    marked.AddBatesNumbering({ artifact: true, position: 'top-right' });
    expect(untagged(marked)).toBe(false);
  });
});
