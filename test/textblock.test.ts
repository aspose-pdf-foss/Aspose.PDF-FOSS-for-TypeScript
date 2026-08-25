import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isName } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildOtFontFor } from './helpers/build-sfnt.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

function baseFonts(fonts: Map<string, any>, resolve: (o: any) => any): string[] {
  const out: string[] = [];
  for (const v of fonts.values()) {
    const d = resolve(v);
    if (isDict(d)) {
      const bf = resolve(d.get('BaseFont'));
      if (isName(bf)) out.push(bf.name);
    }
  }
  return out;
}

// Courier is monospaced: every glyph advances 600/1000 * size. At size 12 that
// is 7.2 pt per character. Default leading is 1.2 * size = 14.4.
const LEADING = 14.4;

describe('Page.AddTextBlock basic emission', () => {
  it('emits one BT..ET run with font, color and the line at the top baseline', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // box [x=0 y=0 w=100 h=100]; top valign, left align, Courier (reuses F0).
    // yTop=100, blockTop=100, baseline0 = 100 - 12 = 88.
    const r = page.AddTextBlock('Hi', [0, 0, 100, 100], { font: 'Courier' });
    const s = decoded(page);
    expect(s).toContain('BT');
    expect(s).toContain('/F0 12 Tf');
    expect(s).toContain('0 0 0 rg');
    expect(s).toContain('0 88 Td');
    expect(s).toContain('(Hi) Tj');
    expect(s).toContain('ET');
    expect(r).toBeNull(); // everything fit
  });

  it('registers the default Helvetica font as a new resource', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock('Hi', [0, 0, 100, 100]);
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(baseFonts(fonts, (o) => doc.resolve(o))).toContain('Helvetica');
  });
});

describe('Page.AddTextBlock overflow / remainder', () => {
  it('returns the unconsumed remainder when the box is too short', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // width 60 wraps "aaa bbb ccc" to ["aaa bbb","ccc"]; height fits one line.
    const r = page.AddTextBlock('aaa bbb ccc', [0, 0, 60, LEADING], { font: 'Courier' });
    expect(r).toBe('ccc');
    expect(decoded(page)).toContain('(aaa bbb) Tj');
  });

  it('returns the whole text and emits nothing when not even one line fits', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const before = page.Contents.length;
    const r = page.AddTextBlock('aaa bbb', [0, 0, 60, LEADING - 1], { font: 'Courier' });
    expect(r).toBe('aaa bbb');
    expect(page.Contents.length).toBe(before); // no content appended
  });
});

describe('Page.AddTextBlock no-op cases return null', () => {
  it('empty text appends nothing and returns null', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const before = page.Contents.length;
    expect(page.AddTextBlock('', [0, 0, 100, 100])).toBeNull();
    expect(page.Contents.length).toBe(before);
  });

  it('all-unencodable text appends nothing and returns null', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const before = page.Contents.length;
    expect(page.AddTextBlock('中文字', [0, 0, 100, 100])).toBeNull();
    expect(page.Contents.length).toBe(before);
  });
});

