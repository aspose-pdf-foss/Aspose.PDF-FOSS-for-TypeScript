import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { OperationControlOptions, OperationProgress } from '../src/checkpoint.js';
import { buildDocx } from './helpers/build-docx.js';
import { controlDocument } from './helpers/control-fixtures.js';
import { parseHtml } from '../src/htmltree.js';
import { parseMarkdown } from '../src/markdown.js';

const geometry = { format: PageFormat.custom(220, 160), marginTop: 10, marginBottom: 10, marginLeft: 10, marginRight: 10 };
const inputs = [
  { name: 'AddHtml', source: '<p>First paragraph.</p><p>Second paragraph.</p>' },
  { name: 'AddMarkdown', source: 'First paragraph.\n\nSecond paragraph.' },
  { name: 'AddDocx', source: buildDocx('<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph.</w:t></w:r></w:p>') },
];
function target(scope: string): { doc: Document; subject: object } {
  const doc = Document.New();
  return { doc, subject: scope === 'Document' ? doc : scope === 'Page' ? doc.AddPage(geometry.format).page : doc.NewFlow(geometry) };
}
function call(subject: object, scope: string, method: string, source: unknown, options: OperationControlOptions = {}): unknown {
  const fn = (subject as Record<string, (...args: unknown[]) => unknown>)[method];
  return scope === 'Page' ? fn.call(subject, source, [10, 10, 200, 130], options)
    : fn.call(subject, source, { ...geometry, ...options });
}
function renderQueued(subject: object, scope: string): void {
  if (scope === 'Flow') (subject as { Render(): unknown }).Render();
}

