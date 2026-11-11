import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { OperationControlOptions, OperationProgress } from '../src/checkpoint.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';
import { openZip } from '../src/zipread.js';

function call(target: object, name: string, opts?: object): unknown {
  return (target as Record<string, (options?: object) => unknown>)[name](opts);
}

const exports = ['ToHtml', 'ToMarkdown', 'ToMarkdownAssets', 'ToDocx', 'ToEpub'];
describe('cooperative document and page exports', () => {
  for (const scope of ['Document', 'Page']) for (const method of exports.filter((m) => scope === 'Document' || m !== 'ToEpub')) {
    it(`${scope}.${method} supports pre-abort and identical async output`, async () => {
      const doc = Document.Open(buildMultiPageTaggedPdf()), target = scope === 'Document' ? doc : doc.Pages[1];
      const reason = new Error('stop'), options = { signal: AbortSignal.abort(reason) };
      expect(() => call(target, method, options)).toThrow(reason);
      await expect(call(target, method + 'Async', options)).rejects.toBe(reason);
      const expected = call(target, method), events: OperationProgress[] = [];
      const actual = await call(target, method + 'Async', { onProgress: (e: OperationProgress) => events.push(e) });
      expect(actual).toEqual(expected);
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map((e) => e.operation))).toEqual(new Set([method]));
    });
  }

  it('preserves one cross-page semantic container and both page texts', async () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const html = await doc.ToHtmlAsync();
    expect(html).toContain('Page one body'); expect(html).toContain('Page two body');
    expect(html).toBe(doc.ToHtml());
    const markdown = await doc.ToMarkdownAsync();
    expect(markdown).toContain('Page one body'); expect(markdown).toContain('Page two body');
  });

  it.each(['headings', 'model', 'blocks'])('cancels an untagged export during %s', async (phase) => {
    const doc = Document.Open(buildUntaggedHtmlPdf()), controller = new AbortController(), reason = new Error(phase);
    const events: OperationProgress[] = [];
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(doc.ToMarkdownAsync({ signal: controller.signal, onProgress: (e) => {
        events.push(e);
        if (e.phase === phase) handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
      expect(events.at(-1)?.phase).toBe(phase);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('yields inside a tagged root and propagates a primitive callback failure', async () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const options: OperationControlOptions = { onProgress: (e) => { if (e.phase === 'model') throw 'caller stopped'; } };
    await expect(doc.ToHtmlAsync(options)).rejects.toMatchObject({ cause: 'caller stopped' });
    expect(() => doc.ToMarkdown(options)).toThrow('caller stopped');
  });

  it.each(['fixed', 'textbox'])('keeps %s page-wide state across yielding exports', async (mode) => {
    const doc = Document.Open(buildFormPdf()), events: OperationProgress[] = [];
    if (mode === 'fixed') {
      const options = { mode: 'fixed' as const, forms: true, onProgress: (e: OperationProgress) => events.push(e) };
      expect(await doc.ToHtmlAsync(options)).toBe(doc.ToHtml({ mode: 'fixed', forms: true }));
    } else {
      expect(await doc.ToDocxAsync({ mode: 'textbox', onProgress: (e) => events.push(e) })).toEqual(doc.ToDocx({ mode: 'textbox' }));
    }
    expect(events.some((e) => e.phase === 'render' && e.pageNumber === 1)).toBe(true);
  });

  it('retains one image part shared by multiple exported pages', async () => {
    const doc = Document.Open(buildTextAndImagePage('q 30 0 0 30 10 10 cm /Im0 Do Q'));
    doc.AddPage(doc.Pages[0]);
    const archive = openZip(await doc.ToDocxAsync());
    expect(archive.entries.filter((e) => e.path.startsWith('word/media/'))).toHaveLength(1);
    expect(new TextDecoder().decode(archive.read('word/document.xml'))).toContain('r:embed');
  });

  it.each(['ToMarkdown', 'ToMarkdownAssets'])('%s yields after final assembly before returning output', async (method) => {
    const doc = Document.Open(buildMultiPageTaggedPdf()), controller = new AbortController(), reason = new Error('assembled');
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(call(doc, method + 'Async', { signal: controller.signal, onProgress: (e: OperationProgress) => {
        if (e.phase === 'assemble') handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
    } finally { if (handle) clearImmediate(handle); }
  });
});
