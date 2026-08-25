import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isName } from '../src/types.js';
import { buildStampTarget, buildInheritedResourcesTarget } from './helpers/build-stamp-target.js';
import { flowTextBlock, measureTextBlock, measureText, wrapLines } from '../src/stamp.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

function helveticaCount(fonts: Map<string, any>, resolve: (o: any) => any): number {
  let n = 0;
  for (const v of fonts.values()) {
    const d = resolve(v);
    if (isDict(d)) {
      const bf = resolve(d.get('BaseFont'));
      const en = resolve(d.get('Encoding'));
      if (isName(bf) && bf.name === 'Helvetica' && isName(en) && en.name === 'WinAnsiEncoding') n++;
    }
  }
  return n;
}

describe('Page.MeasureText', () => {
  it('measures Helvetica width in points', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(page.MeasureText('Hello', 12)).toBeCloseTo(27.336, 3);
  });

  it('defaults to 12pt', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(page.MeasureText('Hello')).toBeCloseTo(27.336, 3);
  });
});

describe('Page.AddText', () => {
  it('round-trips: existing content and stamped text both survive Save', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddText('Stamped', 20, 50);
    const reopened = Document.Open(doc.Save());
    const text = reopened.Pages[0].GetText();
    expect(text).toContain('Original');
    expect(text).toContain('Stamped');
  });

  it('emits a Helvetica font and an isolating q/Q stamp', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100);
    const c = decoded(page);
    expect(c).toContain('BT');
    expect(c).toContain('Tj');
    expect(c).toContain(' Tm');
    expect(c).toMatch(/q[\s\S]*Q/);
  });

  it('registers the Helvetica font only once across two calls', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('A', 10, 10);
    page.AddText('B', 10, 30);
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(helveticaCount(fonts, (o) => doc.resolve(o))).toBe(1);
  });

  it('left align places the baseline origin exactly at (x, y)', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 50);
    expect(decoded(page)).toContain('1 0 0 1 100 50 Tm');
  });

  it('center align shifts the origin left by half the width', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // "Hi": H722 i222 = 944 -> 12pt width 11.328; half = 5.664; tx = 94.336
    page.AddText('Hi', 100, 50, { align: 'center' });
    expect(decoded(page)).toContain('1 0 0 1 94.336 50 Tm');
  });

  it('rotation writes the rotation matrix', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 50, { rotate: 90 });
    expect(decoded(page)).toContain('0 1 -1 0 100 50 Tm');
  });

  it('preserves inherited resources (no shadowing)', () => {
    const doc = Document.Open(buildInheritedResourcesTarget());
    doc.Pages[0].AddText('Stamped', 20, 50);
    const reopened = Document.Open(doc.Save());
    const page = reopened.Pages[0];
    expect(page.GetText()).toContain('Inherited');
    expect(page.GetText()).toContain('Stamped');
    // The page now owns a /Resources/Font with both Courier (F0) and Helvetica.
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(fonts.size).toBeGreaterThanOrEqual(2);
  });

  it('drops unencodable characters and no-ops on empty text', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const before = page.Contents.length;
    page.AddText('', 10, 10);
    expect(page.Contents.length).toBe(before); // empty -> no change
    page.AddText('\u{1F600}', 10, 10); // all dropped -> no change
    expect(page.Contents.length).toBe(before);
  });

  it('rejects invalid options with TypeError', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(() => page.AddText('x', 0, 0, { opacity: 2 })).toThrow(TypeError);
    expect(() => page.AddText('x', 0, 0, { fontSize: 0 })).toThrow(TypeError);
    expect(() => page.AddText('x', 0, 0, { color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => page.AddText('x', 0, 0, { rotate: Infinity })).toThrow(TypeError);
  });
});

describe('Page.AddText opacity', () => {
  it('opacity < 1 registers one /ExtGState and emits gs', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Faint', 10, 10, { opacity: 0.5 });
    const gs = page.Resources!.get('ExtGState') as Map<string, any>;
    expect(gs.size).toBe(1);
    const entry = doc.resolve([...gs.values()][0]) as Map<string, any>;
    expect(doc.resolve(entry.get('ca'))).toBe(0.5);
    expect(doc.resolve(entry.get('CA'))).toBe(0.5);
    expect(decoded(page)).toMatch(/\/GS0 gs/);
  });

  it('reuses one /ExtGState for equal opacity across calls', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('A', 10, 10, { opacity: 0.5 });
    page.AddText('B', 10, 30, { opacity: 0.5 });
    const gs = page.Resources!.get('ExtGState') as Map<string, any>;
    expect(gs.size).toBe(1);
  });

  it('opacity 1 registers no /ExtGState and emits no gs', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Solid', 10, 10);
    expect(page.Resources!.get('ExtGState')).toBeUndefined();
    expect(decoded(page)).not.toContain(' gs');
  });
});

