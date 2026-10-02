import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { AiServiceError } from '../src/errors.js';
import { stripJsonFence, parseJsonReply } from '../src/aijson.js';
import { cutAt, windowPages } from '../src/aichunk.js';
import { aiOcrEngine } from '../src/aiocr.js';
import { isDict } from '../src/types.js';
import type { StructElement } from '../src/struct.js';
import { scriptedModel, systemOf, userTextOf } from './helpers/scripted-model.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

const RED = buildPngRgb();
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const alt = (s: string): string => JSON.stringify({ alt: s, decorative: false });
const fence = (s: string, tag = 'json'): string => '```' + tag + '\n' + s + '\n```';

function figures(doc: Document): StructElement[] {
  const out: StructElement[] = [];
  const walk = (els: StructElement[]): void => {
    for (const e of els) { if (e.StandardType === 'Figure') out.push(e); else walk(e.Children); }
  };
  walk(doc.GetStructTree()!.Children);
  return out;
}

describe('aijson (u0ec)', () => {
  it('strips one whole-reply fence, tagged or bare, with LF or CRLF', () => {
    expect(stripJsonFence(fence('{"a":1}'))).toBe('{"a":1}');
    expect(stripJsonFence(fence('{"a":1}', ''))).toBe('{"a":1}');
    expect(stripJsonFence('  ```json\r\n{"a":1}\r\n```  ')).toBe('{"a":1}');
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });

  it('leaves a fence with prose around it, so the reply is still refused', () => {
    const t = 'Here you go:\n' + fence('{"a":1}');
    expect(stripJsonFence(t)).toBe(t);
    expect(() => parseJsonReply(t, () => new AiServiceError('bad'))).toThrow(AiServiceError);
  });
});

describe('fenced replies are accepted (u0ec)', () => {
  it('by Ask, GenerateAltText and aiOcrEngine', async () => {
    const doc = Document.New(PageFormat.custom(600, 200));
    doc.Pages[0]!.AddText('The warranty lasts two years.', 20, 100);
    const r = await doc.Ask(scriptedModel(() => fence(JSON.stringify({ answer: 'Two.', found: true, pages: [1] }))), 'warranty');
    expect(r).toMatchObject({ answer: 'Two.', found: true, pages: [1] });

    const img = Document.New(PageFormat.custom(400, 400));
    img.Pages[0]!.AddImage(RED, [20, 20, 100, 100], { tag: img.CreateStructTree().Append('Figure') });
    const a = await img.GenerateAltText(scriptedModel(() => fence(alt('Red.'))));
    expect(a.figures[0]!.status).toBe('described');

    const ocr = aiOcrEngine({ complete: async () => ({ text: fence('{"lines":[]}') }) });
    await expect(ocr.recognize({ bytes: new Uint8Array(1), mediaType: 'image/png', width: 10, height: 10 }, {})).resolves.toEqual([]);
  });
});

describe('surrogate pairs (u0ec)', () => {
  it('cutAt steps back off the middle of a pair and nowhere else', () => {
    const t = 'a😀b';
    expect(cutAt(t, 2)).toBe(1);
    expect(cutAt(t, 1)).toBe(1);
    expect(cutAt(t, 3)).toBe(3);
  });

  it('no window starts or ends inside a pair, and every character is covered', () => {
    const text = 'a' + '😀'.repeat(20);
    const w = windowPages([{ page: 1, text }], 10, 3);
    for (const x of w) expect(x.text).not.toMatch(LONE);
    expect(w.map((x) => x.text).join('').replace(/😀/g, '').replace('a', '')).toBe('');
    expect(w.at(-1)!.text.endsWith('😀')).toBe(true);
  });

  it('alt-text context is trimmed without splitting a pair', async () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    doc.Pages[0]!.AddImage(RED, [20, 20, 100, 100], { tag: doc.CreateStructTree().Append('Figure') });
    // 1999 ASCII then pairs: a 2000-character cut lands between the halves.
    const page = doc.Pages[0]!;
    const orig = page.GetText.bind(page);
    page.GetText = (() => 'x'.repeat(1999) + '😀'.repeat(10)) as typeof page.GetText;
    const m = scriptedModel(() => alt('Red.'));
    await doc.GenerateAltText(m);
    page.GetText = orig;
    expect(userTextOf(m.requests[0]!)).not.toMatch(LONE);
  });
});

