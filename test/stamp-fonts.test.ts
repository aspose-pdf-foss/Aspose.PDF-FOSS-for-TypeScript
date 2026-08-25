import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isName } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

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

describe('Page.MeasureText with font selection', () => {
  it('measures Courier as a monospace n*600/1000*size run', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    // "Hello" = 5 glyphs * 600/1000 * 12 = 36
    expect(page.MeasureText('Hello', 12, 'Courier')).toBeCloseTo(36, 6);
  });

  it('defaults to Helvetica when font omitted', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(page.MeasureText('Hello', 12)).toBeCloseTo(27.336, 3);
  });

  it('measures Times-Bold from its own width table', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    // Times-Bold: H778 i278 = 1056 -> 12pt = 12.672
    expect(page.MeasureText('Hi', 12, 'Times-Bold')).toBeCloseTo(12.672, 3);
  });
});

describe('Page.AddText with font selection', () => {
  it('emits a Times-Bold /Font resource', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100, { font: 'Times-Bold' });
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(baseFonts(fonts, (o) => doc.resolve(o))).toContain('Times-Bold');
  });

  it('reuses an existing matching /BaseFont (Courier) instead of adding one', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    const before = fonts.size;
    page.AddText('Mono', 10, 10, { font: 'Courier' });
    expect(fonts.size).toBe(before); // F0 Courier reused
  });

  it('registers a selected font only once across two calls', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('A', 10, 10, { font: 'Times-Italic' });
    page.AddText('B', 10, 30, { font: 'Times-Italic' });
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    const times = baseFonts(fonts, (o) => doc.resolve(o)).filter((n) => n === 'Times-Italic');
    expect(times.length).toBe(1);
  });

  it('center align uses the selected font width table', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // Courier "Hi" = 2*600/1000*12 = 14.4; half = 7.2; tx = 100 - 7.2 = 92.8
    page.AddText('Hi', 100, 50, { font: 'Courier', align: 'center' });
    expect(decoded(page)).toContain('1 0 0 1 92.8 50 Tm');
  });

  it('round-trips: the selected font survives Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddText('Bold text', 20, 50, { font: 'Times-Bold' });
    const reopened = Document.Open(doc.Save());
    const page = reopened.Pages[0];
    expect(page.GetText()).toContain('Bold text');
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(baseFonts(fonts, (o) => reopened.resolve(o))).toContain('Times-Bold');
  });

  it('rejects an unknown font name with TypeError', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(() => page.AddText('x', 0, 0, { font: 'Comic-Sans' as any })).toThrow(TypeError);
  });

  it('rejects Symbol/ZapfDingbats (no WinAnsi encoder) with TypeError', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(() => page.AddText('x', 0, 0, { font: 'Symbol' as any })).toThrow(TypeError);
    expect(() => page.AddText('x', 0, 0, { font: 'ZapfDingbats' as any })).toThrow(TypeError);
  });
});
