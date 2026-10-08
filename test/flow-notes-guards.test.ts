/** A note reference anywhere but a Flow paragraph, heading or list item is
 *  REFUSED rather than drawn without its note (v9j3.3). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';
import type { TextRun } from '../src/textdecor.js';

const run = (): TextRun => ({ text: 'x', footnote: { content: 'n' } } as TextRun);

describe('note references outside Flow paragraphs are refused, not dropped', () => {
  it('AddTextBlock', () => {
    const page = Document.New().AddPage().page;
    expect(() => page.AddTextBlock([run()], [72, 72, 300, 600])).toThrow(TypeError);
  });

  // A table cell INSIDE a flow cites since v9j3.3.3; page.AddTable has no
  // foot to put the note at, so it still refuses.
  it('a table cell given to page.AddTable', () => {
    const doc = Document.New();
    const t = createTable();
    t.addRow([[run()]]);
    expect(() => doc.AddPage().page.AddTable(t, 72, 720, { width: 400 })).toThrow(/footnote/);
  });

  it('a FloatingBox paragraph given runs', () => {
    const doc = Document.New();
    const box = doc.NewFloatingBox({ width: 100 });
    expect(() => {
      box.AddParagraph([run()] as unknown as string);
      doc.NewFlow().AddFloatBox(box, 'left').Render();
    }).toThrow(TypeError);
  });
});
