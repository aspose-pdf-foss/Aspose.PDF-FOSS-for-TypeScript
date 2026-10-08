// test/flow-notes-identity.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';

/** The bytes note flows emit, hashed — recorded on the code BEFORE v9j3.3.2's
 *  engine changes. A FENCE: a flow using neither RestartNotes nor
 *  restart: 'page' must stay byte-identical. Never re-record to make it pass. */
const sha = (pages: { Contents: Uint8Array }[]): string =>
  createHash('sha256').update(Buffer.concat(pages.map((p) => Buffer.from(p.Contents)))).digest('hex').slice(0, 16);
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler sentence number ${i} of the body.`).join(' ');

describe('note flows are byte-identical (v9j3.3.2 fence)', () => {
  it('footnotes across pages', () => {
    const flow = Document.New().NewFlow();
    for (let i = 0; i < 6; i++)
      flow.AddParagraph([{ text: filler(25) }, { text: '', footnote: { content: `Note ${i}. ${filler(3)}` } }]);
    expect(sha(flow.Render())).toMatchInlineSnapshot(`"8e4d00555b556318"`);
  });
  it('endnotes, a repeat and a custom mark', () => {
    const n = { content: 'Shared.' };
    const flow = Document.New().NewFlow({ endnotes: { newPage: true } });
    flow.AddParagraph([{ text: 'a' }, { text: '', endnote: n }, { text: ' b' }, { text: '', endnote: n }]);
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: { content: 'Star.', mark: '*' } }]);
    expect(sha(flow.Render())).toMatchInlineSnapshot(`"2127fbed745c37b0"`);
  });
  it('tagged two-column flow with footnotes', () => {
    const flow = Document.New().NewFlow({ tagged: true, columns: 2 });
    for (let i = 0; i < 4; i++)
      flow.AddParagraph([{ text: filler(12) }, { text: '', footnote: { content: `Col note ${i}.` } }]);
    expect(sha(flow.Render())).toMatchInlineSnapshot(`"c2418cb3e2a84914"`);
  });
  // links: false twins (v9j3.3.4): turning note links off must reproduce the
  // bytes recorded BEFORE links existed — the literals below are those hashes;
  // the tagged case above was re-recorded when links (on by default) moved it.
  it('footnotes across pages, links off', () => {
    const flow = Document.New().NewFlow({ footnotes: { links: false } });
    for (let i = 0; i < 6; i++)
      flow.AddParagraph([{ text: filler(25) }, { text: '', footnote: { content: `Note ${i}. ${filler(3)}` } }]);
    expect(sha(flow.Render())).toBe('8e4d00555b556318');
  });
  it('endnotes, a repeat and a custom mark, links off', () => {
    const n = { content: 'Shared.' };
    const flow = Document.New().NewFlow({ footnotes: { links: false }, endnotes: { newPage: true, links: false } });
    flow.AddParagraph([{ text: 'a' }, { text: '', endnote: n }, { text: ' b' }, { text: '', endnote: n }]);
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: { content: 'Star.', mark: '*' } }]);
    expect(sha(flow.Render())).toBe('2127fbed745c37b0');
  });
  it('tagged two-column flow with footnotes, links off', () => {
    const flow = Document.New().NewFlow({ tagged: true, columns: 2, footnotes: { links: false } });
    for (let i = 0; i < 4; i++)
      flow.AddParagraph([{ text: filler(12) }, { text: '', footnote: { content: `Col note ${i}.` } }]);
    expect(sha(flow.Render())).toBe('c7d4624205a307fc');
  });
});
