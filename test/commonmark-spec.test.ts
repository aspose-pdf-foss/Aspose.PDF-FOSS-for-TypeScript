import { describe, it, expect } from 'vitest';
import { loadSpecCases, casesInSections } from './helpers/spec-suite.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';


describe('CommonMark spec suite', () => {
  it('loads all 652 official cases', () => {
    const cases = loadSpecCases();
    expect(cases.length).toBe(652);
    expect(new Set(cases.map((c) => c.section)).size).toBe(26);
  });

  it('numbers examples 1..652 with no gaps', () => {
    expect(loadSpecCases().map((c) => c.example)).toEqual(
      Array.from({ length: 652 }, (_, i) => i + 1),
    );
  });

  it('rejects a section name that does not exist', () => {
    expect(() => casesInSections('Tabs', 'Not A Section')).toThrow(/no spec section/);
  });

  it('selects by section', () => {
    const tabs = casesInSections('Tabs');
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.every((c) => c.section === 'Tabs')).toBe(true);
  });
});

/** Every one of the 652 official cases, no allowlist and no skips. A shortfall
 *  is a red build. */
describe('conformance', () => {
  for (const c of loadSpecCases()) {
    it(`${c.section} example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown))).toBe(c.html);
    });
  }
});

/** GFM claims to be a strict superset of CommonMark. This pins exactly which
 *  cases it changes, so behaviour cannot leak into constructs nobody looked at.
 *  Each entry needs a reason; an unexplained number is a bug, not a fact. */
const GFM_DIVERGENCES = new Map<number, string>([
  [602, 'Autolinks: `<https://foo.bar/baz bim>` is no autolink, but GFM links the URL inside it'],
  [606, 'Autolinks: `<foo\\+@bar.example.com>` is no autolink, but GFM links the address inside it'],
  [608, 'Autolinks: `< https://foo.bar >` is no autolink, but GFM links the URL inside it'],
  [611, 'Autolinks: a bare `https://example.com` is plain text in CommonMark and an extended URL autolink in GFM'],
  [612, 'Autolinks: a bare `foo@bar.example.com` is plain text in CommonMark and an extended email autolink in GFM'],
]);

describe('conformance under { gfm: true }', () => {
  it('diverges only where an extension is expected to apply', () => {
    const actual = new Set<number>();
    for (const c of loadSpecCases()) {
      if (renderHtml(parseMarkdown(c.markdown, { gfm: true })) !== c.html) actual.add(c.example);
    }
    expect([...actual].sort((a, b) => a - b)).toEqual([...GFM_DIVERGENCES.keys()].sort((a, b) => a - b));
  });
});
