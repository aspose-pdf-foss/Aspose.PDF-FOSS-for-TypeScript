import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { Page } from '../src/page.js';
import { PageFormat } from '../src/pageformat.js';
import type { OperationControlOptions } from '../src/checkpoint.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildXfaPdf, POSITIONED_TEMPLATE } from './helpers/build-xfa-pdf.js';
import { buildDocx } from './helpers/build-docx.js';
import { controlDocument } from './helpers/control-fixtures.js';

interface Entry {
  scope: 'Document' | 'Page' | 'Flow';
  name: string;
  args?: unknown[];
  options?: object;
  xfa?: boolean;
}
const word = buildDocx('<w:p><w:r><w:t>Matrix input</w:t></w:r></w:p>');
const image = controlDocument().ToTiff({ pages: [1] });
const geometry = { format: PageFormat.custom(240, 240), marginTop: 10, marginBottom: 10, marginLeft: 10, marginRight: 10 };
// An independently enumerated public contract, not discovered from the source.
const entries: Entry[] = [
  ...['ToHtml', 'ToMarkdown', 'ToMarkdownAssets', 'ToDocx', 'ToEpub', 'ToTiff', 'Optimize', 'ConvertToGrayscale', 'ConvertToPdfUa', 'Validate', 'Save'].map((name): Entry => ({ scope: 'Document', name })),
  { scope: 'Document', name: 'ConvertColors', options: { to: 'gray' } },
  { scope: 'Document', name: 'ConvertToPdfA', args: ['2b'] },
  { scope: 'Document', name: 'ConvertToPdfX', args: ['4'] },
  { scope: 'Document', name: 'ConvertXfaToAcroForm', xfa: true },
  { scope: 'Document', name: 'ValidatePdfA', args: ['2b'] },
  { scope: 'Document', name: 'ValidatePdfUa', args: [1] },
  { scope: 'Document', name: 'ValidatePdfX', args: ['4'] },
  { scope: 'Document', name: 'AddHtml', args: ['<p>Matrix input</p>'], options: geometry },
  { scope: 'Document', name: 'AddMarkdown', args: ['Matrix input'], options: geometry },
  { scope: 'Document', name: 'AddDocx', args: [word], options: geometry },
  { scope: 'Document', name: 'AddImagePages', args: [image] },
  ...['ToImage', 'ToSvg', 'ToHtml', 'ToMarkdown', 'ToMarkdownAssets', 'ToDocx'].map((name): Entry => ({ scope: 'Page', name })),
  { scope: 'Page', name: 'AddHtml', args: ['<p>Matrix input</p>', [10, 10, 200, 200]] },
  { scope: 'Page', name: 'AddMarkdown', args: ['Matrix input', [10, 10, 200, 200]] },
  { scope: 'Page', name: 'AddDocx', args: [word, [10, 10, 200, 200]] },
  { scope: 'Flow', name: 'AddHtml', args: ['<p>Matrix input</p>'] },
  { scope: 'Flow', name: 'AddMarkdown', args: ['Matrix input'] },
  { scope: 'Flow', name: 'AddDocx', args: [word] },
  { scope: 'Flow', name: 'Render' },
];

function make(entry: Entry): { doc: Document; subject: object } {
  const doc = entry.xfa ? Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE }))
    : entry.name.startsWith('Add') || entry.scope === 'Flow' ? Document.New()
    : Document.Open(buildMultiPageTaggedPdf());
  if (entry.scope === 'Page') return { doc, subject: doc.Pages[0] ?? doc.AddPage(geometry.format).page };
  if (entry.scope === 'Flow') {
    const flow = doc.NewFlow(geometry);
    if (entry.name === 'Render') { flow.AddParagraph('First.'); flow.AddParagraph('Second.'); }
    return { doc, subject: flow };
  }
  return { doc, subject: doc };
}
function call(entry: Entry, subject: object, async: boolean, options: OperationControlOptions = {}): unknown {
  const method = entry.name + (async ? 'Async' : '');
  return (subject as Record<string, (...args: unknown[]) => unknown>)[method](...(entry.args ?? []), { ...entry.options, ...options });
}
function normalize(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Page ? { page: item.Number }
    : item instanceof Uint8Array ? Array.from(item) : item);
}

describe('all 35 cooperative API pairs', () => {
  for (const entry of entries) {
    it(`${entry.scope}.${entry.name} pre-aborts without edits and exposes a genuinely yielding async twin`, async () => {
      const a = make(entry), b = make(entry), reason = new Error('matrix pre-abort');
      const before = a.doc.Save(), modified = a.doc.isModifiedInternal();
      expect(() => call(entry, a.subject, false, { signal: AbortSignal.abort(reason) })).toThrow(reason);
      await expect(call(entry, a.subject, true, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      expect(a.doc.Save()).toEqual(before);
      expect(a.doc.isModifiedInternal()).toBe(modified);
      const expected = call(entry, a.subject, false);
      expect(expected).not.toBeInstanceOf(Promise);
      let serviced = false;
      const handle = setImmediate(() => { serviced = true; });
      try {
        const pending = call(entry, b.subject, true);
        expect(pending).toBeInstanceOf(Promise);
        expect(normalize(await pending)).toBe(normalize(expected));
        expect(serviced).toBe(true);
      } finally { clearImmediate(handle); }
    });
  }

  it('keeps empty exports and structural validation usable', async () => {
    const doc = Document.New();
    expect(await doc.ToMarkdownAsync()).toBe('');
    expect(await doc.ToMarkdownAssetsAsync()).toEqual({ markdown: '', images: [] });
    expect(await doc.ToHtmlAsync()).toBe(doc.ToHtml());
    expect(await doc.ToDocxAsync()).toEqual(doc.ToDocx());
    expect(await doc.ToEpubAsync()).toEqual(doc.ToEpub());
    expect((await doc.ValidateAsync()).Passed).toBe(true);
  });

  it('captures controls across nested lowering and layout yields', async () => {
    const doc = Document.New(), phases: string[] = [];
    const options: OperationControlOptions & typeof geometry = {
      ...geometry, signal: new AbortController().signal,
      onProgress: (event) => {
        phases.push(event.phase ?? '');
        // Mutating the caller's options cannot replace this run's controls.
        (options as { signal?: AbortSignal }).signal = AbortSignal.abort(new Error('replacement'));
        (options as { onProgress?: OperationControlOptions['onProgress'] }).onProgress = () => { throw new Error('replacement callback'); };
      },
    };
    await doc.AddHtmlAsync('<p>First.</p><p>Second.</p>', options);
    expect(phases).toContain('parse'); expect(phases).toContain('lower');
    expect(phases).toContain('layout'); expect(phases).toContain('metadata');
    expect(doc.Pages[0].GetText()).toContain('Second.');
  });
});
