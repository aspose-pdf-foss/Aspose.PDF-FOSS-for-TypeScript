import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseContentStream, type ContentOp } from '../src/content.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { findRanges } from '../src/textedit.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { isName } from '../src/types.js';
import { renderPageRgb } from '../src/raster.js';
import { buildAnnotTextPdf } from './helpers/build-annot-text-pdf.js';
import { buildSimpleTextPdf, buildFormTextPdf, buildMultiPageTextPdf, buildToUnicodePdf } from './helpers/build-text-pdf.js';

const plain = (stream: string) => Document.Open(buildSimpleTextPdf(stream));
const LINE = (s: string) => `BT /F1 12 Tf 20 250 Td (${s}) Tj ET`;
const ops = (doc: Document): ContentOp[] => parseContentStream(doc.Pages[0].Contents);
/** Each op as text: operator plus its numeric and name operands. */
const opText = (op: ContentOp): string => [
  ...op.operands.map((o) => (typeof o === 'number' ? String(o) : isName(o) ? `/${o.name}` : '…')),
  op.operator,
].join(' ');
const glyphs = (doc: Document, page = 0): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[page], { glyph: (g) => out.push(g) });
  return out;
};
const colorOf = (doc: Document, ch: string): unknown => glyphs(doc).find((g) => g.text === ch)?.color;

describe('findRanges: ignoreCase and wholeWord (u3l5.3)', () => {
  it('matches a string case-insensitively', () => {
    expect(findRanges('Hello HELLO hello', 'hello', { ignoreCase: true })).toEqual([[0, 5], [6, 11], [12, 17]]);
    expect(findRanges('Hello HELLO hello', 'hello')).toEqual([[12, 17]]);
  });

  it('gives a RegExp the i flag', () => {
    expect(findRanges('aB ab', /ab/, { ignoreCase: true })).toEqual([[0, 2], [3, 5]]);
  });

  it('treats a string literally, `-` and `.` included', () => {
    expect(findRanges('A-B axb a.b', 'a-b', { ignoreCase: true })).toEqual([[0, 3]]);
    expect(findRanges('A-B axb a.b', 'a.b', { wholeWord: true })).toEqual([[8, 11]]);
  });

  it('accepts only matches not inside a longer word', () => {
    expect(findRanges('cat concat cat_x cats cat. 9cat cat', 'cat', { wholeWord: true }))
      .toEqual([[0, 3], [22, 25], [32, 35]]);
  });

  it('resumes one code unit on after a rejected match', () => {
    expect(findRanges('ba a a', 'a a', { wholeWord: true })).toEqual([[3, 6]]);
    expect(findRanges('ba a a', /a a/, { wholeWord: true })).toEqual([[3, 6]]);
  });

  it('reads an astral neighbour whole', () => {
    expect(findRanges('\u{1D400}cat', 'cat', { wholeWord: true })).toEqual([]);
    expect(findRanges('\u{1F600}cat', 'cat', { wholeWord: true })).toEqual([[2, 5]]);
    expect(findRanges('cat\u{1D400}', 'cat', { wholeWord: true })).toEqual([]);
  });

  it('counts a combining mark as part of the word', () => {
    expect(findRanges('café cafe', 'cafe', { wholeWord: true })).toEqual([[6, 10]]);
  });
});

