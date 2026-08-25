import { describe, it, expect } from 'vitest';
import { loadGfmExamples, gfmExtensionCases } from './helpers/gfm-suite.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

describe('GFM spec suite', () => {
  // The full count is asserted because the extension cases are selected out of
  // it: a fence scanner that silently loses examples would still return a
  // plausible-looking subset.
  it('finds every example in the vendored file', () => {
    expect(loadGfmExamples().length).toBe(672);
  });

  it('numbers examples 1..672 with no gaps', () => {
    expect(loadGfmExamples().map((c) => c.example)).toEqual(
      Array.from({ length: 672 }, (_, i) => i + 1),
    );
  });

  it('selects the 24 extension examples', () => {
    const cases = gfmExtensionCases();
    const counts: Record<string, number> = {};
    for (const c of cases) counts[c.extension] = (counts[c.extension] ?? 0) + 1;
    expect(counts).toEqual({ table: 8, disabled: 2, strikethrough: 2, autolink: 11, tagfilter: 1 });
    expect(cases.length).toBe(24);
  });

  it('carries the section heading and the example body', () => {
    const first = gfmExtensionCases()[0];
    expect(first.section).toBe('Tables (extension)');
    expect(first.markdown).toBe('| foo | bar |\n| --- | --- |\n| baz | bim |\n');
    expect(first.html.startsWith('<table>\n<thead>\n')).toBe(true);
  });
});

describe('strikethrough', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'strikethrough')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});

describe('task list items', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'disabled')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});

describe('tables', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'table')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});

describe('extended autolinks', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'autolink')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});

describe('disallowed raw HTML', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'tagfilter')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});