describe('Ask (u0ec)', () => {
  const doc = (): Document => {
    const d = Document.New(PageFormat.custom(600, 200));
    d.Pages[0]!.AddText('The warranty lasts two years.', 20, 100);
    return d;
  };

  it('cites no pages when the answer was not found', async () => {
    const m = scriptedModel(() => JSON.stringify({ answer: 'Not stated.', found: false, pages: [1] }));
    expect(await doc().Ask(m, 'warranty')).toMatchObject({ found: false, pages: [] });
  });

  it('refuses a question that leaves no room for an excerpt, before any request', async () => {
    const m = scriptedModel(() => JSON.stringify({ answer: 'a', found: true, pages: [] }));
    await expect(doc().Ask(m, 'warranty '.repeat(250), { maxInputChars: 4000 })).rejects.toThrow(RangeError);
    expect(m.requests).toHaveLength(0);
  });

  it('keeps the request within maxInputChars beside a long question', async () => {
    // One short excerpt per page, so several fit beside the question.
    const d = Document.New(PageFormat.custom(600, 200));
    for (let i = 0; i < 20; i++) {
      const page = i === 0 ? d.Pages[0]! : d.AddPage(PageFormat.custom(600, 200)).page;
      page.AddText(`warranty ${'filler '.repeat(8)}${i}`, 20, 100);
    }
    const q = 'warranty '.repeat(200);
    const m = scriptedModel(() => JSON.stringify({ answer: 'a', found: true, pages: [] }));
    const r = await d.Ask(m, q, { maxInputChars: 4000 });
    const sent = r.excerpts.reduce((s, e) => s + e.text.length, 0);
    expect(sent + q.length).toBeLessThanOrEqual(4000 - 2000);
  });
});

describe('Summarize (u0ec)', () => {
  it('stops reducing once a level fails to shrink the text', async () => {
    const doc = Document.New(PageFormat.custom(600, 800));
    for (let p = 1; p <= 6; p++) {
      const page = p === 1 ? doc.Pages[0]! : doc.AddPage(PageFormat.custom(600, 800)).page;
      for (let i = 0; i < 50; i++) page.AddText(`p${p} line ${i} ${'word '.repeat(9)}`, 20, 780 - i * 12);
    }
    const isMap = (s: string): boolean => s.includes('part of a longer document');
    // Maps answer at length; reduces echo their input, so no level shrinks.
    const m = scriptedModel((req, n) => (isMap(systemOf(req)) ? `m${n} ${'x'.repeat(2500)}` : userTextOf(req)));
    await doc.Summarize(m, { maxInputChars: 8000 });
    const maps = m.requests.filter((r) => isMap(systemOf(r))).length;
    const reduces = m.requests.length - maps;
    expect(reduces).toBe(Math.ceil(maps / 2) + 1);
  });
});

describe('GenerateAltText (u0ec)', () => {
  it('does not memoize a failure: the next figure with that picture asks again', async () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    const root = doc.CreateStructTree();
    doc.Pages[0]!.AddImage(RED, [20, 20, 100, 100], { tag: root.Append('Figure') });
    doc.Pages[0]!.AddImage(RED, [200, 20, 100, 100], { tag: root.Append('Figure') });
    const m = scriptedModel((_, n) => (n === 1 ? 'garbage' : alt('Red.')));
    const r = await doc.GenerateAltText(m);
    expect(r.figures.map((f) => f.status)).toEqual(['failed', 'described']);
    expect(m.requests).toHaveLength(2);
  });

  it('leaves an untagged document with no pictures untagged', async () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    doc.Pages[0]!.AddText('Only text', 20, 300);
    const m = scriptedModel(() => alt('x'));
    expect(await doc.GenerateAltText(m)).toEqual({ figures: [], requests: 0, usage: undefined });
    expect(doc.GetStructTree()).toBeNull();
  });

  it('describes ONE XObject drawn on two pages once, with one record, and tags both', async () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    doc.Pages[0]!.AddImage(RED, [20, 20, 100, 100]);
    const second = doc.AddPage(PageFormat.custom(400, 400)).page;
    // Page 2 shares page 1's resources and content: the same stream object.
    second.Dict.set('Resources', doc.Pages[0]!.Dict.get('Resources')!);
    second.Dict.set('Contents', doc.Pages[0]!.Dict.get('Contents')!);
    const xo = (n: number): unknown => {
      const res = doc.resolve(doc.Pages[n]!.Dict.get('Resources'));
      return isDict(res) ? doc.resolve(res.get('XObject')) : undefined;
    };
    expect(xo(0)).toBeDefined();
    expect(xo(1)).toBe(xo(0));
    const m = scriptedModel(() => alt('A red square.'));
    const r = await doc.GenerateAltText(m);
    expect(m.requests).toHaveLength(1);
    expect(r.figures).toEqual([{ page: 1, status: 'described', alt: 'A red square.' }]);
    expect(figures(doc).map((f) => f.Alt)).toEqual(['A red square.', 'A red square.']);
  });
});