describe('the search options reach every search entry point', () => {
  it('Search and ReplaceText', () => {
    const doc = plain(LINE('Cat cat concat'));
    expect(doc.Pages[0].Search('cat', { ignoreCase: true, wholeWord: true })).toHaveLength(2);
    expect(doc.Pages[0].ReplaceText('cat', 'dog', { ignoreCase: true, wholeWord: true })).toBe(2);
    expect(doc.Pages[0].GetText()).toBe('dog dog concat');
  });

  it('doc.ReplaceText takes the same options on every page', () => {
    const doc = Document.Open(buildMultiPageTextPdf([LINE('Cat concat'), LINE('CAT cats')]));
    expect(doc.ReplaceText('cat', 'dog', { ignoreCase: true, wholeWord: true })).toBe(2);
    expect(doc.Pages.map((p) => p.GetText())).toEqual(['dog concat', 'dog cats']);
  });

  it('ReplaceText honours region', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (cat) Tj ET BT /F1 12 Tf 20 100 Td (cat) Tj ET');
    expect(doc.Pages[0].ReplaceText('cat', 'dog', { region: [0, 200, 300, 300] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('dog\ncat');
  });

  it('SearchAnnotations', () => {
    const p = Document.Open(buildAnnotTextPdf()).Pages[0];
    expect(p.SearchAnnotations('BRAVO')).toHaveLength(0);
    expect(p.SearchAnnotations('BRAVO', { ignoreCase: true })).toHaveLength(1);
  });

  it('RedactText and MarkRedactText', () => {
    // Forwarded, the two keys find both capitalised words; dropped, only the
    // 'cat' inside 'concat' — so the COUNT tells the readings apart.
    const a = plain(LINE('Cat CAT concat'));
    expect(a.Pages[0].RedactText('cat', { ignoreCase: true, wholeWord: true })).toBe(2);
    expect(a.Pages[0].GetText()).toContain('concat');
    const b = plain(LINE('Cat CAT concat'));
    expect(b.Pages[0].MarkRedactText('cat', { ignoreCase: true, wholeWord: true })).toBe(2);
    const annot = b.Pages[0].Annotations[0].Dict;
    expect(annot.has('ignoreCase') || annot.has('wholeWord') || annot.has('includeHidden')).toBe(false);
  });
});

describe('ReplaceText styles the replacement (u3l5.3)', () => {
  it('sets a colour and restores the initial fill after it', () => {
    const doc = plain(LINE('aXb'));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    expect(doc.Pages[0].GetText()).toBe('aYb');
    expect(ops(doc).map(opText)).toEqual([
      'BT', '/F1 12 Tf', '20 250 Td', '… Tj', '1 0 0 rg', '… Tj', '0 g', '… Tj', 'ET',
    ]);
    expect(colorOf(doc, 'Y')).toEqual([255, 0, 0]);
    expect(colorOf(doc, 'a')).toBeUndefined();
    expect(colorOf(doc, 'b')).toBeUndefined();
  });

  it('restores a device fill set before', () => {
    const doc = plain(`0 0 1 rg ${LINE('aXb')}`);
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    expect(colorOf(doc, 'Y')).toEqual([255, 0, 0]);
    expect(colorOf(doc, 'b')).toEqual([0, 0, 255]);
  });

  it('restores a fill set through cs and sc, colour space first', () => {
    const doc = plain(`/DeviceCMYK cs 1 0 0 0 sc ${LINE('aXb')}`);
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    const t = ops(doc).map(opText);
    expect(t.slice(t.indexOf('1 0 0 rg'))).toEqual(['1 0 0 rg', '… Tj', '/DeviceCMYK cs', '1 0 0 0 sc', '… Tj', 'ET']);
    expect(colorOf(doc, 'b')).toEqual(colorOf(plain(`/DeviceCMYK cs 1 0 0 0 sc ${LINE('b')}`), 'b'));
  });

  it('restores a fill the q stack put back', () => {
    const doc = plain(`0 0 1 rg q 0 1 0 rg Q ${LINE('aXb')}`);
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    expect(colorOf(doc, 'b')).toEqual([0, 0, 255]);
  });

  it('restores a device fill a form inherited from the page', () => {
    const doc = Document.Open(buildFormTextPdf('0 0 1 rg /Fm0 Do', LINE('aXb')));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    expect(colorOf(doc, 'Y')).toEqual([255, 0, 0]);
    expect(colorOf(doc, 'b')).toEqual([0, 0, 255]);
  });

  it('refuses to restore a name the scope that set it does not hold, changing nothing', () => {
    const doc = Document.Open(buildFormTextPdf('/Pattern cs /P0 scn /Fm0 Do', LINE('aXb')));
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] })).toThrow(/\/P0 is not in the scope/);
    expect(doc.Save()).toEqual(before);
  });
});

