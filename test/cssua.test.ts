import { describe, it, expect } from 'vitest';
import { parseStylesheet } from '../src/cssparse.js';
import { parseSelectorList } from '../src/cssselect.js';
import { UA_CSS } from '../src/cssua.js';
import type { CssQualifiedRule } from '../src/cssparse.js';

describe('the UA stylesheet', () => {
  it('parses with no error rules at all', () => {
    const rules = parseStylesheet(UA_CSS);
    expect(rules.length).toBeGreaterThan(20);
    expect(rules.filter((r) => r.kind === 'error')).toEqual([]);
  });

  it('has every selector accepted by our own selector engine', () => {
    // A UA rule our matcher refuses is a rule that silently does nothing, and
    // nothing else in the suite would notice.
    const bad: string[] = [];
    for (const r of parseStylesheet(UA_CSS)) {
      if (r.kind !== 'qualified-rule') continue;
      if (parseSelectorList((r as CssQualifiedRule).prelude) === null) {
        bad.push(JSON.stringify((r as CssQualifiedRule).prelude).slice(0, 80));
      }
    }
    expect(bad).toEqual([]);
  });

  it('states the initial font and colour on html, not on body', () => {
    // Inheritance starts at the document element. Setting them on body means
    // a document whose <html> carries text loses them.
    expect(/(^|\})\s*html\s*\{[^}]*font-family/.test(UA_CSS)).toBe(true);
    expect(/(^|\})\s*html\s*\{[^}]*color/.test(UA_CSS)).toBe(true);
  });

  it('gives head and its children display:none', () => {
    expect(/display\s*:\s*none/.test(UA_CSS)).toBe(true);
    expect(UA_CSS).toMatch(/\bhead\b/);
  });

  it('gives li display:list-item and the table parts their table displays', () => {
    expect(UA_CSS).toMatch(/display\s*:\s*list-item/);
    expect(UA_CSS).toMatch(/display\s*:\s*table-cell/);
    expect(UA_CSS).toMatch(/display\s*:\s*table-row-group/);
  });

  it('uses em for heading sizes and margins, so they scale with the base size', () => {
    // Absolute px here would make a document that sets html{font-size}
    // change its body text and not its headings.
    expect(UA_CSS).toMatch(/h1\s*\{[^}]*font-size\s*:\s*2em/);
  });

  it('declares nothing !important', () => {
    // Tier 6 exists because the spec says so, not because this sheet uses it.
    // If that ever changes, the six-tier test in csscascade must gain a case.
    expect(UA_CSS).not.toMatch(/!\s*important/);
  });
});
