import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { AiServiceError } from '../src/errors.js';
import { scriptedModel, systemOf, userTextOf } from './helpers/scripted-model.js';
import type { AiRequest } from '../src/aimodel.js';

/** `n` pages, each roughly `chars` characters of distinct words in 60-character lines. */
function docWithPages(n: number, chars: number): Document {
  const doc = Document.New(PageFormat.custom(600, 800));
  for (let p = 1; p <= n; p++) {
    const page = p === 1 ? doc.Pages[0]! : doc.AddPage(PageFormat.custom(600, 800)).page;
    const words: string[] = [];
    for (let i = 0; words.join(' ').length < chars; i++) words.push(`p${p}w${i}`);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      if (line.length + w.length + 1 > 60) { lines.push(line); line = ''; }
      line = line ? `${line} ${w}` : w;
    }
    if (line) lines.push(line);
    lines.forEach((l, i) => page.AddText(l, 20, 780 - i * 10));
  }
  return doc;
}

const isMap = (r: AiRequest): boolean => systemOf(r).includes('part of a longer document');
const isReduce = (r: AiRequest): boolean => systemOf(r).includes('partial summaries');

describe('Summarize (3ywf.4)', () => {
  it('makes one request when the document fits', async () => {
    const m = scriptedModel(() => 'The summary.');
    const r = await docWithPages(2, 500).Summarize(m);
    expect(r).toEqual({ text: 'The summary.', requests: 1, usage: undefined });
    const user = userTextOf(m.requests[0]!);
    expect(user).toContain('[page 1]');
    expect(user).toContain('[page 2]');
  });

  it('maps every chunk, then reduces the partial summaries', async () => {
    const m = scriptedModel((req, n) => (isMap(req) ? `partial-${n}` : 'FINAL'));
    const r = await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000 });
    const maps = m.requests.filter(isMap);
    expect(maps.length).toBeGreaterThan(1);
    expect(r.text).toBe('FINAL');
    expect(r.requests).toBe(m.requests.length);
    const last = m.requests.at(-1)!;
    expect(isReduce(last)).toBe(true);
    for (let i = 1; i <= maps.length; i++) expect(userTextOf(last)).toContain(`partial-${i}`);
  });

  it('reduces again when the partial summaries do not fit one request', async () => {
    const m = scriptedModel((req, n) => (isMap(req) ? `p${n} ${'x'.repeat(2500)}` : `r${n}`));
    await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000 });
    expect(m.requests.filter(isReduce).length).toBeGreaterThan(1);
  });

  it('sends the instructions in the final request only', async () => {
    const m = scriptedModel((req, n) => (isMap(req) ? `partial-${n}` : 'FINAL'));
    await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000, instructions: 'in German' });
    const withInstr = m.requests.filter((r) => systemOf(r).includes('in German'));
    expect(withInstr).toEqual([m.requests.at(-1)]);
    const one = scriptedModel(() => 'S');
    await docWithPages(1, 200).Summarize(one, { instructions: 'in German' });
    expect(systemOf(one.requests[0]!)).toContain('in German');
  });

  it('sums usage across requests', async () => {
    const m = scriptedModel((req, n) => ({ text: isMap(req) ? `partial-${n}` : 'F', usage: { inputTokens: 10, outputTokens: 1 } }));
    const r = await docWithPages(6, 3000).Summarize(m, { maxInputChars: 8000 });
    expect(r.usage).toEqual({ inputTokens: 10 * r.requests, outputTokens: r.requests });
  });

  it('refuses a selection with no text before any request (Review Focus 1)', async () => {
    const m = scriptedModel(() => 'S');
    const doc = docWithPages(1, 200);
    doc.AddPage(PageFormat.custom(600, 800));
    await expect(doc.Summarize(m, { pages: [2] })).rejects.toThrow(/no extractable text/);
    await expect(Document.New(PageFormat.A4).Summarize(m)).rejects.toThrow(RangeError);
    expect(m.requests).toHaveLength(0);
  });

  it('throws AiServiceError on an empty reply', async () => {
    await expect(docWithPages(1, 200).Summarize(scriptedModel(() => '  '))).rejects.toBeInstanceOf(AiServiceError);
  });

  it('validates its options before any request', async () => {
    const m = scriptedModel(() => 'S');
    const doc = docWithPages(1, 200);
    await expect(doc.Summarize({} as never)).rejects.toThrow(TypeError);
    await expect(doc.Summarize(m, { maxInputChars: 100 })).rejects.toThrow(RangeError);
    await expect(doc.Summarize(m, { instructions: 5 as never })).rejects.toThrow(TypeError);
    expect(m.requests).toHaveLength(0);
  });

  it('honours an aborted signal', async () => {
    const m = scriptedModel(() => 'S');
    const ctrl = new AbortController();
    ctrl.abort(new Error('stop'));
    await expect(docWithPages(1, 200).Summarize(m, { signal: ctrl.signal })).rejects.toThrow('stop');
    expect(m.requests).toHaveLength(0);
  });
});
