import { describe, it, expect } from 'vitest';
import { scanDelimiterRow, splitRow, buildRows } from '../src/mdtable.js';

describe('scanDelimiterRow', () => {
  it('reads alignment off each cell', () => {
    expect(scanDelimiterRow('| --- | :-- | :-: | --: |')).toEqual([null, 'left', 'center', 'right']);
  });

  it('accepts missing outer pipes and loose spacing', () => {
    expect(scanDelimiterRow(':-:  |   -----------:')).toEqual(['center', 'right']);
  });

  it('rejects a line with no dashes', () => {
    expect(scanDelimiterRow('| : | : |')).toBeUndefined();
  });

  it('rejects ordinary text', () => {
    expect(scanDelimiterRow('| abc | def |')).toBeUndefined();
    expect(scanDelimiterRow('---x')).toBeUndefined();
  });

  // A single-column table needs a pipe, or `---` under a paragraph would be a
  // setext heading and `- - -` a thematic break.
  it('reads a single column only when a pipe is present', () => {
    expect(scanDelimiterRow('| --- |')).toEqual([null]);
    expect(scanDelimiterRow('| ---')).toEqual([null]);
    expect(scanDelimiterRow('---')).toBeUndefined();
  });
});

describe('splitRow', () => {
  it('drops the optional outer pipes and trims each cell', () => {
    expect(splitRow('| abc | def |')).toEqual(['abc', 'def']);
    expect(splitRow('bar | baz')).toEqual(['bar', 'baz']);
  });

  it('unescapes an escaped pipe into the cell text', () => {
    expect(splitRow('| f\\|oo  |')).toEqual(['f|oo']);
    expect(splitRow('| b `\\|` az |')).toEqual(['b `|` az']);
  });

  it('keeps empty cells', () => {
    expect(splitRow('| a || b |')).toEqual(['a', '', 'b']);
  });

  it('treats a line with no pipe as one cell', () => {
    expect(splitRow('bar')).toEqual(['bar']);
  });
});

describe('buildRows', () => {
  it('marks the first row as the header', () => {
    const rows = buildRows(['| a | b |', '| c | d |'], 2);
    expect(rows.map((r) => r.header)).toEqual([true, false]);
    expect(rows[1].children.map((c) => c.children)).toEqual([
      [{ type: 'text', value: 'c' }],
      [{ type: 'text', value: 'd' }],
    ]);
  });

  it('pads a short body row and truncates a long one', () => {
    const rows = buildRows(['| a | b |', '| bar |', '| bar | baz | boo |'], 2);
    expect(rows[1].children.map((c) => c.children)).toEqual([[{ type: 'text', value: 'bar' }], []]);
    expect(rows[2].children.map((c) => c.children)).toEqual([
      [{ type: 'text', value: 'bar' }],
      [{ type: 'text', value: 'baz' }],
    ]);
  });

  it('builds a header-only table', () => {
    expect(buildRows(['| a |'], 1).length).toBe(1);
  });
});