describe('flowTextBlock', () => {
  it('reports usedHeight = lines * leading and no remainder when it all fits', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const r = flowTextBlock(doc, page, 'one two three', [72, 600, 400, 200],
      { font: 'Helvetica', fontSize: 10, leading: 12 });
    expect(r.remainder).toBeNull();
    expect(r.usedHeight).toBeCloseTo(12, 6); // single line
  });

  it('clips to the box height and returns the overflow as remainder', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    // Box only tall enough for 2 lines at leading 12.
    const text = 'aaa\nbbb\nccc\nddd';
    const r = flowTextBlock(doc, page, text, [72, 600, 40, 24],
      { font: 'Helvetica', fontSize: 10, leading: 12 });
    expect(r.usedHeight).toBeCloseTo(24, 6); // 2 lines
    expect(r.remainder).toContain('ccc');
  });

  it('returns usedHeight 0 and null remainder for empty text', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const r = flowTextBlock(doc, page, '', [72, 600, 400, 200], { fontSize: 10, leading: 12 });
    expect(r.usedHeight).toBe(0);
    expect(r.remainder).toBeNull();
  });
});

describe('measureTextBlock', () => {
  const text = Array.from({ length: 12 }, (_, i) => `word${i}`).join(' ');
  const opts = { font: 'Helvetica' as const, fontSize: 12, leading: 16 };

  it('agrees with flowTextBlock usedHeight and remainder (fits fully)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [x, y, w, h] = [50, 50, 400, 400];
    const drawn = flowTextBlock(doc, page, text, [x, y, w, h], opts);
    const measured = measureTextBlock(text, w, h, opts);
    expect(measured.usedHeight).toBeCloseTo(drawn.usedHeight, 9);
    expect(measured.remainder).toBe(drawn.remainder);
  });

  it('agrees with flowTextBlock when the box clips to a few lines (overflow)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [x, y, w, h] = [50, 50, 120, 34]; // ~2 lines at leading 16
    const drawn = flowTextBlock(doc, page, text, [x, y, w, h], opts);
    const measured = measureTextBlock(text, w, h, opts);
    expect(measured.usedHeight).toBeCloseTo(drawn.usedHeight, 9);
    expect(measured.remainder).toBe(drawn.remainder);
  });

  it('draws nothing (page content unchanged)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const before = new TextDecoder('latin1').decode(page.Contents);
    measureTextBlock(text, 120, 400, opts);
    const after = new TextDecoder('latin1').decode(page.Contents);
    expect(after).toBe(before);
  });

  it('returns zero height / null remainder for empty text', () => {
    expect(measureTextBlock('', 200, 200, opts)).toEqual({ usedHeight: 0, remainder: null });
  });
});

describe('wrapLines', () => {
  it('breaks at the box width and reports each line width', () => {
    const lines = wrapLines('alpha beta gamma delta', 60, { font: 'Helvetica', fontSize: 12 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.text).join(' ')).toBe('alpha beta gamma delta');
    for (const l of lines) {
      expect(l.width).toBeLessThanOrEqual(60);
      expect(l.width).toBeCloseTo(measureText(l.text, 12, 'Helvetica'), 6);
    }
  });

  it('is height-unbounded: no line is dropped however many there are', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const lines = wrapLines(text, 60, { font: 'Helvetica', fontSize: 12 });
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.map((l) => l.text).join(' ')).toBe(text);
  });

  it('returns [] for empty or unencodable text', () => {
    expect(wrapLines('', 100)).toEqual([]);
  });

  it('rejects a non-positive width', () => {
    expect(() => wrapLines('a', 0)).toThrow(TypeError);
  });
});

describe('stampText — artifact marked content', () => {
  it('wraps the stamp in /Artifact BMC … EMC', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('decoration', 100, 700, { artifact: true });
    const content = decoded(page);
    expect(content).toContain('/Artifact BMC');
    expect(content).toContain('EMC');
    // No MCID: an artifact belongs to no element.
    expect(content).not.toContain('/MCID');
  });

  it('reads back as an artifact fragment', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('plain', 100, 700);
    page.AddText('decoration', 100, 680, { artifact: true });
    // The artifact flag lives on the glyph events, not on TextFragment.
    const glyphs: GlyphEvent[] = [];
    visitContent(doc, page, { glyph: (e) => glyphs.push(e) });
    const inArtifact = glyphs.filter((g) => g.artifact).map((g) => g.text).join('');
    expect(inArtifact).toContain('decoration');
    expect(inArtifact).not.toContain('plain');
  });

  it('rejects artifact together with tag', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    expect(() => page.AddText('x', 100, 700, { artifact: true, tag: el })).toThrow(TypeError);
    // Nothing drawn.
    expect(decoded(page)).not.toContain('(x) Tj');
  });
});