describe('Page.AddTextBlock horizontal alignment', () => {
  it('centers each line within the box width', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // Courier "Hi" = 14.4 wide; center offset = (100-14.4)/2 = 42.8; x=10 -> 52.8.
    page.AddTextBlock('Hi', [10, 100, 100, 50], { font: 'Courier', align: 'center' });
    // yTop=150, blockTop=150, baseline0 = 150-12 = 138.
    expect(decoded(page)).toContain('52.8 138 Td');
  });

  it('right-aligns each line within the box width', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // right offset = 100-14.4 = 85.6; x=10 -> 95.6.
    page.AddTextBlock('Hi', [10, 100, 100, 50], { font: 'Courier', align: 'right' });
    expect(decoded(page)).toContain('95.6 138 Td');
  });

  it("does not justify a single (final) line — the last-line rule keeps it left", () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // "aaa bbb ccc ddd" = 15 chars = 108 < 200, one line. It is the whole
    // result's final line, so it is never justified: left edge, no Tw emitted.
    const r = page.AddTextBlock('aaa bbb ccc ddd', [0, 0, 200, 100], {
      font: 'Courier', align: 'justify',
    });
    expect(r).toBeNull();
    expect(decoded(page)).toContain('0 88 Td');
    expect(decoded(page)).not.toContain('Tw');
  });

  it('justifies a non-final soft-wrapped line via Tw and resets Tw=0 on the last line', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // width 60 wraps "aaa bbb ccc ddd" -> ["aaa bbb", "ccc ddd"] (both fit h=100).
    // line 1 "aaa bbb": width 50.4, slack 60-50.4=9.6, 1 gap -> Tw 9.6 (justified).
    // line 2 "ccc ddd": final line -> Tw reset to 0 (left fallback).
    const r = page.AddTextBlock('aaa bbb ccc ddd', [0, 0, 60, 100], {
      font: 'Courier', align: 'justify',
    });
    const s = decoded(page);
    expect(r).toBeNull();
    expect(s).toContain('9.6 Tw');
    expect(s).toContain('(aaa bbb) Tj');
    expect(s).toContain('0 Tw');
    expect(s).toContain('(ccc ddd) Tj');
  });

  it('does not justify a single-word line (no inter-word gap), falling back to left', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // "wwwwwwwwww" alone is 72 > 60, emitted as its own (non-final) line with no
    // gap; "yy zzz" follows as the final line. No Tw is ever emitted.
    const r = page.AddTextBlock('wwwwwwwwww yy zzz', [0, 0, 60, 100], {
      font: 'Courier', align: 'justify',
    });
    const s = decoded(page);
    expect(r).toBeNull();
    expect(s).toContain('(wwwwwwwwww) Tj');
    expect(s).toContain('0 88 Td'); // left edge, first line
    expect(s).not.toContain('Tw');
  });
});

describe('Page.AddTextBlock vertical alignment', () => {
  it('top-aligns by default with first baseline below the top edge', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock('Hi', [0, 0, 100, 100], { font: 'Courier' });
    expect(decoded(page)).toContain('0 88 Td'); // 100 - 12
  });

  it('center-aligns the block vertically', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // n=1, blockHeight=14.4; (100-14.4)/2 = 42.8; blockTop=100-42.8=57.2; baseline=45.2.
    page.AddTextBlock('Hi', [0, 0, 100, 100], { font: 'Courier', valign: 'center' });
    expect(decoded(page)).toContain('0 45.2 Td');
  });

  it('bottom-aligns the block vertically', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // blockTop = y + blockHeight = 14.4; baseline = 14.4 - 12 = 2.4.
    page.AddTextBlock('Hi', [0, 0, 100, 100], { font: 'Courier', valign: 'bottom' });
    expect(decoded(page)).toContain('0 2.4 Td');
  });
});

describe('Page.AddTextBlock multi-line stepping', () => {
  it('moves to each subsequent line with a relative Td of -leading', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock('aa\nbb', [0, 0, 100, 100], { font: 'Courier' });
    const s = decoded(page);
    expect(s).toContain('0 88 Td');     // first line absolute
    expect(s).toContain('0 -14.4 Td');  // step to second line
    expect(s).toContain('(aa) Tj');
    expect(s).toContain('(bb) Tj');
  });

  it('honors a custom leading for the line step', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock('aa\nbb', [0, 0, 100, 100], { font: 'Courier', leading: 20 });
    expect(decoded(page)).toContain('0 -20 Td');
  });
});

describe('Page.AddTextBlock opacity', () => {
  it('emits an /ExtGState when opacity < 1', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock('Hi', [0, 0, 100, 100], { font: 'Courier', opacity: 0.5 });
    const s = decoded(page);
    expect(s).toMatch(/\/GS\d+ gs/);
    const gs = page.Resources!.get('ExtGState') as Map<string, any>;
    expect(gs.size).toBeGreaterThan(0);
  });
});