describe('ReplaceText restores a colour named in another scope (u3l5.9)', () => {
  // Index 1 is green on the page; the form's own /CS0 is a DIFFERENT space,
  // whose index 1 is red — so a restore that re-emitted `/CS0` unchanged, or
  // overwrote the form's entry, draws the text after the replacement red.
  const GREEN = '/ColorSpace << /CS0 [/Indexed /DeviceRGB 1 <0000FF00FF00>] >>';
  const RED = '/ColorSpace << /CS0 [/Indexed /DeviceRGB 1 <FF0000FF0000>] >>';
  const formRes = (doc: Document) => {
    const xo = doc.resolve((doc.resolve(doc.Pages[0].Resources!.get('XObject')) as Map<string, unknown>).get('Fm0') as never) as { dict: Map<string, unknown> };
    return doc.resolve(xo.dict.get('Resources') as never) as Map<string, unknown>;
  };
  it('copies the colour space into the form under a fresh key when its own name is taken', () => {
    const doc = Document.Open(buildFormTextPdf('/CS0 cs 1 sc /Fm0 Do', LINE('aXb'), { pageRes: GREEN, formRes: RED }));
    expect(colorOf(doc, 'b')).toEqual([0, 255, 0]);
    doc.Pages[0].ReplaceText('X', 'Y', { color: [0, 0, 1] });
    expect(colorOf(doc, 'Y')).toEqual([0, 0, 255]);
    expect(colorOf(doc, 'b')).toEqual([0, 255, 0]);
    const cs = doc.resolve(formRes(doc).get('ColorSpace') as never) as Map<string, unknown>;
    expect([...cs.keys()]).toEqual(['CS0', 'CS1']);
    expect(colorOf(Document.Open(doc.Save()), 'b')).toEqual([0, 255, 0]);
  });

  it('reuses the key that already names the same object in the form', () => {
    const doc = Document.Open(buildFormTextPdf('/CS0 cs 1 sc /Fm0 Do', LINE('aXb'), {
      pageRes: '/ColorSpace << /CS0 7 0 R >>', formRes: '/ColorSpace << /Mine 7 0 R >>',
      extra: ['[/Indexed /DeviceRGB 1 <0000FF00FF00>]'],
    }));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [0, 0, 1] });
    expect(colorOf(doc, 'b')).toEqual([0, 255, 0]);
    const cs = doc.resolve(formRes(doc).get('ColorSpace') as never) as Map<string, unknown>;
    expect([...cs.keys()]).toEqual(['Mine']);
  });

  it('copies nothing for a form that inherits the page resources', () => {
    const doc = Document.Open(buildFormTextPdf('/CS0 cs 1 sc /Fm0 Do', LINE('aXb'), { pageRes: GREEN, formResources: false }));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [0, 0, 1] });
    expect(colorOf(doc, 'b')).toEqual([0, 255, 0]);
  });

  it('copies a pattern named on the page into the form', () => {
    const tile = '0 0 1 rg 0 0 5 5 re f';
    const doc = Document.Open(buildFormTextPdf('/Pattern cs /P0 scn /Fm0 Do', LINE('aXb'), {
      pageRes: '/Pattern << /P0 7 0 R >>',
      extra: [`<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> /Length ${tile.length} >>\nstream\n${tile}\nendstream`],
    }));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    const pat = doc.resolve(formRes(doc).get('Pattern') as never) as Map<string, { num: number }>;
    expect([...pat.keys()]).toEqual(['P0']);
    expect(pat.get('P0')!.num).toBe(7);
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toBe('aYb');
  });

});

