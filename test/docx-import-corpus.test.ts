import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/index.js';
import { readTruth, COUNT_KEYS, SKIP_MAP, type DocxTruth } from './helpers/docx-truth.js';

// m2fp.5: the real-world corpus (Word 2010 and LibreOffice 26.8, m2fp.4)
// rendered through AddDocx. The truths are what BOTH applications read out of
// each file, so an assertion here is against text and structure neither we nor
// our builders wrote.
const DIR = join(__dirname, 'fixtures', 'docx');
// OURS, read by Word (m2fp.3, m2fp.5, m2fp.10): every oracle document is named *-oracle.docx.
const NOT_CORPUS = { has: (f: string): boolean => /-oracle\.docx$/.test(f) };
const files = readdirSync(DIR).filter((f) => f.endsWith('.docx') && !NOT_CORPUS.has(f)).sort();
const truthsOf = (f: string): DocxTruth[] =>
  ['word', 'lo'].map((k) => join(DIR, `${f.replace(/\.docx$/, '')}.${k}.json`)).filter(existsSync).map(readTruth);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe.each(files)('AddDocx renders %s', (f) => {
  const truths = truthsOf(f);
  const doc = Document.New();
  const { pages, skipped } = doc.AddDocx(new Uint8Array(readFileSync(join(DIR, f))), { tagged: true });
  const text = norm(pages.map((p) => p.GetText()).join(' '));

  it('has both readers\' truths', () => {
    expect(truths).toHaveLength(2);
  });

  it('draws every paragraph\'s text both readers agree on', () => {
    const agreed = truths[0].paragraphs.map((p) => p.text)
      .filter((t) => truths.every((u) => u.paragraphs.some((q) => q.text === t)))
      .map(norm).filter((t) => t !== '' && !t.includes('\t'));
    expect(agreed.length).toBeGreaterThan(0);
    const missing = agreed.filter((t) => !text.includes(t));
    expect(missing).toEqual([]);
  });

  it('tags a heading for every paragraph both readers call one, and a table for every table', () => {
    const types: string[] = [];
    const walk = (els: { Type: string; Children: unknown[] }[]): void => { for (const e of els) { types.push(e.Type); walk(e.Children as never); } };
    walk(doc.GetStructTree()!.Children as never);
    const headings = truths[0].paragraphs.filter((p) => p.heading !== null && truths.every((u) => u.paragraphs.some((q) => q.text === p.text && q.heading === p.heading)));
    expect(types.filter((t) => /^H[1-6]$/.test(t)).length).toBeGreaterThanOrEqual(headings.length);
    expect(types.filter((t) => t === 'Table').length).toBe(Math.min(...truths.map((u) => u.tables.length)));
  });

  it('names in skipped every construct both readers counted', () => {
    const names = new Set(skipped.map((s) => s.name));
    // Footnotes and endnotes RENDER since v9j3.3.2; the case below holds them.
    const missing = COUNT_KEYS.filter((k) => k !== 'footnotes' && k !== 'endnotes'
      && truths.every((t) => t.counts[k] > 0) && !SKIP_MAP[k].some((n) => names.has(n)));
    expect(missing).toEqual([]);
  });

  it('renders every note text both readers agree on, outside table cells', () => {
    const all = (t: DocxTruth) => [...t.notes.footnotes, ...t.notes.endnotes];
    const agreed = all(truths[0]).map((n) => n.text)
      .filter((t) => t !== '' && truths.every((u) => all(u).some((m) => m.text === t)))
      .filter((t) => !/^Cell note/.test(t));          // a cell reference is dropped until v9j3.3.3
    const missing = agreed.map(norm).filter((t) => !text.includes(t));
    expect(missing).toEqual([]);
  });
});
