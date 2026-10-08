// test/flow-table-notes-identity.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';

/** Note-free Flow tables, hashed on the code BEFORE v9j3.3.3. A FENCE:
 *  never re-record to make it pass. */
const sha = (pages: { Contents: Uint8Array }[]): string =>
  createHash('sha256').update(Buffer.concat(pages.map((p) => Buffer.from(p.Contents)))).digest('hex').slice(0, 16);

const big = () => {
  const t = createTable({ fontSize: 10 });
  t.addRow(['Head A', 'Head B']);
  t.setRepeatingRowsCount(1);
  for (let i = 0; i < 90; i++) {
    const r = t.addRow();
    r.addCell([{ text: `row ${i}` }]);
    r.addCell('second');
  }
  return t;
};

describe('note-free Flow tables are byte-identical (v9j3.3.3 fence)', () => {
  it('a plain run-cell table', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    t.addRow().addCell([{ text: 'rich ' }, { text: 'bold', font: 'Helvetica-Bold' }]);
    t.rows[1].addCell('c');
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    expect(sha(flow.Render())).toMatchInlineSnapshot(`"77b8a4accf63139e"`);
  });
  it('a split table with a repeating header', () => {
    const flow = Document.New().NewFlow();
    flow.AddTable(big());
    expect(sha(flow.Render())).toMatchInlineSnapshot(`"00862b6bfdd517be"`);
  });
  it('a tagged split table', () => {
    const flow = Document.New().NewFlow({ tagged: true });
    flow.AddTable(big());
    expect(sha(flow.Render())).toMatchInlineSnapshot(`"983dded5dc6407a0"`);
  });
});