describe('Page.AddTextBlock validation', () => {
  const page = () => Document.Open(buildStampTarget()).Pages[0];

  it('rejects a malformed rect', () => {
    expect(() => page().AddTextBlock('x', [0, 0, 100] as any)).toThrow(TypeError);
    expect(() => page().AddTextBlock('x', [0, 0, 0, 100])).toThrow(TypeError);
    expect(() => page().AddTextBlock('x', [0, 0, 100, 0])).toThrow(TypeError);
    expect(() => page().AddTextBlock('x', [0, 0, NaN, 100])).toThrow(TypeError);
  });

  it('rejects bad align / valign / leading / font', () => {
    expect(() => page().AddTextBlock('x', [0, 0, 9, 9], { align: 'middle' as any })).toThrow(TypeError);
    expect(() => page().AddTextBlock('x', [0, 0, 9, 9], { valign: 'middle' as any })).toThrow(TypeError);
    expect(() => page().AddTextBlock('x', [0, 0, 9, 9], { leading: 0 })).toThrow(TypeError);
    expect(() => page().AddTextBlock('x', [0, 0, 9, 9], { font: 'Comic-Sans' as any })).toThrow(TypeError);
  });
});

describe('Page.AddTextBlock round-trip', () => {
  it('survives Save/Open and the text is extractable', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddTextBlock('Hello flowing world of text', [20, 50, 150, 120], {
      font: 'Times-Roman',
    });
    const reopened = Document.Open(doc.Save());
    const page = reopened.Pages[0];
    expect(page.GetText()).toContain('Hello');
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(baseFonts(fonts, (o) => reopened.resolve(o))).toContain('Times-Roman');
  });
});

describe('AddTextBlock — CJK line-breaking (UAX #14)', () => {
  it('wraps a long space-less CJK run into multiple lines', () => {
    const doc = Document.Open(buildStampTarget());
    // 中=U+4E2D 文=U+6587 字=U+5B57 符=U+7B26 测=U+6D4B 试=U+8BD5
    const cmap: [number, number][] = [[0x4e2d, 10], [0x6587, 11], [0x5b57, 12], [0x7b26, 13], [0x6d4b, 14], [0x8bd5, 15]];
    const font = doc.AddFont(buildOtFontFor({ cmap }));
    // Narrow box → must wrap; previously this emitted one overflowing Td line.
    const rem = doc.Pages[0].AddTextBlock('中文字符测试', [20, 20, 40, 300], { font, fontSize: 12 });
    const body = decoded(doc.Pages[0]);
    expect((body.match(/Td/g) ?? []).length).toBeGreaterThan(1); // >1 positioned line
    expect(rem).toBeNull(); // all lines fit the 300pt height
  });

  it('shaped CJK block wraps and round-trips through GetText', () => {
    const doc = Document.Open(buildStampTarget());
    const cmap: [number, number][] = [[0x4e2d, 10], [0x6587, 11], [0x5b57, 12], [0x7b26, 13]];
    const font = doc.AddFont(buildOtFontFor({ cmap }), { shape: true });
    doc.Pages[0].AddTextBlock('中文字符', [20, 20, 30, 300], { font, fontSize: 12 });
    const round = Document.Open(doc.Save());
    expect(round.Pages[0].GetText().replace(/\s+/g, '')).toContain('中文');
  });
});

