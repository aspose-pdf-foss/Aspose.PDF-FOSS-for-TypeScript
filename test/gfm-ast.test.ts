import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdList, MdParagraph, MdTable } from '../src/mdast.js';

/** The tree assertions the HTML oracle cannot make. */

function para(src: string, gfm = true): MdParagraph {
  const doc = parseMarkdown(src, { gfm });
  const first = doc.children[0];
  if (first.type !== 'paragraph') throw new Error(`expected a paragraph, got ${first.type}`);
  return first;
}

function list(src: string, gfm = true): MdList {
  const first = parseMarkdown(src, { gfm }).children[0];
  if (first.type !== 'list') throw new Error(`expected a list, got ${first.type}`);
  return first;
}

describe('strikethrough', () => {
  it('is off unless gfm is asked for', () => {
    expect(para('~~x~~', false).children).toEqual([{ type: 'text', value: '~~x~~' }]);
  });

  it('accepts a single tilde, as cmark-gfm does', () => {
    expect(para('~x~').children).toEqual([
      { type: 'strikethrough', children: [{ type: 'text', value: 'x' }] },
    ]);
  });

  // Not at the start of a line: `~~~x~~~` there is a fenced code block, which
  // is CommonMark and has nothing to do with the delimiter run.
  it('leaves a run of three tildes literal', () => {
    expect(para('a ~~~x~~~ b').children).toEqual([{ type: 'text', value: 'a ~~~x~~~ b' }]);
  });

  it('requires the opener and closer runs to be the same length', () => {
    expect(para('~~x~').children).toEqual([{ type: 'text', value: '~~x~' }]);
  });

  it('nests with emphasis on the one delimiter stack', () => {
    expect(para('~~*x*~~').children).toEqual([
      {
        type: 'strikethrough',
        children: [{ type: 'emph', children: [{ type: 'text', value: 'x' }] }],
      },
    ]);
  });
});

describe('task list items', () => {
  it('records the marker and strips it from the content', () => {
    const l = list('- [ ] foo\n- [x] bar');
    expect(l.children.map((i) => i.checked)).toEqual([false, true]);
    expect(l.children[0].children).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'foo' }] },
    ]);
  });

  it('accepts an uppercase X, which the prose mandates', () => {
    expect(list('- [X] foo').children[0].checked).toBe(true);
  });

  it('leaves an ordinary item undefined rather than false', () => {
    expect(list('- foo').children[0].checked).toBeUndefined();
  });

  it('needs whitespace after the marker', () => {
    const l = list('- [x]foo');
    expect(l.children[0].checked).toBeUndefined();
    expect(l.children[0].children).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '[x]foo' }] },
    ]);
  });

  it('is off unless gfm is asked for', () => {
    expect(list('- [ ] foo', false).children[0].checked).toBeUndefined();
  });

  // The marker must not disturb what drives paragraph spacing in Flow.
  it('leaves list tightness alone', () => {
    expect(list('- [ ] a\n- [ ] b').tight).toBe(true);
    expect(list('- [ ] a\n\n- [ ] b').tight).toBe(false);
  });
});

function table(src: string): MdTable {
  const first = parseMarkdown(src, { gfm: true }).children[0];
  if (first.type !== 'table') throw new Error(`expected a table, got ${first.type}`);
  return first;
}

describe('tables', () => {
  it('carries per-column alignment, with null for a column that gave none', () => {
    expect(table('| a | b | c |\n| :- | -: | --- |').align).toEqual(['left', 'right', null]);
  });

  it('marks the header row and only the header row', () => {
    const t = table('| a |\n| - |\n| b |\n| c |');
    expect(t.children.map((r) => r.header)).toEqual([true, false, false]);
  });

  it('parses inlines inside cells', () => {
    const t = table('| *a* |\n| - |');
    expect(t.children[0].children[0].children).toEqual([
      { type: 'emph', children: [{ type: 'text', value: 'a' }] },
    ]);
  });

  // Only the paragraph's LAST line becomes the header; the rest stays a paragraph.
  it('splits the paragraph above the header off', () => {
    const doc = parseMarkdown('lead in\n| a |\n| - |\n| b |', { gfm: true });
    expect(doc.children.map((n) => n.type)).toEqual(['paragraph', 'table']);
    expect(doc.children[0]).toEqual({
      type: 'paragraph', children: [{ type: 'text', value: 'lead in' }],
    });
  });

  it('needs the header and delimiter rows to have the same width', () => {
    expect(parseMarkdown('| a | b |\n| - |', { gfm: true }).children[0].type).toBe('paragraph');
  });

  it('is off unless gfm is asked for', () => {
    expect(parseMarkdown('| a |\n| - |').children[0].type).toBe('paragraph');
  });

  it('ends at a blank line but not at a pipeless line', () => {
    const doc = parseMarkdown('| a |\n| - |\nbar\n\nbaz', { gfm: true });
    expect(doc.children.map((n) => n.type)).toEqual(['table', 'paragraph']);
    expect((doc.children[0] as MdTable).children.length).toBe(2);
  });

  it('ends where another block begins', () => {
    const doc = parseMarkdown('| a |\n| - |\n> quote', { gfm: true });
    expect(doc.children.map((n) => n.type)).toEqual(['table', 'block_quote']);
  });

  it('works inside a block quote', () => {
    const doc = parseMarkdown('> | a |\n> | - |\n> | b |', { gfm: true });
    const quote = doc.children[0];
    if (quote.type !== 'block_quote') throw new Error('expected a block quote');
    expect(quote.children[0].type).toBe('table');
  });
});
