import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { comparisonToPdf, Document } from '../src/index.js';
import { buildMultiPageTextPdf } from './helpers/build-text-pdf.js';

const doc = (...pages: string[]) => Document.Open(buildMultiPageTextPdf(
  pages.map(line => `BT /F1 10 Tf 20 260 Td (${line}) Tj ET`)));
const text = (bytes: Uint8Array) => Document.Open(bytes).Pages.map(p => p.GetText()).join(' ').replace(/\s+/g, ' ');

it('writes a searchable report with counts, both edits, and a heading for a missing page', () => {
  const result = doc('prefix common old end', 'missing page').CompareText(doc('prefix common new end'), { mode: 'pages' });
  const original = structuredClone(result);
  const report = comparisonToPdf(result, { title: 'Review copy', context: 1 });
  const content = text(report);
  for (const words of ['Review copy', '3 deleted', '1 inserted', 'common old new end', 'Page 2 (first document only)', 'missing page'])
    expect(content).toContain(words);
  expect(content).not.toContain('prefix');
  expect(result).toEqual(original);
  expect(Document.Open(report).Pages[0].GetPaths().length).toBeGreaterThanOrEqual(2);
});

it('joins character changes inside words, handles empty input, and validates context', () => {
  const result = doc('colour').CompareText(doc('color'), { granularity: 'character' });
  expect(text(comparisonToPdf(result))).toContain('colour');
  expect(text(comparisonToPdf(doc('').CompareText(doc(''))))).toContain('0 inserted');
  expect(() => comparisonToPdf(result, { context: -1 })).toThrow(RangeError);
  expect(() => comparisonToPdf(result, { title: 2 as never })).toThrow(TypeError);
});

it('wraps and paginates through the last word', () => {
  const result = doc('').CompareText(doc('first'));
  result.changes[0].newText = 'first ' + 'paragraph '.repeat(1500) + 'lastword';
  const pages = Document.Open(comparisonToPdf(result)).Pages;
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.at(-1)!.GetText()).toContain('lastword');
});

it('reports edits from the two Word-generated revisions', () => {
  const revision = (n: number) => Document.Open(readFileSync(`test/fixtures/compare/word2010-rev${n}.pdf`));
  const result = revision(1).CompareText(revision(2));
  const report = text(comparisonToPdf(result));
  expect(report).toContain('Late delivery incurs a penalty');
  expect(report).toContain('All prices exclude value added tax');
});

it('keeps non-WinAnsi changes searchable with a supplied font and identifies missing coverage', () => {
  const result = doc('').CompareText(doc('x'));
  result.changes[0].newText = 'Привет';
  expect(() => comparisonToPdf(result)).toThrow(/fontBytes/);
  expect(text(comparisonToPdf(result, { fontBytes: readFileSync('fonts/LiberationSerif-Regular.ttf') })))
    .toContain('Привет');
});
