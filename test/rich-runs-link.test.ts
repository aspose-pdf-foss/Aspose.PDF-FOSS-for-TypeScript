import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { TextRun } from '../src/textdecor.js';

const page = () => {
  const doc = Document.New();
  return { doc, page: doc.AddPage(PageFormat.A4).page };
};

describe('TextRun.link validation', () => {
  it('rejects a non-string link', () => {
    const { page: p } = page();
    expect(() => p.AddTextBlock(
      [{ text: 'a', link: 42 as unknown as string }], [50, 50, 200, 100],
    )).toThrow(TypeError);
  });

  it('rejects an empty link', () => {
    const { page: p } = page();
    expect(() => p.AddTextBlock(
      [{ text: 'a', link: '' }], [50, 50, 200, 100],
    )).toThrow(TypeError);
  });

  it('names the offending run index in the message', () => {
    const { page: p } = page();
    const runs: TextRun[] = [{ text: 'ok' }, { text: 'bad', link: '' }];
    expect(() => p.AddTextBlock(runs, [50, 50, 200, 100])).toThrow(/run 1/);
  });

  it('leaves the page untouched when a run is rejected', () => {
    const { page: p } = page();
    const before = p.GetText();
    expect(() => p.AddTextBlock(
      [{ text: 'drawn' }, { text: 'bad', link: '' }], [50, 50, 200, 100],
    )).toThrow(TypeError);
    expect(p.GetText()).toBe(before);
    expect(p.Annotations.length).toBe(0);
  });

  it('accepts a valid link', () => {
    const { page: p } = page();
    expect(() => p.AddTextBlock(
      [{ text: 'a', link: 'https://example.com' }], [50, 50, 200, 100],
    )).not.toThrow();
  });
});

describe('link annotations from runs', () => {
  it('places one /Link over the linked run', () => {
    const { page: p } = page();
    p.AddTextBlock(
      [{ text: 'go to ' }, { text: 'the site', link: 'https://example.com' }, { text: ' now' }],
      [50, 500, 300, 200], { fontSize: 12 },
    );
    const links = p.Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBe(1);
    expect((links[0] as { Action?: unknown }).Action)
      .toEqual({ type: 'uri', uri: 'https://example.com' });
  });

  it('puts the rect on the linked glyphs, not the whole line', () => {
    const { page: p } = page();
    // The linked run carries its OWN FONT so the text extractor splits it into
    // its own fragment. A link leaves no trace in the text state, so three
    // same-font runs merge into one fragment whose quad spans the whole line —
    // an anchor that would accept a rect covering 'go to the site now'.
    p.AddTextBlock(
      [{ text: 'go to ' },
       { text: 'the site', font: 'Helvetica-Bold', link: 'https://example.com' },
       { text: ' now' }],
      [50, 500, 300, 200], { fontSize: 12 },
    );
    const rect = p.Annotations.filter((a) => a.Subtype === 'Link')[0].Rect!;
    const frag = p.GetTextFragments().find((f) => f.text.includes('the site'))!;
    // Independent path: the fragment quad comes from the text extractor, the
    // rect from the annotation dict.
    expect(Math.abs(rect[0] - frag.quad[0])).toBeLessThan(1);
    // The RIGHT edge is deliberately not `≈ frag.quad[2]`. The separator space
    // belongs to the run that paints it, so this fragment is 'the site ' —
    // including the space — while the rect stops at the last glyph (2avp). An
    // equality here would assert the defect that issue removed. Bound it:
    // strictly inside, by no more than one space advance.
    const space = 0.278 * 12;   // every Helvetica face's space is 278/1000
    expect(rect[2]).toBeLessThan(frag.quad[2]);
    expect(rect[2]).toBeGreaterThan(frag.quad[2] - space - 0.5);
    // It starts past the unlinked lead-in and ends before the box edge, so it
    // covers neither neighbour.
    expect(rect[0]).toBeGreaterThan(50);
    expect(rect[2]).toBeLessThan(50 + 300);
  });

  it('places nothing when no run carries a link', () => {
    const { page: p } = page();
    p.AddTextBlock([{ text: 'plain' }, { text: 'text', underline: true }],
      [50, 500, 300, 200]);
    expect(p.Annotations.filter((a) => a.Subtype === 'Link').length).toBe(0);
  });

  it('gives two adjacent links their own annotations', () => {
    const { page: p } = page();
    p.AddTextBlock(
      [{ text: 'one', link: 'https://a.example' }, { text: 'two', link: 'https://b.example' }],
      [50, 500, 300, 200],
    );
    const uris = p.Annotations
      .filter((a) => a.Subtype === 'Link')
      .map((a) => (a as { Action?: { uri?: string } }).Action?.uri)
      .sort();
    expect(uris).toEqual(['https://a.example', 'https://b.example']);
  });

  it('places one rect per line for a link that wraps', () => {
    const { page: p } = page();
    p.AddTextBlock(
      [{ text: 'lead in ' },
       { text: 'a very long link label that must wrap across two lines here',
         link: 'https://example.com' }],
      // Narrow box: the label cannot fit on one line.
      [50, 400, 120, 300], { fontSize: 12 },
    );
    const links = p.Annotations.filter((a) => a.Subtype === 'Link');
    expect(links.length).toBeGreaterThan(1);
    // Every rect carries the same destination.
    for (const l of links)
      expect((l as { Action?: { uri?: string } }).Action?.uri).toBe('https://example.com');
    // They sit on different baselines.
    const ys = new Set(links.map((l) => Math.round(l.Rect![1])));
    expect(ys.size).toBe(links.length);
  });
});
