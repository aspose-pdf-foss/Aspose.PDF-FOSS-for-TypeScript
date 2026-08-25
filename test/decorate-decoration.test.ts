import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

describe('decorate.ts text decoration', () => {
  it('underlines a watermark', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddWatermark({ text: 'DRAFT', underline: true });
    expect(decoded(doc.Pages[0])).toContain('re f');
  });

  it('backgrounds a header cell', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddHeaderFooter({ header: { center: 'Title' }, background: [1, 1, 0] });
    expect(decoded(doc.Pages[0])).toContain('1 1 0 rg');
  });

  it('strikes through a Bates number', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddBatesNumbering({ strikethrough: true });
    expect(decoded(doc.Pages[0])).toContain('re f');
  });

  it('an undecorated watermark emits no rects', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddWatermark({ text: 'DRAFT' });
    expect(decoded(doc.Pages[0])).not.toContain('re f');
  });

  it('rejects a bad decoration before touching any page', () => {
    const doc = Document.Open(buildDecorateTarget());
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddWatermark({ text: 'DRAFT', underline: { thickness: -1 } }))
      .toThrow(/underline\.thickness/);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
