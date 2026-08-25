import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

describe('AddBatesNumbering', () => {
  it('zero-pads to six digits from 1 with no options', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddBatesNumbering();
    expect(decoded(doc.Pages[0])).toContain('(000001)');
    expect(decoded(doc.Pages[2])).toContain('(000003)');
  });

  it('honors start, step, and digits', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddBatesNumbering({ start: 10, step: 5, digits: 3 });
    expect(decoded(doc.Pages[0])).toContain('(010)');
    expect(decoded(doc.Pages[1])).toContain('(015)');
    expect(decoded(doc.Pages[2])).toContain('(020)');
  });

  it('applies prefix and suffix', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddBatesNumbering({ prefix: 'ACME-', suffix: '-X', digits: 4 });
    expect(decoded(doc.Pages[0])).toContain('(ACME-0001-X)');
  });

  it('widens past the digit width instead of throwing', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddBatesNumbering({ start: 999, digits: 3 });
    expect(decoded(doc.Pages[0])).toContain('(999)');
    expect(decoded(doc.Pages[1])).toContain('(1000)');
  });

  it('counts stamped pages, not document pages', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 5 }));
    doc.AddBatesNumbering({ pages: '3-5', digits: 3 });
    expect(decoded(doc.Pages[0])).not.toContain('(001)');
    expect(decoded(doc.Pages[2])).toContain('(001)');
    expect(decoded(doc.Pages[3])).toContain('(002)');
    expect(decoded(doc.Pages[4])).toContain('(003)');
  });

  it('returns the next unused number', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    expect(doc.AddBatesNumbering()).toBe(4);
  });

  it('returns the next unused number with a step', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    expect(doc.AddBatesNumbering({ start: 10, step: 5 })).toBe(25);
  });

  it('chains across documents', () => {
    const docs = [
      Document.Open(buildDecorateTarget({ count: 2 })),
      Document.Open(buildDecorateTarget({ count: 2 })),
    ];
    let n = 1;
    for (const d of docs) n = d.AddBatesNumbering({ start: n, digits: 3 });
    expect(decoded(docs[0].Pages[0])).toContain('(001)');
    expect(decoded(docs[1].Pages[0])).toContain('(003)');
    expect(decoded(docs[1].Pages[1])).toContain('(004)');
    expect(n).toBe(5);
  });

  it('embeds the counter in a custom template', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddBatesNumbering({ text: '{bates} / page {page}', digits: 2 });
    expect(decoded(doc.Pages[1])).toContain('(02 / page 2)');
  });

  it('defaults to the bottom-right corner at 10pt', () => {
    // 200x100 page, margin 36, align right -> anchor vx = 164, vy = 36.
    // Helvetica '000001' at 10pt is 6 * 5.56 = 33.36 wide, so tx = 164 - 33.36.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddBatesNumbering();
    const s = decoded(doc.Pages[0]);
    expect(s).toMatch(/\/F\d+ 10 Tf/);
    expect(s).toContain('1 0 0 1 130.64 36 Tm');
  });

  it('counter-rotates on a /Rotate 90 page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 90 }));
    doc.AddBatesNumbering({ position: 'bottom-left' });
    expect(decoded(doc.Pages[0])).toContain('0 1 -1 0 164 36 Tm');
  });

  it('preserves existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddBatesNumbering();
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('throws TypeError on a non-integer start', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ start: 1.5 })).toThrow(TypeError);
  });

  it('throws TypeError on a negative start', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ start: -1 })).toThrow(TypeError);
  });

  it('throws TypeError on a zero step', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ step: 0 })).toThrow(TypeError);
  });

  it('throws TypeError on zero digits', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ digits: 0 })).toThrow(TypeError);
  });

  it('throws TypeError on an unknown token', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddBatesNumbering({ text: '{nope}' })).toThrow(TypeError);
  });

  it('leaves pages untouched when validation throws', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddBatesNumbering({ pages: '1-9' })).toThrow(RangeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