describe('AddTextBlock rotate', () => {
  const RECT: [number, number, number, number] = [100, 100, 200, 50];
  const TEXT = 'alpha beta gamma delta epsilon zeta eta theta';

  function drawn(rotate?: number) {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock(TEXT, RECT, {
      font: 'Courier', fontSize: 12, ...(rotate === undefined ? {} : { rotate }),
    });
    return { doc, page, content: decoded(page) };
  }

  /** Bounding box of the block's own text. The fixture page carries pre-existing
   *  "Original" content, which would otherwise dominate the box. */
  function textBBox(page: import('../src/page.js').Page) {
    const q = page.GetTextFragments()
      .filter((f) => !f.text.includes('Original'))
      .flatMap((f) => f.quad);
    const xs = q.filter((_, i) => i % 2 === 0), ys = q.filter((_, i) => i % 2 === 1);
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  it('wraps the block in a rotation about the rect origin', () => {
    // 90 degrees CCW about (100, 100): the matrix that fixes that point is
    // [0 1 -1 0, px + py, py - px] = [0 1 -1 0 200 0].
    const { content } = drawn(90);
    expect(content).toContain('0 1 -1 0 200 0 cm');
  });

  it('turns a wide short block into a tall narrow one', () => {
    const flat = drawn();
    const turned = drawn(90);
    const a = textBBox(flat.page), b = textBBox(turned.page);
    expect(a.w).toBeGreaterThan(a.h);            // wide when unrotated
    expect(b.h).toBeGreaterThan(b.w);            // tall when turned
    // The box turned rather than reflowed, so the dimensions swap. Compared
    // within one font size, not exactly: the extractor groups the rotated run
    // into more fragments than the flat one, and every fragment quad carries
    // its own ascent/descent padding, so the unions differ by a glyph box. That
    // is bounded by one em — the observed gaps are 6 and exactly 12 at
    // fontSize 12. A reflow would move these by tens of points.
    expect(Math.abs(b.h - a.w)).toBeLessThanOrEqual(12);
    expect(Math.abs(b.w - a.h)).toBeLessThanOrEqual(12);
  });

  it('does not change how the text wraps', () => {
    // The box rotates with the content, so line breaking is unaffected — a
    // rotated block must not silently reflow to a different line count.
    const flat = drawn(), turned = drawn(37);
    // Counted on the emitted show operators, one per laid line. NOT on
    // GetTextFragments: the extractor groups runs by orientation, so a rotated
    // block legitimately reports a different fragment count for identical text.
    const lines = (c: string) => (c.match(/Tj/g) ?? []).length;
    expect(lines(flat.content)).toBeGreaterThan(1);
    expect(lines(turned.content)).toBe(lines(flat.content));
  });

  it('leaves measureTextBlock and the remainder alone', () => {
    const doc = Document.Open(buildStampTarget());
    const short: [number, number, number, number] = [100, 100, 120, 30];
    const a = doc.Pages[0].AddTextBlock(TEXT, short, { font: 'Courier', fontSize: 12 });
    const b = Document.Open(buildStampTarget()).Pages[0]
      .AddTextBlock(TEXT, short, { font: 'Courier', fontSize: 12, rotate: 45 });
    expect(b).toBe(a);                            // same overflow remainder
  });

  it('omitting rotate is byte-identical, and rotate 0 emits no matrix', () => {
    const base = drawn().content;
    expect(drawn(0).content).toBe(base);
    expect(base).not.toMatch(/ cm/);
  });

  it('composes with align and valign', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddTextBlock('short', RECT, {
      font: 'Courier', fontSize: 12, align: 'right', valign: 'bottom', rotate: 90,
    });
    // The alignment is applied in the block's own space, then the whole thing
    // turns: one rotation for the block, not one per line.
    const c = decoded(doc.Pages[0]);
    expect((c.match(/ cm/g) ?? []).length).toBe(1);
  });

  it('rejects a non-finite rotate', () => {
    const doc = Document.Open(buildStampTarget());
    expect(() => doc.Pages[0].AddTextBlock('x', RECT, { rotate: NaN }))
      .toThrow(/rotate must be a finite number/);
    expect(() => doc.Pages[0].AddTextBlock('x', RECT, { rotate: 'sideways' as never }))
      .toThrow(/rotate must be a finite number/);
  });
});
