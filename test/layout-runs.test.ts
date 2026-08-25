import { describe, it, expect } from 'vitest';
import { layoutRuns, layoutText, winAnsiDriver, type LayoutRun } from '../src/layout.js';

const helv = winAnsiDriver('Helvetica');
const run = (text: string, fontSize = 10): LayoutRun => ({ text, driver: helv, fontSize });

/** The text of each laid line, for readability in assertions. */
const texts = (r: { lines: { text: string }[] }): string[] => r.lines.map((l) => l.text);

describe('layoutRuns', () => {
  it('wraps a single run exactly as layoutText does', () => {
    const width = 60;
    const a = layoutRuns([run('one two three four five')], width, Infinity, 12, 10);
    const b = layoutText('one two three four five', helv, 10, width, Infinity, 12);
    expect(texts(a)).toEqual(texts(b));
  });

  // The whole reason segments exist: a word may span a style boundary.
  it('does not break between runs inside one word', () => {
    const r = layoutRuns([run('bold'), run('text'), run(' and more words here')], 40, Infinity, 12, 10);
    expect(r.lines[0].text.startsWith('boldtext')).toBe(true);
  });

  it('splits one line into a segment per run', () => {
    const r = layoutRuns([run('aa'), run('bb'), run('cc')], 200, Infinity, 12, 10);
    expect(r.lines.length).toBe(1);
    expect(r.lines[0].text).toBe('aabbcc');
    expect(r.lines[0].segments.map((s) => [s.run, s.text])).toEqual([[0, 'aa'], [1, 'bb'], [2, 'cc']]);
  });

  it('measures a line as the sum of its segments', () => {
    const r = layoutRuns([run('aa'), run('bb')], 200, Infinity, 12, 10);
    const total = r.lines[0].segments.reduce((n, s) => n + s.width, 0);
    expect(r.lines[0].width).toBeCloseTo(total, 9);
  });

  it('gives a run its own size when measuring', () => {
    const small = layoutRuns([run('aaaa', 6)], 200, Infinity, 12, 10).lines[0].width;
    const large = layoutRuns([run('aaaa', 24)], 200, Infinity, 12, 10).lines[0].width;
    expect(large).toBeCloseTo(small * 4, 6);
  });

  it('carries the split run forward in the remainder', () => {
    const r = layoutRuns([run('alpha '), run('beta gamma delta')], 45, 12, 12, 10);
    expect(r.lines.length).toBe(1);
    expect(r.remainder.every((s) => s.run === 1)).toBe(true);
    expect(r.remainder.map((s) => s.text).join('')).toContain('gamma');
  });

  it('reports an empty remainder when everything fits', () => {
    expect(layoutRuns([run('a b')], 200, 100, 12, 10).remainder).toEqual([]);
  });

  it('drops empty runs without emitting empty segments', () => {
    const r = layoutRuns([run('aa'), run(''), run('bb')], 200, Infinity, 12, 10);
    expect(r.lines[0].segments.map((s) => [s.run, s.text])).toEqual([[0, 'aa'], [2, 'bb']]);
  });

  // The string engine collapses runs of spaces; preserving them would move the
  // bytes of every existing caller.
  it('collapses a run of spaces to one separator', () => {
    expect(texts(layoutRuns([run('a    b')], 200, Infinity, 12, 10))).toEqual(['a b']);
  });
});

describe('layoutText', () => {
  it('still returns a string remainder', () => {
    const r = layoutText('one two three four five six', helv, 10, 40, 24, 12);
    expect(typeof r.remainder).toBe('string');
    expect(r.remainder.length).toBeGreaterThan(0);
  });
});
