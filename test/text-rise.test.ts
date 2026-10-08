/** TextRun.rise (v9j3.3): a baseline shift that moves INK and not LAYOUT, and
 *  the guard that refuses a footnote/endnote run outside a Flow. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { measureTextBlock } from '../src/stamp.js';

function content(page: { Contents: Uint8Array }): string {
  return new TextDecoder('latin1').decode(page.Contents);
}

describe('TextRun.rise', () => {
  it('emits Ts before the raised run and resets it after', () => {
    const page = Document.New().AddPage().page;
    page.AddTextBlock([{ text: 'claim' }, { text: '1', fontSize: 7, rise: 4 }, { text: ' more' }],
      [72, 600, 300, 100], { fontSize: 12 });
    const s = content(page);
    const i = s.indexOf('4 Ts');
    expect(i).toBeGreaterThan(0);
    const tj = s.indexOf('(1 ) Tj', i);
    expect(tj).toBeGreaterThan(i);
    expect(s.indexOf('0 Ts', tj)).toBeGreaterThan(tj);
  });

  it('resets Ts when a block ENDS on a raised run', () => {
    const page = Document.New().AddPage().page;
    page.AddTextBlock([{ text: 'claim' }, { text: '1', fontSize: 7, rise: 4 }],
      [72, 600, 300, 100], { fontSize: 12 });
    const s = content(page);
    expect(s.indexOf('0 Ts', s.indexOf('(1) Tj'))).toBeGreaterThan(0);
  });

  it('emits no Ts at all for runs without rise', () => {
    const page = Document.New().AddPage().page;
    page.AddTextBlock([{ text: 'a' }, { text: 'b', fontSize: 7 }], [72, 600, 300, 100]);
    expect(content(page)).not.toMatch(/ Ts\b/);
  });

  it('does not change the line band', () => {
    const a = measureTextBlock([{ text: 'x' }], 300, 100, { fontSize: 12 });
    const b = measureTextBlock([{ text: 'x' }, { text: '1', fontSize: 7, rise: 4 }], 300, 100, { fontSize: 12 });
    expect(b.usedHeight).toBe(a.usedHeight);
  });

  it('moves a raised linked run’s rect up by the rise', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    page.AddTextBlock([{ text: 'x ' }, { text: 'L', link: 'https://a.example/', rise: 5 }],
      [72, 600, 300, 100], { fontSize: 12 });
    const flat = doc.AddPage().page;
    flat.AddTextBlock([{ text: 'x ' }, { text: 'L', link: 'https://a.example/' }],
      [72, 600, 300, 100], { fontSize: 12 });
    const r1 = page.Annotations[0].Rect!, r0 = flat.Annotations[0].Rect!;
    expect(r1[1] - r0[1]).toBeCloseTo(5, 6);
    expect(r1[3] - r0[3]).toBeCloseTo(5, 6);
  });

  it('raises a run’s OWN underline with it, but not a block-level one', () => {
    const own = Document.New().AddPage().page;
    own.AddTextBlock([{ text: 'x' }, { text: 'm', rise: 5, underline: true }], [72, 600, 300, 100], { fontSize: 12 });
    const flatOwn = Document.New().AddPage().page;
    flatOwn.AddTextBlock([{ text: 'x' }, { text: 'm', underline: true }], [72, 600, 300, 100], { fontSize: 12 });
    const re = /([\d.]+) ([\d.]+) [\d.]+ [\d.]+ re f/;
    const yOwn = Number(re.exec(content(own))![2]);
    const yFlat = Number(re.exec(content(flatOwn))![2]);
    expect(yOwn - yFlat).toBeCloseTo(5, 4);

    const blk = Document.New().AddPage().page;
    blk.AddTextBlock([{ text: 'x' }, { text: 'm', rise: 5 }], [72, 600, 300, 100], { fontSize: 12, underline: true });
    const blkFlat = Document.New().AddPage().page;
    blkFlat.AddTextBlock([{ text: 'x' }, { text: 'm' }], [72, 600, 300, 100], { fontSize: 12, underline: true });
    const ys = (s: string) => [...s.matchAll(/([\d.]+) ([\d.]+) [\d.]+ [\d.]+ re f/g)].map((m) => m[2]);
    expect(ys(content(blk))).toEqual(ys(content(blkFlat)));
  });

  it('refuses a non-finite rise', () => {
    const page = Document.New().AddPage().page;
    expect(() => page.AddTextBlock([{ text: 'a', rise: NaN }], [72, 600, 300, 100])).toThrow(TypeError);
  });
});

describe('the note-key guard', () => {
  it('refuses a run carrying a footnote outside a Flow', () => {
    const page = Document.New().AddPage().page;
    const run = { text: 'a', footnote: { content: 'n' } } as never;
    expect(() => page.AddTextBlock([run], [72, 600, 300, 100])).toThrow(/footnote.*only.*Flow/);
  });
  it('refuses a run carrying an endnote outside a Flow', () => {
    const page = Document.New().AddPage().page;
    const run = { text: 'a', endnote: { content: 'n' } } as never;
    expect(() => page.AddTextBlock([run], [72, 600, 300, 100])).toThrow(TypeError);
  });
});