describe('ReplaceText colours the stroke of stroked text (u3l5.9)', () => {
  // 48pt, stroked blue: the replacement must be stroked red, and what follows
  // stroked blue again.
  const STROKED = (mode: number) => `0 0 1 RG 2 w BT /F1 48 Tf ${mode} Tr 20 200 Td (aXb) Tj ET`;
  const inkIn = (doc: Document, ch: string, pred: (r: number, g: number, b: number) => boolean): number => {
    const q = glyphs(doc).find((g) => g.text === ch)!.quad;
    const { width, rgb, device } = renderPageRgb(doc, doc.Pages[0], 1);
    const [x0, y0] = [q[0] * device[0] + q[1] * device[2] + device[4], q[0] * device[1] + q[1] * device[3] + device[5]];
    const [x1, y1] = [q[2] * device[0] + q[3] * device[2] + device[4], q[2] * device[1] + q[3] * device[3] + device[5]];
    let n = 0;
    // Inset by 3px: a neighbour's 2pt stroke reaches across the shared edge.
    for (let y = Math.floor(Math.min(y0, y1)) + 3; y < Math.ceil(Math.max(y0, y1)) - 3; y++) {
      for (let x = Math.floor(Math.min(x0, x1)) + 3; x < Math.ceil(Math.max(x0, x1)) - 3; x++) {
        const i = (y * width + x) * 3;
        if (pred(rgb[i], rgb[i + 1], rgb[i + 2])) n++;
      }
    }
    return n;
  };
  const red = (r: number, g: number, b: number) => r > 180 && g < 90 && b < 90;
  const blue = (r: number, g: number, b: number) => b > 180 && r < 90 && g < 90;

  it('sets and restores the stroke colour for stroke-only text', () => {
    const doc = plain(STROKED(1));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    const t = ops(doc).map(opText);
    const at = t.indexOf('1 0 0 rg');
    expect(t.slice(at, at + 5)).toEqual(['1 0 0 rg', '1 0 0 RG', '… Tj', '0 g', '0 0 1 RG']);
    expect(inkIn(doc, 'Y', red)).toBeGreaterThan(20);
    expect(inkIn(doc, 'Y', blue)).toBe(0);
    expect(inkIn(doc, 'b', blue)).toBeGreaterThan(20);
    expect(inkIn(doc, 'b', red)).toBe(0);
  });

  it('colours both for fill-and-stroke text', () => {
    const doc = plain(STROKED(2));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    expect(ops(doc).map(opText)).toContain('1 0 0 RG');
    expect(inkIn(doc, 'Y', blue)).toBe(0);
  });

  it('writes no stroke operators for text that only fills', () => {
    const doc = plain(STROKED(0));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    expect(ops(doc).map(opText).filter((s) => s.endsWith(' RG'))).toEqual(['0 0 1 RG']);
  });

  it('restores a named space set in the same scope', () => {
    const doc = plain(`/Pattern cs /P0 scn ${LINE('aXb')}`);
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    const t = ops(doc).map(opText);
    expect(t.slice(t.indexOf('1 0 0 rg'), t.indexOf('1 0 0 rg') + 4)).toEqual(['1 0 0 rg', '… Tj', '/Pattern cs', '/P0 scn']);
  });

  it('sets the size in points as rendered', () => {
    const doc = plain(LINE('aXb'));
    doc.Pages[0].ReplaceText('X', 'Y', { fontSize: 24 });
    expect(ops(doc).map(opText)).toEqual([
      'BT', '/F1 12 Tf', '20 250 Td', '… Tj', '/F1 24 Tf', '… Tj', '/F1 12 Tf', '… Tj', 'ET',
    ]);
    const scaled = plain(`2 0 0 2 0 0 cm ${LINE('aXb')}`);
    scaled.Pages[0].ReplaceText('X', 'Y', { fontSize: 12 });
    expect(ops(scaled).map(opText)).toContain('/F1 6 Tf');
    expect(glyphs(scaled).find((g) => g.text === 'Y')?.fontSize).toBeCloseTo(12);
  });

  it('writes the replacement in the named font and leaves its neighbours alone', () => {
    const doc = plain(LINE('aXb'));
    doc.Pages[0].ReplaceText('X', 'YY', { font: 'Courier', fontSize: 10, color: [0, 0, 1] });
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe('aYYb');
    const g = glyphs(doc);
    expect(g.filter((e) => e.text === 'Y').map((e) => e.font.name)).toEqual(['Courier', 'Courier']);
    expect(g.find((e) => e.text === 'b')?.font.name).toBe('Helvetica');
    expect(g.find((e) => e.text === 'Y')?.fontSize).toBeCloseTo(10);
    expect(g.find((e) => e.text === 'b')?.fontSize).toBeCloseTo(12);
  });

  it('styles nothing but the replacement in a match that spans residue', () => {
    const doc = plain(LINE('abc'));
    doc.Pages[0].ReplaceText('b', 'B', { color: [1, 0, 0] });
    expect(['a', 'B', 'c'].map((c) => colorOf(doc, c))).toEqual([undefined, [255, 0, 0], undefined]);
  });

  it('keeps a ligature residue unstyled beside a styled replacement in ONE glyph', () => {
    // 0xC8 is one glyph drawing "fi": replacing "f" writes the replacement and
    // the residue "i" into one edit, where only the run style keeps them apart.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '3 beginbfchar <C8> <00660069> <6E> <006E> <65> <0065> endbfchar\n';
    const doc = Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <C86E65> Tj ET', cmap));
    doc.Pages[0].ReplaceText('f', 'x', { color: [1, 0, 0] });
    expect(doc.Pages[0].GetText()).toBe('xine');
    expect(['x', 'i', 'n'].map((c) => colorOf(doc, c))).toEqual([[255, 0, 0], undefined, undefined]);
  });

  it('refuses a font or size change where no font can be named, changing nothing', () => {
    const doc = Document.Open(buildFormTextPdf('q /Fm0 Do Q', LINE('aXb'), { formResources: false }));
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('X', 'Y', { fontSize: 20 })).toThrow(UnsupportedFeatureError);
    expect(() => doc.Pages[0].ReplaceText('X', 'Y', { font: 'Courier' })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('still colours there, and an empty styled replacement is not refused', () => {
    const doc = Document.Open(buildFormTextPdf('q /Fm0 Do Q', LINE('aXbZ'), { formResources: false }));
    doc.Pages[0].ReplaceText('X', 'Y', { color: [1, 0, 0] });
    expect(colorOf(doc, 'Y')).toEqual([255, 0, 0]);
    expect(doc.Pages[0].ReplaceText('Z', '', { fontSize: 20 })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('aYb');
  });
});

describe('ReplaceText option validation (u3l5.3)', () => {
  const doc = plain(LINE('aXb'));
  const bad = (o: object) => () => doc.Pages[0].ReplaceText('X', 'Y', o);
  it('refuses the wrong kind of thing with TypeError', () => {
    expect(bad({ font: 'Arial' })).toThrow(TypeError);
    expect(bad({ fontSize: '12' })).toThrow(TypeError);
    expect(bad({ color: [1, 0] })).toThrow(TypeError);
    expect(bad({ color: 'red' })).toThrow(TypeError);
    expect(bad({ ignoreCase: 'yes' })).toThrow(TypeError);
    expect(bad({ wholeWord: 1 })).toThrow(TypeError);
  });
  it('refuses a value outside its range with RangeError', () => {
    expect(bad({ fontSize: 0 })).toThrow(RangeError);
    expect(bad({ fontSize: Infinity })).toThrow(RangeError);
    expect(bad({ color: [1.5, 0, 0] })).toThrow(RangeError);
    expect(bad({ color: [Number.NaN, 0, 0] })).toThrow(RangeError);
  });
  it('validates on the document entry point before any page changes', () => {
    const d = Document.Open(buildMultiPageTextPdf([LINE('aXb'), LINE('aXb')]));
    const before = d.Save();
    expect(() => d.ReplaceText('X', 'Y', { fontSize: -1 })).toThrow(RangeError);
    expect(d.Save()).toEqual(before);
  });
});
