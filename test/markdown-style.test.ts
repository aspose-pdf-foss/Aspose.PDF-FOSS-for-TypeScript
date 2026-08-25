import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUnicodeTtf } from './helpers/build-sfnt.js';
import { resolveFamily, resolveMarkdownStyle, faceFor } from '../src/mdstyle.js';

describe('resolveFamily', () => {
  it('derives the three Standard-14 families by name', () => {
    expect(resolveFamily('Helvetica')).toEqual({
      regular: 'Helvetica', bold: 'Helvetica-Bold',
      italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
    });
    expect(resolveFamily('Times-Roman')).toEqual({
      regular: 'Times-Roman', bold: 'Times-Bold',
      italic: 'Times-Italic', boldItalic: 'Times-BoldItalic',
    });
    expect(resolveFamily('Courier')).toEqual({
      regular: 'Courier', bold: 'Courier-Bold',
      italic: 'Courier-Oblique', boldItalic: 'Courier-BoldOblique',
    });
  });

  it('derives from any member of a family, not only its roman', () => {
    // A bold base still names the family; emphasis is relative to the family.
    expect(resolveFamily('Helvetica-Bold').italic).toBe('Helvetica-Oblique');
    expect(resolveFamily('Times-BoldItalic').regular).toBe('Times-BoldItalic');
  });

  it('rejects Symbol and ZapfDingbats, which are not authoring faces', () => {
    expect(() => resolveFamily('Symbol' as never)).toThrow(TypeError);
    expect(() => resolveFamily('ZapfDingbats' as never)).toThrow(TypeError);
  });

  it('falls back to regular for an embedded face the caller did not supply', () => {
    const doc = Document.New();
    const font = doc.AddFont(buildUnicodeTtf());
    const fam = resolveFamily(font);
    expect(fam.bold).toBe(font);
    expect(fam.italic).toBe(font);
  });

  it('takes an explicit family verbatim, filling only what is missing', () => {
    const fam = resolveFamily({ regular: 'Times-Roman', bold: 'Helvetica-Bold' });
    expect(fam.bold).toBe('Helvetica-Bold');
    expect(fam.italic).toBe('Times-Roman'); // unset -> regular, not a derived guess
  });

  it('rejects a malformed family', () => {
    expect(() => resolveFamily({} as never)).toThrow(TypeError);
    expect(() => resolveFamily({ regular: 'NotAFont' } as never)).toThrow(TypeError);
    expect(() => resolveFamily(42 as never)).toThrow(TypeError);
  });
});

describe('faceFor', () => {
  it('selects by the two flags', () => {
    const f = resolveFamily('Helvetica');
    expect(faceFor(f, false, false)).toBe('Helvetica');
    expect(faceFor(f, true, false)).toBe('Helvetica-Bold');
    expect(faceFor(f, false, true)).toBe('Helvetica-Oblique');
    expect(faceFor(f, true, true)).toBe('Helvetica-BoldOblique');
  });
});

describe('resolveMarkdownStyle', () => {
  it('fills a coherent default document', () => {
    const s = resolveMarkdownStyle();
    expect(s.fontSize).toBe(11);
    expect(s.family.regular).toBe('Helvetica');
    expect(s.heading.family.regular).toBe('Helvetica-Bold');
    expect(s.heading.sizes).toEqual([24, 18, 14, 12, 10, 8]);
    expect(s.code.font).toBe('Courier');
    expect(s.link.underline).toBe(true);
  });

  it('scales derived values off the base size', () => {
    const s = resolveMarkdownStyle({ fontSize: 20 });
    expect(s.leading).toBeCloseTo(20 * 1.35, 6);
    expect(s.quote.indent).toBeCloseTo(20 * 1.6, 6);
    expect(s.paragraphSpacing).toBeCloseTo(20 * 0.55, 6);
  });

  it('an explicit value wins over the derived one', () => {
    const s = resolveMarkdownStyle({ fontSize: 20, leading: 13, quote: { indent: 4 } });
    expect(s.leading).toBe(13);
    expect(s.quote.indent).toBe(4);
  });

  it('code.sizeRatio governs inline code and code.fontSize the block', () => {
    const s = resolveMarkdownStyle({ fontSize: 10, code: { fontSize: 7, sizeRatio: 0.8 } });
    expect(s.code.fontSize).toBe(7);
    expect(s.code.sizeRatio).toBe(0.8);
  });

  it('validates every field before returning anything', () => {
    expect(() => resolveMarkdownStyle({ fontSize: 0 })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ leading: -1 })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ align: 'middle' as never })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ color: [0, 0, 2] })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ heading: { sizes: [1, 2, 3] } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ code: { sizeRatio: 0 } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ link: { color: 'blue' as never } })).toThrow(TypeError);
  });
});

describe('the table style group', () => {
  it('fills defaults', () => {
    const st = resolveMarkdownStyle({});
    expect(st.table.border.thickness).toBeGreaterThan(0);
    expect(st.table.padding).toBeGreaterThan(0);
    expect(st.table.fontSize).toBe(st.fontSize);
  });

  it('takes overrides', () => {
    const st = resolveMarkdownStyle({ table: { padding: 7, fontSize: 9 } });
    expect(st.table.padding).toBe(7);
    expect(st.table.fontSize).toBe(9);
  });

  it('accepts headerBackground: false', () => {
    expect(resolveMarkdownStyle({ table: { headerBackground: false } }).table.headerBackground)
      .toBe(false);
  });

  it('rejects a bad value before anything is built', () => {
    expect(() => resolveMarkdownStyle({ table: { padding: -1 } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({ table: { fontSize: 0 } })).toThrow(TypeError);
    expect(() => resolveMarkdownStyle({
      table: { border: { color: [2, 0, 0] } },
    })).toThrow(TypeError);
  });
});