describe('cooperative source imports', () => {
  for (const scope of ['Document', 'Page', 'Flow']) for (const input of inputs) {
    it(`${scope}.${input.name} pre-aborts without edits and preserves async results`, async () => {
      const a = target(scope), b = target(scope), reason = new Error('before parse'), before = a.doc.Save();
      const aborted = { signal: AbortSignal.abort(reason) };
      expect(() => call(a.subject, scope, input.name, input.source, aborted)).toThrow(reason);
      await expect(call(a.subject, scope, input.name + 'Async', input.source, aborted)).rejects.toBe(reason);
      expect(a.doc.Save()).toEqual(before);
      const expected = call(a.subject, scope, input.name, input.source) as { skipped: unknown[] };
      const events: OperationProgress[] = [];
      const actual = await call(b.subject, scope, input.name + 'Async', input.source, { onProgress: (e) => events.push(e) }) as { skipped: unknown[] };
      renderQueued(a.subject, scope); renderQueued(b.subject, scope);
      expect(actual.skipped).toEqual(expected.skipped);
      expect(b.doc.Pages.map((p) => p.GetText())).toEqual(a.doc.Pages.map((p) => p.GetText()));
      expect(b.doc.Pages.map((p) => p.GetText()).join(' ')).toContain('First paragraph.');
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.operation === input.name)).toBe(true);
    });
  }

  it.each(inputs)('cancels $name during lowering before pagination/title changes', async (input) => {
    const doc = Document.New(), controller = new AbortController(), reason = new Error('lowering');
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(call(doc, 'Document', input.name + 'Async', input.source, { signal: controller.signal, onProgress: (e) => {
        if (e.phase === 'lower') handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
      expect(doc.Pages).toHaveLength(0);
      expect(doc.GetMetadata().title).toBeUndefined();
    } finally { if (handle) clearImmediate(handle); }
  });

  it('accepts parsed HTML and Markdown sources', async () => {
    const doc = Document.New();
    await doc.AddHtmlAsync(parseHtml('<p>Parsed HTML</p>'), geometry);
    await doc.AddMarkdownAsync(parseMarkdown('Parsed Markdown'), geometry);
    expect(doc.Pages.map((p) => p.GetText()).join(' ')).toContain('Parsed HTML');
    expect(doc.Pages.map((p) => p.GetText()).join(' ')).toContain('Parsed Markdown');
  });

  it('pre-aborted Flow remains reusable; started cancelled layout is consumed', async () => {
    const doc = Document.New(), reason = new Error('layout'), flow = doc.NewFlow({ ...geometry, tagged: true });
    flow.AddMarkdown('Citation[^n].\n\n[^n]: Note body.\n\n' + 'Another paragraph.\n\n'.repeat(20));
    await expect(flow.RenderAsync({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(doc.Pages).toHaveLength(0);
    const controller = new AbortController(), events: OperationProgress[] = [];
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(flow.RenderAsync({ signal: controller.signal, onProgress: (e) => {
        events.push(e); if (e.phase === 'layout') handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
      expect(doc.Pages.length).toBeGreaterThan(0);
      expect(events.at(-1)?.total).toBeUndefined();
      expect(Document.Open(doc.Save()).Validate().Passed).toBe(true);
      expect(() => flow.Render()).toThrow(/already rendered/);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('does not call onRendered on cancellation and keeps page numbering when appending', async () => {
    const doc = controlDocument(), controller = new AbortController(), reason = new Error('appended');
    let completed = false;
    const flow = doc.NewFlow({ ...geometry, onRendered: () => { completed = true; } });
    flow.AddParagraph('One.'); flow.AddParagraph('Two.');
    const events: OperationProgress[] = [];
    await expect(flow.RenderAsync({ signal: controller.signal, onProgress: (e) => { events.push(e); controller.abort(reason); } })).rejects.toBe(reason);
    expect(completed).toBe(false);
    expect(events[0].pageNumber).toBe(4);
  });

  it('preserves one-rect remainder behavior', async () => {
    const doc = Document.New(), page = doc.AddPage(geometry.format).page;
    const result = await page.AddMarkdownAsync('A paragraph.\n\n'.repeat(30), [10, 10, 120, 30]);
    expect(result.usedHeight).toBeGreaterThan(0);
    expect(result.remainder.length).toBeGreaterThan(0);
  });

  const longText = 'Long paragraph words. '.repeat(60);
  const partialInputs = [
    { name: 'AddHtml', source: `<p>${longText}</p>` },
    { name: 'AddMarkdown', source: longText },
    { name: 'AddDocx', source: buildDocx(`<w:p><w:r><w:t>${longText}</w:t></w:r></w:p>`) },
  ];
  for (const input of partialInputs) it.each([false, true])(`${input.name} checkpoints a partial final placement (async: %s)`, async (yielding) => {
    const doc = Document.New(), page = doc.AddPage(geometry.format).page;
    const controller = new AbortController(), reason = new Error('partial layout');
    const events: OperationProgress[] = [];
    let handle: NodeJS.Immediate | undefined;
    const options: OperationControlOptions = { signal: controller.signal, onProgress: (event) => {
      if (event.phase !== 'layout') return;
      events.push(event);
      if (yielding) handle = setImmediate(() => controller.abort(reason));
      else controller.abort(reason);
    } };
    const invoke = () => (page as unknown as Record<string, (...args: unknown[]) => unknown>)[input.name + (yielding ? 'Async' : '')](input.source, [0, 0, 200, 20], options);
    try {
      if (yielding) await expect(invoke()).rejects.toBe(reason);
      else expect(invoke).toThrow(reason);
      expect(events).toEqual([{ operation: input.name, phase: 'layout', completed: 1, pageNumber: 1 }]);
      expect(page.GetText()).toContain('Long paragraph');
      expect(Document.Open(doc.Save()).Validate().Passed).toBe(true);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('retains the first appended image frame after cancellation', async () => {
    const source = controlDocument().ToTiff(), doc = Document.New(), controller = new AbortController(), reason = new Error('frame');
    await expect(doc.AddImagePagesAsync(source, { signal: controller.signal, onProgress: (e) => {
      if (e.phase === 'frames') controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(doc.Pages).toHaveLength(1);
    expect(Document.Open(doc.Save()).Pages).toHaveLength(1);
  });
});
