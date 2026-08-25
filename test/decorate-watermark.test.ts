import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, type PdfDict } from '../src/types.js';
import { buildDecorateTarget, buildDecorateMixedSizes } from './helpers/build-decorate-pdf.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

/** A watermark whose Tm depends only on the rotation, not on glyph widths. */
const stampCorner = (rotate: number) => {
  const doc = Document.Open(buildDecorateTarget({ count: 1, rotate }));
  doc.AddWatermark({
    text: 'X', position: 'bottom-left', margin: 36,
    fontSize: 10, opacity: 1, mode: 'overlay',
  });
  return decoded(doc.Pages[0]);
};

describe('AddWatermark placement', () => {
  // 200x100 page, bottom-left, margin 36. Visual anchor (36, 36) maps through
  // the frame matrix to user space, and the stamp counter-rotates by /Rotate so
  // it renders upright.
  it('places upright on an unrotated page', () => {
    expect(stampCorner(0)).toContain('1 0 0 1 36 36 Tm');
  });

  it('counter-rotates on a /Rotate 90 page', () => {
    expect(stampCorner(90)).toContain('0 1 -1 0 164 36 Tm');
  });

  it('counter-rotates on a /Rotate 180 page', () => {
    expect(stampCorner(180)).toContain('-1 0 0 -1 164 64 Tm');
  });

  it('counter-rotates on a /Rotate 270 page', () => {
    expect(stampCorner(270)).toContain('0 -1 1 0 36 64 Tm');
  });

  it('offsets by a non-zero CropBox origin', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, origin: [50, 20] }));
    doc.AddWatermark({
      text: 'X', position: 'bottom-left', margin: 36,
      fontSize: 10, opacity: 1, mode: 'overlay',
    });
    expect(decoded(doc.Pages[0])).toContain('1 0 0 1 86 56 Tm');
  });

  it('auto-fits a diagonal watermark to ~80% of the page diagonal', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', position: 'diagonal' });
    const page = doc.Pages[0];
    // hypot(200, 100) = 223.607; target width = 178.885.
    const m = /\/F\d+ ([\d.]+) Tf/.exec(decoded(page));
    expect(m).not.toBeNull();
    const fontSize = Number(m![1]);
    expect(page.MeasureText('DRAFT', fontSize)).toBeCloseTo(178.885, 1);
  });

  it('honors an explicit fontSize instead of auto-fitting', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', position: 'diagonal', fontSize: 8 });
    expect(decoded(doc.Pages[0])).toMatch(/\/F\d+ 8 Tf/);
  });

  it('fits each page of a mixed-size document independently', () => {
    const doc = Document.Open(buildDecorateMixedSizes());
    doc.AddWatermark({ text: 'DRAFT', position: 'diagonal' });
    const size = (i: number) =>
      Number(/\/F\d+ ([\d.]+) Tf/.exec(decoded(doc.Pages[i]))![1]);
    expect(size(1)).toBeGreaterThan(size(0)); // 400x400 page gets larger text
  });
});

describe('AddWatermark options', () => {
  it('defaults to an underlay drawn before existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT' });
    const s = decoded(doc.Pages[0]);
    expect(s.indexOf('(DRAFT)')).toBeLessThan(s.indexOf('(P1)'));
  });

  it('draws an overlay after existing content when asked', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', mode: 'overlay' });
    const s = decoded(doc.Pages[0]);
    expect(s.indexOf('(DRAFT)')).toBeGreaterThan(s.indexOf('(P1)'));
  });

  it('emits an /ExtGState for the default 0.3 opacity', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT' });
    const page = doc.Pages[0];
    expect(decoded(page)).toMatch(/\/GS\d+ gs/);
    const gs = doc.resolve(page.Resources!.get('ExtGState'));
    expect(isDict(gs)).toBe(true);
    const entry = doc.resolve([...(gs as PdfDict).values()][0]);
    expect(isDict(entry)).toBe(true);
    expect(doc.resolve((entry as PdfDict).get('ca'))).toBe(0.3);
  });

  it('omits the /ExtGState at full opacity', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT', opacity: 1 });
    expect(decoded(doc.Pages[0])).not.toMatch(/\/GS\d+ gs/);
  });

  it('preserves existing page content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT' });
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('stamps only the selected pages', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ text: 'DRAFT', pages: '2' });
    expect(decoded(doc.Pages[0])).not.toContain('(DRAFT)');
    expect(decoded(doc.Pages[1])).toContain('(DRAFT)');
    expect(decoded(doc.Pages[2])).not.toContain('(DRAFT)');
  });

  it('resolves tokens per page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ text: '{page}/{total}', position: 'center' });
    expect(decoded(doc.Pages[0])).toContain('(1/3)');
    expect(decoded(doc.Pages[2])).toContain('(3/3)');
  });

  it('resolves {label} from /PageLabels', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3, labels: true }));
    doc.AddWatermark({ text: '{label}', position: 'center' });
    expect(decoded(doc.Pages[1])).toContain('(ii)');
  });
});

describe('AddWatermark validation', () => {
  const open = () => Document.Open(buildDecorateTarget({ count: 2 }));

  it('throws TypeError when neither text nor image is given', () => {
    expect(() => open().AddWatermark({})).toThrow(TypeError);
  });

  it('throws TypeError when both text and image are given', () => {
    expect(() => open().AddWatermark({ text: 'a', image: new Uint8Array(1) }))
      .toThrow(TypeError);
  });

  it('throws TypeError on an unknown position', () => {
    expect(() => open().AddWatermark({ text: 'a', position: 'middle' as never }))
      .toThrow(TypeError);
  });

  it('throws TypeError on an out-of-band opacity', () => {
    expect(() => open().AddWatermark({ text: 'a', opacity: 2 })).toThrow(TypeError);
  });

  it('throws TypeError on {bates} outside Bates numbering', () => {
    expect(() => open().AddWatermark({ text: '{bates}' })).toThrow(TypeError);
  });

  it('throws RangeError on an out-of-range page selection', () => {
    expect(() => open().AddWatermark({ text: 'a', pages: '5' })).toThrow(RangeError);
  });

  it('leaves every page untouched when validation throws', () => {
    const doc = open();
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddWatermark({ text: 'a', pages: '1-5' })).toThrow(RangeError);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
