import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createTable } from '../src/tableauthor.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

/** A REGRESSION FENCE for gl6o.3.3's `paintRowSlice` extraction, not a feature
 *  test. `drawTable` paginates against the page CropBox and a flow element
 *  against a rect, so the two cannot share a pagination loop — but they DO share
 *  the painting, which is lifted out of `drawTable`'s closure into an exported
 *  function. Nothing else in the suite would notice a half-point drift in a row
 *  slice or a dropped border edge.
 *
 *  The hash was generated from the implementation BEFORE the extraction. If it
 *  changes, the extraction moved bytes: find out why rather than re-recording.
 *  Exercises the paths the extraction touches — borders, a background fill, an
 *  outer border, and a repeating header row. */
const build = (): Document => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const t = createTable({
    fontSize: 10,
    border: { width: 0.5, color: [0, 0, 0] },
    background: [0.95, 0.95, 0.95],
    outerBorder: { width: 1, color: [0, 0, 0] },
  });
  t.addRow(['h1', 'h2']);
  for (let i = 0; i < 5; i++) t.addRow([`a${i}`, `b${i}`]);
  t.setRepeatingRowsCount(1);
  page.AddTable(t, 50, 700, { width: 300 });
  return doc;
};

const sha = (doc: Document): string =>
  createHash('sha256').update(doc.Save()).digest('hex').slice(0, 16);

describe('paintRowSlice extraction', () => {
  it('leaves page.AddTable output unchanged', () => {
    expect(sha(build())).toBe('be2bd211ea459e23');
  });
});
