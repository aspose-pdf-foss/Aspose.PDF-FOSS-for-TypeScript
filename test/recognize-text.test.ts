import { expect, it } from 'vitest';
import { Document, PageFormat, ResourceLimitError } from '../src/index.js';
import { fakeOcr } from './helpers/fake-ocr.js';
import { buildSigner } from './helpers/build-signer.js';

const format = PageFormat.custom(300, 300);

it('preserves the signed bytes and signature integrity after successful recognition', async () => {
  const draft = Document.New(format);
  await draft.Sign(buildSigner({ type: 'ec' }), { fieldName: 'Approval' });
  const bytes = draft.Save().slice();
  const doc = Document.Open(bytes);
  const incrementalBefore = doc.Save({ incremental: true });
  const engine = fakeOcr(() => [{ text: 'signed page', box: [0, 0, 10, 10] }]);
  expect((await doc.RecognizeText(engine, { force: true })).pages[0]?.text).toBe('signed page');
  expect(Buffer.compare(doc.Save({ incremental: true }), incrementalBefore)).toBe(0);
  expect(await doc.VerifySignatures()).toMatchObject([{ integrity: 'valid', signature: 'valid', coversWholeFile: true }]);
  await draft.RecognizeText(engine, { force: true });
  expect(Buffer.compare(draft.Save(), bytes)).toBe(0);
});

it('reports clipped spans on a rotated crop at 144 DPI and preserves dirty edits', async () => {
  const doc = Document.Open(Document.New(format).Save());
  const page = doc.Pages[0]!;
  page.CropBox = [50, 60, 250, 160];
  page.Rotate = 90;
  const before = doc.Save();
  const engine = fakeOcr(() => [
    { text: 'e\u0301', box: [-8, 20, 80, 40] },
    { text: 'outside', box: [250, 0, 260, 10] },
    { text: 'next', box: [0, 0, 20, 20] },
  ]);
  const result = await doc.RecognizeText(engine, { dpi: 144 });
  expect(engine.calls[0]).toMatchObject({ width: 200, height: 400 });
  expect(result.pages).toEqual([{
    page: 1, status: 'ocr', text: 'é\nnext', dropped: 1, spans: [
      { text: 'é', box: [0, 20, 80, 40], quad: [60, 60, 60, 100, 70, 100, 70, 60] },
      { text: 'next', box: [0, 0, 20, 20], quad: [50, 60, 50, 70, 60, 70, 60, 60] },
    ],
  }]);
  expect(doc.isModifiedInternal()).toBe(true);
  expect(doc.Save()).toEqual(before);
});

it('reports selected pages in order, skips existing text and can force recognition', async () => {
  const doc = Document.New(format);
  doc.Pages[0]!.AddText('Original', 10, 10);
  doc.AddPage(format);
  doc.AddPage(format);
  const engine = fakeOcr(() => []);
  const seen: number[] = [];
  const { pages } = await doc.RecognizeText(engine, { pages: [3, 1, 3], onPage: r => seen.push(r.page) });
  expect(pages).toEqual([
    { page: 1, status: 'skipped', reason: 'has-text', text: '', spans: [], dropped: 0 },
    { page: 3, status: 'ocr', text: '', spans: [], dropped: 0 },
  ]);
  expect(seen).toEqual([1, 3]);
  expect(engine.calls).toHaveLength(1);
  expect((await doc.RecognizeText(engine, { pages: '1', force: true })).pages[0]?.status).toBe('ocr');
  expect(doc.Pages[0]!.GetText()).toContain('Original');
});

it('continues after engine failure and malformed output while preserving a signature field', async () => {
  const draft = Document.New(format);
  draft.Form.AddSignatureField({ page: 1, rect: [10, 10, 60, 30], name: 'S' });
  draft.AddPage(format);
  draft.AddPage(format);
  const doc = Document.Open(draft.Save());
  const before = doc.Save();
  const engine = fakeOcr(n => {
    if (n === 1) throw new Error('offline');
    if (n === 2) return null as never;
    return [{ text: 'read', box: [0, 0, 10, 10] }];
  });
  const { pages } = await doc.RecognizeText(engine, { dpi: 72, force: true });
  expect(pages[0]).toEqual({ page: 1, status: 'failed', reason: 'offline', text: '', spans: [], dropped: 0 });
  expect(pages[1]).toMatchObject({ page: 2, status: 'failed', spans: [] });
  expect(pages[2]).toMatchObject({ page: 3, text: 'read' });
  expect(doc.isModifiedInternal()).toBe(false);
  expect(doc.Save()).toEqual(before);
});

it('propagates cancellation during the final engine call and resource-limit errors', async () => {
  const doc = Document.Open(Document.New(format).Save());
  const before = doc.Save();
  const controller = new AbortController();
  const reason = new Error('stop scanning');
  await expect(doc.RecognizeText({ async recognize(_image, { signal }) {
    expect(signal).toBe(controller.signal);
    controller.abort(reason);
    return [];
  } }, { signal: controller.signal })).rejects.toBe(reason);
  const limit = new ResourceLimitError('maxCanvasPixels', 1, 100);
  await expect(doc.RecognizeText(fakeOcr(() => { throw limit; }))).rejects.toBe(limit);
  expect(doc.isModifiedInternal()).toBe(false);
  expect(doc.Save()).toEqual(before);
});
