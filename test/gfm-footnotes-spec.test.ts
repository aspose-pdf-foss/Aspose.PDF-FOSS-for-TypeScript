// test/gfm-footnotes-spec.test.ts
import { describe, it, expect } from 'vitest';
import { loadExamplesFrom } from './helpers/gfm-suite.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

const EXT = new URL('./fixtures/gfm-footnotes/extensions.txt', import.meta.url);
const REG = new URL('./fixtures/gfm-footnotes/regression.txt', import.meta.url);

/** extensions.txt: every example after `## Footnotes` and before `## Interop`. */
function extensionCases() {
  const all = loadExamplesFrom(EXT);
  const start = all.findIndex((c) => c.section === 'Footnotes');
  const end = all.findIndex((c, i) => i > start && c.section === 'Interop');
  return all.slice(start, end === -1 ? undefined : end);
}
const regressionCases = () => loadExamplesFrom(REG).filter((c) => c.tags.includes('footnotes'));

describe('cmark-gfm footnote corpus', () => {
  it('selects exactly 3 + 7 examples', () => {
    expect(extensionCases()).toHaveLength(3);
    expect(regressionCases()).toHaveLength(7);
  });
  for (const c of [...extensionCases(), ...regressionCases()]) {
    it(`${c.section} (line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});
