import { expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const withLines = (lines: [number, number, string][]) => Document.Open(buildSimpleTextPdf(
  'BT /F1 10 Tf ' + lines.map(([x, y, s]) => `1 0 0 1 ${x} ${y} Tm (${s}) Tj`).join(' ') + ' ET',
  { baseFont: 'Courier' },
));

it('reads each column separately and optionally joins column and page continuations with source geometry', () => {
  const doc = withLines([[20, 180, 'This text'], [160, 180, 'continues'], [20, 168, 'goes into'], [160, 168, 'and flows']]);
  doc.AddPage(withLines([[25, 220, 'onto page two.']]).Pages[0]);
  const page = doc.Pages[0];
  expect(page.GetParagraphs().map(p => p.text)).toEqual(['This text\ngoes into', 'continues\nand flows']);
  expect(page.GetParagraphs({ joinContinuations: true })).toHaveLength(1);
  const separate = doc.GetParagraphs();
  expect(separate.map(p => p.pageNumber)).toEqual([1, 1, 2]);
  expect(separate[0].continuations).toBeUndefined();
  const joined = doc.GetParagraphs({ joinContinuations: true });
  expect(joined).toHaveLength(1);
  expect(joined[0].text).toBe('This text\ngoes into continues\nand flows onto page two.');
  expect(joined[0].quad).toEqual(separate[0].quad);
  expect(joined[0].lines).toHaveLength(5);
  expect(joined[0].continuations).toEqual(separate.slice(1).map(({ pageNumber, quad, lines }) => ({ pageNumber, quad, lines })));
  expect(doc.GetParagraphs()).toEqual(separate);
});

it('keeps an independent paragraph after a sentence ending, and does not join two paragraphs within a column', () => {
  const doc = withLines([[20, 180, 'A paragraph'], [20, 140, 'ends here.']]);
  doc.AddPage(withLines([[20, 180, 'Another paragraph']]).Pages[0]);
  expect(doc.GetParagraphs({ joinContinuations: true }).map(p => p.text))
    .toEqual(['A paragraph', 'ends here.', 'Another paragraph']);
});

it('reads a spanning title before aligned columns and skips running furniture when joining pages', () => {
  const doc = withLines([[20, 275, 'A title that spans the width of both columns'],
    [20, 180, 'First part'], [165, 180, 'continues'], [20, 168, 'flows into'], [165, 168, 'and flows'],
    [130, 15, '1']]);
  doc.AddPage(withLines([[110, 275, 'Running head'], [20, 220, 'onto page two']]).Pages[0]);
  const parts = doc.GetParagraphs({ joinContinuations: true });
  expect(parts.map(p => p.text)).toEqual(['A title that spans the width of both columns',
    'First part\nflows into continues\nand flows onto page two', '1', 'Running head']);
});
