import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document, PageFormat, UnsupportedFeatureError } from '../src/index.js';
import type { Page } from '../src/page.js';

const text = (page: Page) => page.GetText().replace(/\u00a0/g, ' ').trimEnd();
const small = { format: PageFormat.custom(100, 44), marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10 };

describe('Document.AddPlainText (nh1t.5)', () => {
  it('uses Courier at a fixed advance, on an A4 page with 72pt margins', () => {
    const doc = Document.New();
    const [page] = doc.AddPlainText('ii\nWW');
    expect(page.MediaBox).toEqual([0, 0, 595, 842]);
    const fragments = page.GetTextFragments();
    expect(fragments.map((f) => [f.text, f.fontName, f.fontSize])).toEqual([
      ['ii', 'Courier', 10], ['WW', 'Courier', 10],
    ]);
    expect(fragments[0].quad).toEqual([72, 760, 84, 770]);
    expect(fragments[1].quad[2] - fragments[1].quad[0]).toBeCloseTo(12, 6);
    expect(fragments[0].quad[1] - fragments[1].quad[1]).toBeCloseTo(12, 6);
  });

  it('keeps literal markup, indentation, repeated spaces and tab stops', () => {
    const [page] = Document.New().AddPlainText('# title\n  <b>&literal</b>\na\tb  c');
    expect(text(page)).toBe('# title\n  <b>&literal</b>\na   b  c');
  });

  it('normalizes CRLF and CR while retaining an interior blank line', () => {
    const [page] = Document.New().AddPlainText('one\r\n\r\ntwo\rthree');
    const f = page.GetTextFragments().filter((v) => v.text !== '');
    expect(f.map((v) => v.text)).toEqual(['one', 'two', 'three']);
    expect(f[0].quad[1] - f[1].quad[1]).toBeCloseTo(24, 6);
    expect(f[1].quad[1] - f[2].quad[1]).toBeCloseTo(12, 6);
  });

  it.each([
    ['', ['']], ['\f', ['', '']], ['\fA', ['', 'A']], ['A\f', ['A', '']],
    ['A\f\fB', ['A', '', 'B']], ['\f\f', ['', '', '']],
  ])('keeps empty form-feed sections in %j', (source, expected) => {
    const doc = Document.New();
    const pages = doc.AddPlainText(source);
    expect(pages.map(text)).toEqual(expected);
    expect(Document.Open(doc.Save()).Pages.map(text)).toEqual(expected);
  });

  it('paginates before an explicit form feed without merging the following section', () => {
    const doc = Document.New();
    const pages = doc.AddPlainText('a\nb\nc\fd', small);
    expect(pages.map(text)).toEqual(['a\nb', 'c', 'd']);
    expect(pages.every((p) => p.MediaBox[3] === 44)).toBe(true);
  });

  it('wraps an overwide word inside the available column', () => {
    const [page] = Document.New().AddPlainText('ABCDEFGHI', {
      ...small, format: PageFormat.custom(44, 80),
    });
    expect(text(page)).toBe('ABCD\nEFGH\nI');
    for (const f of page.GetTextFragments()) expect(f.quad[2]).toBeLessThanOrEqual(34.000001);
  });

  it('appends pages and returns only the new pages', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4).page.AddText('existing', 20, 100);
    const pages = doc.AddPlainText('first\fsecond');
    expect(doc.Pages.map(text)).toEqual(['existing', 'first', 'second']);
    expect(pages.map((p) => p.Number)).toEqual([2, 3]);
  });

  it('continues a wrapped token on the next page without losing characters', () => {
    const pages = Document.New().AddPlainText('ABCDEFGHIJKLM', {
      ...small, format: PageFormat.custom(44, 44),
    });
    expect(pages.map(text)).toEqual(['ABCD\nEFGH', 'IJKL\nM']);
  });

  it('honors font size, line advance and custom tab stops', () => {
    const [page] = Document.New().AddPlainText('a\tb\nc', {
      font: 'Courier-Bold', fontSize: 8, leading: 15, tabWidth: 8,
    });
    expect(text(page)).toBe('a       b\nc');
    const fragments = page.GetTextFragments();
    expect(fragments[0].fontName).toBe('Courier-Bold');
    expect(fragments[0].fontSize).toBe(8);
    expect(fragments[0].quad[1] - fragments[1].quad[1]).toBeCloseTo(15, 6);
  });

  it('uses the same wrapping measurements when an embedded font is shaped', () => {
    const doc = Document.New();
    const font = doc.AddFont(new Uint8Array(readFileSync('fonts/LiberationMono-Regular.ttf')));
    font.shape = true;
    doc.AddPlainText('ABCDEFGHI', { ...small, format: PageFormat.custom(50, 44), font });
    expect(Document.Open(doc.Save()).Pages.map(text)).toEqual(['ABCD\nEFGH', 'I']);
  });

  it('supports a registered embedded monospace font for Unicode', () => {
    const doc = Document.New();
    const font = doc.AddFont(new Uint8Array(readFileSync('fonts/LiberationMono-Regular.ttf')));
    doc.AddPlainText('Привет, мир', { font });
    expect(Document.Open(doc.Save()).Pages.map(text)).toEqual(['Привет, мир']);
  });

  it('also refuses partial glyph loss when an embedded font enables shaping', () => {
    const doc = Document.New();
    const font = doc.AddFont(new Uint8Array(readFileSync('fonts/LiberationMono-Regular.ttf')));
    font.shape = true;
    const before = doc.Save();
    expect(() => doc.AddPlainText('supported\fA\u{1f600}', { font })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('rejects unsupported characters in a later section before changing the document', () => {
    const doc = Document.New();
    const before = doc.Save();
    expect(() => doc.AddPlainText('valid first\fЖ')).toThrow(UnsupportedFeatureError);
    expect(() => doc.AddPlainText('Ж')).toThrow(/font/i);
    expect(doc.Save()).toEqual(before);
  });

  it.each([
    { fontSize: 0 }, { fontSize: NaN }, { leading: -1 }, { tabWidth: 0 },
    { tabWidth: 1.5 }, { font: 'no-such-font' }, { color: [2, 0, 0] },
    { marginLeft: 900 }, { title: '' },
  ])('rejects invalid options %j without mutation', (options) => {
    const doc = Document.New();
    const before = doc.Save();
    expect(() => doc.AddPlainText('valid', options as never)).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });

  it('rejects a page body too short for one line before allocating pages', () => {
    const doc = Document.New();
    const before = doc.Save();
    expect(() => doc.AddPlainText('a', { ...small, leading: 100 })).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });

  it('writes a requested title into Info, XMP and viewer preferences', () => {
    const doc = Document.New();
    doc.AddPlainText('body', { title: 'Text import' });
    const reopened = Document.Open(doc.Save());
    expect(reopened.GetMetadata().title).toBe('Text import');
    expect(reopened.GetXmp().title).toBe('Text import');
    expect(reopened.DisplayDocTitle).toBe(true);
  });

  it('observes a pre-aborted call before mutation', () => {
    const doc = Document.New();
    const before = doc.Save(), reason = new Error('stop');
    expect(() => doc.AddPlainText('a', { signal: AbortSignal.abort(reason) })).toThrow(reason);
    expect(doc.Save()).toEqual(before);
  });

  it('the async counterpart supports cancellation after completed pages', async () => {
    const doc = Document.New(), controller = new AbortController(), reason = new Error('stop after first');
    await expect(doc.AddPlainTextAsync('a\fb\fc', {
      signal: controller.signal,
      onProgress: (p) => { if (p.phase === 'sections' && p.completed === 1) controller.abort(reason); },
    })).rejects.toBe(reason);
    expect(doc.Pages.map(text)).toEqual(['a']);
  });
});
