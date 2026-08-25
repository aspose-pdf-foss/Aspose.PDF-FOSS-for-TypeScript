import { describe, it, expect } from 'vitest';
import { emphasizeMarkdown, escapeMarkdownInline } from '../src/mdescape.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

/** Emit `s` with `style`, then render it through our own parser + oracle. */
const roundTrip = (s: string, style: Parameters<typeof emphasizeMarkdown>[1]) =>
  renderHtml(parseMarkdown(emphasizeMarkdown(escapeMarkdownInline(s), style))).trim();

describe('emphasizeMarkdown', () => {
  it('returns text unchanged when there is no style', () => {
    expect(emphasizeMarkdown('plain', {})).toBe('plain');
  });

  it('spells bold, italic and both', () => {
    expect(emphasizeMarkdown('x', { bold: true })).toBe('**x**');
    expect(emphasizeMarkdown('x', { italic: true })).toBe('*x*');
    expect(emphasizeMarkdown('x', { bold: true, italic: true })).toBe('***x***');
  });

  it('spells script as raw HTML, outermost', () => {
    // CommonMark has no sub/sup syntax; Table.toMarkdown already sets the
    // precedent of emitting raw HTML (<br>) for what GFM cannot express.
    expect(emphasizeMarkdown('x', { script: 'super' })).toBe('<sup>x</sup>');
    expect(emphasizeMarkdown('x', { script: 'sub' })).toBe('<sub>x</sub>');
    // Outermost, so the Markdown delimiters stay adjacent to the text the
    // flanking rules are about.
    expect(emphasizeMarkdown('x', { bold: true, script: 'super' })).toBe('<sup>**x**</sup>');
  });

  it('hoists surrounding whitespace OUTSIDE the delimiters', () => {
    // A closing `**` preceded by whitespace is not a closer, so `** bold **`
    // renders its asterisks literally instead of emphasizing.
    expect(emphasizeMarkdown(' x ', { bold: true })).toBe(' **x** ');
  });

  it('leaves an all-whitespace run alone', () => {
    expect(emphasizeMarkdown('   ', { bold: true })).toBe('   ');
    expect(emphasizeMarkdown('', { bold: true })).toBe('');
  });
});

describe('emphasizeMarkdown round trip through our own parser', () => {
  // The module's stated rule: correctness is defined against our parser, never
  // against a hand-written list of delimiter hazards.
  it('bold reparses as strong', () => {
    expect(roundTrip('word', { bold: true })).toBe('<p><strong>word</strong></p>');
  });

  it('italic reparses as em', () => {
    expect(roundTrip('word', { italic: true })).toBe('<p><em>word</em></p>');
  });

  it('bold+italic reparses as both', () => {
    expect(roundTrip('word', { bold: true, italic: true }))
      .toBe('<p><em><strong>word</strong></em></p>');
  });

  it('a padded run still reparses as strong', () => {
    // The hoisting rule, measured rather than reasoned about: without it the
    // asterisks survive as literal text.
    expect(roundTrip(' word ', { bold: true })).toContain('<strong>word</strong>');
    expect(roundTrip(' word ', { bold: true })).not.toContain('**');
  });

  it('text containing a literal asterisk still reparses as its own text', () => {
    // escapeMarkdownInline escapes `*`, so an emitted delimiter can never
    // collide with one the document contained.
    expect(roundTrip('2 * 3', { bold: true })).toBe('<p><strong>2 * 3</strong></p>');
  });

  it('emphasizes intraword, which is why the delimiter is * and not _', () => {
    expect(roundTrip('word', { bold: true }).includes('_')).toBe(false);
  });
});
