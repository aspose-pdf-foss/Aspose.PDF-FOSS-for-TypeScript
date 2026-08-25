import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

describe('AddHeaderFooter', () => {
  it('stamps a footer slot with tokens resolved', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddHeaderFooter({ footer: { center: 'Page {page} of {total}' } });
    expect(decoded(doc.Pages[0])).toContain('(Page 1 of 3)');
    expect(decoded(doc.Pages[2])).toContain('(Page 3 of 3)');
  });

  it('stamps all six slots', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({
      header: { left: 'HL', center: 'HC', right: 'HR' },
      footer: { left: 'FL', center: 'FC', right: 'FR' },
    });
    const s = decoded(doc.Pages[0]);
    for (const t of ['(HL)', '(HC)', '(HR)', '(FL)', '(FC)', '(FR)']) {
      expect(s).toContain(t);
    }
  });

  it('places the header band above the footer band', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ header: { left: 'H' }, footer: { left: 'F' } });
    const page = doc.Pages[0];
    const frags = page.GetTextFragments();
    const h = frags.find((x) => x.text === 'H')!;
    const f = frags.find((x) => x.text === 'F')!;
    expect(h.quad[1]).toBeGreaterThan(f.quad[1]);
  });

  it('drops a top slot by the margin plus the font size', () => {
    // 200x100 page, margin 36, fontSize 10 -> baseline at 100 - 36 - 10 = 54.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ header: { left: 'H' } });
    expect(decoded(doc.Pages[0])).toContain('1 0 0 1 36 54 Tm');
  });

  it('honors a custom margin', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' }, margin: 10 });
    expect(decoded(doc.Pages[0])).toContain('1 0 0 1 10 10 Tm');
  });

  it('defaults to 10pt', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    expect(decoded(doc.Pages[0])).toMatch(/\/F\d+ 10 Tf/);
  });

  it('counter-rotates on a /Rotate 90 page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 90 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    expect(decoded(doc.Pages[0])).toContain('0 1 -1 0 164 36 Tm');
  });

  it('draws as an overlay, after existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    const s = decoded(doc.Pages[0]);
    expect(s.indexOf('(F)')).toBeGreaterThan(s.indexOf('(P1)'));
  });

  it('stamps only the selected pages', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddHeaderFooter({ footer: { left: 'F' }, pages: '2-3' });
    expect(decoded(doc.Pages[0])).not.toContain('(F)');
    expect(decoded(doc.Pages[1])).toContain('(F)');
  });

  it('preserves existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddHeaderFooter({ footer: { left: 'F' } });
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('is a no-op with no slots', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    const before = decoded(doc.Pages[0]);
    doc.AddHeaderFooter({});
    expect(decoded(doc.Pages[0])).toBe(before);
  });

  it('skips empty slot strings', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    const before = decoded(doc.Pages[0]);
    doc.AddHeaderFooter({ footer: { left: '' } });
    expect(decoded(doc.Pages[0])).toBe(before);
  });

  it('throws TypeError on an unknown token in any slot', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddHeaderFooter({ footer: { right: '{pages}' } })).toThrow(TypeError);
  });

  it('throws TypeError on {bates}', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddHeaderFooter({ footer: { left: '{bates}' } })).toThrow(TypeError);
  });

  it('leaves pages untouched when a later slot fails validation', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddHeaderFooter({ footer: { left: 'ok', right: '{nope}' } }))
      .toThrow(TypeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
