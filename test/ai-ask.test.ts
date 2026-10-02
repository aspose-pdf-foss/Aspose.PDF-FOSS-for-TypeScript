import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { AiServiceError } from '../src/errors.js';
import { scriptedModel, userTextOf } from './helpers/scripted-model.js';
import { fakeOcr } from './helpers/fake-ocr.js';

/** One page per string, each drawn as one line. */
function docOf(...pages: string[]): Document {
  const doc = Document.New(PageFormat.custom(600, 200));
  pages.forEach((t, i) => {
    const page = i === 0 ? doc.Pages[0]! : doc.AddPage(PageFormat.custom(600, 200)).page;
    page.AddText(t, 20, 100);
  });
  return doc;
}
const reply = (o: object): string => JSON.stringify(o);
const DOC = (): Document => docOf(
  'The warranty lasts two years.',
  'Shipping takes five days.',
  'Returns: returns are accepted within thirty days.',
);

describe('Ask (3ywf.4)', () => {
  it('sends the best-ranked excerpt, labelled by page, with the answer schema', async () => {
    const m = scriptedModel(() => reply({ answer: 'Two years.', found: true, pages: [1] }));
    const r = await DOC().Ask(m, 'How long is the warranty?', { maxChunks: 1 });
    const user = userTextOf(m.requests[0]!);
    expect(user).toContain('[page 1]');
    expect(user).not.toContain('[page 2]');
    expect(user).toContain('How long is the warranty?');
    expect(m.requests[0]!.schema?.name).toBe('document_answer');
    expect(r).toMatchObject({ answer: 'Two years.', found: true, pages: [1] });
    expect(r.excerpts).toEqual([{ page: 1, text: 'The warranty lasts two years.' }]);
  });

  it('drops a cited page that was not among the excerpts sent', async () => {
    const m = scriptedModel(() => reply({ answer: 'Two years.', found: true, pages: [7, 1, 1] }));
    expect((await DOC().Ask(m, 'warranty', { maxChunks: 1 })).pages).toEqual([1]);
  });

  it('passes found: false through', async () => {
    const m = scriptedModel(() => reply({ answer: 'Not stated.', found: false, pages: [] }));
    expect(await DOC().Ask(m, 'warranty')).toMatchObject({ found: false, pages: [] });
  });

  it('returns excerpts by rank but sends them in document order', async () => {
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await DOC().Ask(m, 'warranty returns');
    expect(r.excerpts.map((e) => e.page)).toEqual([3, 1]);
    const user = userTextOf(m.requests[0]!);
    expect(user.indexOf('[page 1]')).toBeLessThan(user.indexOf('[page 3]'));
  });

  it('falls back to document order when nothing shares a term with the question', async () => {
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await DOC().Ask(m, 'What is this about?');
    expect(r.excerpts.map((e) => e.page)).toEqual([1, 2, 3]);
  });

  it('honours maxChunks and the character budget', async () => {
    const pages = Array.from({ length: 12 }, (_, i) => `topic ${'filler '.repeat(200)} item${i}`);
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await docOf(...pages).Ask(m, 'topic', { maxChunks: 3 });
    expect(r.excerpts.length).toBe(3);
    const m2 = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r2 = await docOf(...pages).Ask(m2, 'topic', { maxInputChars: 4000 });
    expect(r2.excerpts.reduce((s, e) => s + e.text.length, 0)).toBeLessThanOrEqual(2000);
    expect(r2.excerpts.length).toBeGreaterThan(0);
  });

  it('finds the right page in Japanese (Review Focus 4)', async () => {
    // AddText's Standard-14 faces cannot draw Japanese, so the pages get their
    // text the way a scan would: MakeSearchable's glyphless layer, any script.
    const lines = ['東京は日本の首都です。', '大阪は商業の町です。'];
    const doc = Document.New(PageFormat.custom(600, 200));
    doc.AddPage(PageFormat.custom(600, 200));
    await doc.MakeSearchable(fakeOcr((n) => [{ text: lines[n - 1]!, box: [10, 10, 500, 40] }]), { dpi: 72 });
    const m = scriptedModel(() => reply({ answer: 'x', found: true, pages: [] }));
    const r = await doc.Ask(m, '大阪', { maxChunks: 1 });
    expect(r.excerpts[0]!.page).toBe(2);
  });

  for (const [what, text] of [
    ['not JSON', 'sorry'],
    ['a non-string answer', reply({ answer: 1, found: true, pages: [] })],
    ['no found flag', reply({ answer: 'a', pages: [] })],
    ['pages as strings (Review Focus 2)', reply({ answer: 'a', found: true, pages: ['1'] })],
  ] as const) {
    it(`throws AiServiceError on ${what}`, async () => {
      await expect(DOC().Ask(scriptedModel(() => text), 'warranty')).rejects.toBeInstanceOf(AiServiceError);
    });
  }

  it('validates its arguments before any request', async () => {
    const m = scriptedModel(() => reply({ answer: 'a', found: true, pages: [] }));
    await expect(DOC().Ask(m, '   ')).rejects.toThrow(RangeError);
    await expect(DOC().Ask(m, 5 as never)).rejects.toThrow(TypeError);
    await expect(DOC().Ask(m, 'q', { maxChunks: 0 })).rejects.toThrow(RangeError);
    await expect(Document.New(PageFormat.A4).Ask(m, 'q')).rejects.toThrow(/no extractable text/);
    expect(m.requests).toHaveLength(0);
  });
});
