import { describe, it, expect } from 'vitest';
import {
  escapeLinkDestination, escapeMarkdown, escapeMarkdownInline, escapeTableCell,
} from '../src/mdescape.js';
import { parseMarkdown } from '../src/markdown.js';
import type { MdBlock, MdInline, MdNode } from '../src/mdast.js';

function textOf(node: MdNode): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'code') return node.value;
  if (node.type === 'html_inline' || node.type === 'html_block') return node.literal;
  const kids = (node as { children?: (MdBlock | MdInline)[] }).children ?? [];
  return kids.map(textOf).join('');
}

/** Strings chosen to break a hand-written escaper: every inline construct, the
 *  cell separator, and the block openers that are NOT structural inside a cell. */
const HOSTILE = [
  'plain', 'a|b', 'a||b', '|leading', 'trailing|',
  '*emph*', '_under_', '**strong**', 'a_b_c', 'snake_case_name',
  '`code`', '``two``', '[link](url)', '![img](url)', '<tag>', '<https://x>',
  'a & b', 'a~~b~~c', 'back\\slash', 'a\\|b',
  '# not a heading', '> not a quote', '- not a bullet', '1. not a list', '3.5',
  '+ plus', '=== rule', 'a<br>b', '{}', 'x  y',
];

/** The first cell of the first row of a one-row GFM table. */
function firstCell(md: string): string | undefined {
  const doc = parseMarkdown(md, { gfm: true });
  const table = doc.children.find((b) => b.type === 'table');
  if (!table) return undefined;
  const row = (table as unknown as { children: MdBlock[] }).children[0];
  const cell = (row as unknown as { children: MdBlock[] }).children[0];
  return cell === undefined ? undefined : textOf(cell as MdNode);
}

describe('escapeTableCell', () => {
  // The escaper is specified by our own parser, exactly as escapeMarkdown is:
  // a cell built from escapeTableCell(s) must read back as s. A hand-written
  // character list makes both under- and over-escaping invisible.
  it('round-trips every hostile string through a real GFM table cell', () => {
    for (const s of HOSTILE) {
      const md = `| ${escapeTableCell(s)} | x |\n| --- | --- |\n| a | b |\n`;
      expect(firstCell(md), JSON.stringify(s)).toBe(s);
    }
  });

  it('escapes the cell separator, which escapeMarkdownInline does not', () => {
    expect(escapeTableCell('a|b')).toContain('\\|');
  });

  it('leaves the block openers alone — a cell parses as inline only', () => {
    // escapeMarkdown would ship '3\\.5' and '\\# x'; inside a cell that is
    // correct but needless noise, since no block can start there.
    expect(escapeTableCell('3.5')).toBe('3.5');
    expect(escapeTableCell('# x')).toBe('# x');
    expect(escapeTableCell('- x')).toBe('- x');
  });
});

describe('escapeMarkdown — unchanged by the move', () => {
  it('still escapes the line-leading block openers', () => {
    expect(escapeMarkdown('# heading')).toBe('\\# heading');
    expect(escapeMarkdown('1. item')).toBe('1\\. item');
    expect(escapeMarkdown('- bullet')).toBe('\\- bullet');
  });

  it('still escapes the inline set', () => {
    expect(escapeMarkdown('a *b* c')).toBe('a \\*b\\* c');
  });

  // Byte-identity with the pre-no93.3 escaper, which carried '|' in its inline
  // set. CLAUDE.md records that rule as defensive and unpinned; it stays in the
  // BLOCK escaper regardless, because moving the function must not move any
  // existing caller's output. Only the new cell escaper omits it.
  it('still escapes a pipe in block text', () => {
    expect(escapeMarkdown('a|b')).toBe('a\\|b');
  });

  it('round-trips hostile strings as ordinary paragraph text', () => {
    for (const s of HOSTILE) {
      const doc = parseMarkdown(escapeMarkdown(s), { gfm: true });
      expect(doc.children.map((b) => textOf(b)).join(''), JSON.stringify(s)).toBe(s);
    }
  });
});

describe('escapeMarkdownInline', () => {
  it('escapes the inline set without the block openers', () => {
    expect(escapeMarkdownInline('# x')).toBe('# x');
    expect(escapeMarkdownInline('a *b*')).toBe('a \\*b\\*');
  });

  it('does not escape the cell separator — that belongs to a cell alone', () => {
    expect(escapeMarkdownInline('a|b')).toBe('a|b');
  });
});

/** Destinations chosen to break a naive emitter: the CommonMark forms differ on
 *  whitespace, angle brackets and parenthesis balance. */
const DESTINATIONS = [
  'https://example.com',
  'https://example.com/path?a=1&b=2#frag',
  'https://example.com/a(b)c',
  'https://example.com/unbalanced((',
  'https://example.com/close)',
  'https://example.com/a b',
  'https://example.com/a<b>c',
  'mailto:someone@example.com',
  '#anchor',
  'a\\b',
  'https://example.com/a\\(b',
  '',
];

/** The destination our own parser reads back out of `[t](<dest>)`. */
function parsedDestination(md: string): string | undefined {
  const doc = parseMarkdown(md, { gfm: true });
  const para = doc.children[0];
  if (para === undefined || para.type !== 'paragraph') return undefined;
  const link = para.children.find((n) => n.type === 'link');
  return link === undefined ? undefined : (link as { destination: string }).destination;
}

describe('escapeLinkDestination', () => {
  // Same contract as every other escaper here: specified by our own parser, so
  // that a destination which needs the <...> form, or carries a parenthesis,
  // cannot silently truncate the link.
  it('round-trips every destination through a real inline link', () => {
    for (const uri of DESTINATIONS) {
      const md = `[text](${escapeLinkDestination(uri)})`;
      expect(parsedDestination(md), JSON.stringify(uri)).toBe(uri);
    }
  });

  it('leaves an ordinary URL bare — no needless angle brackets', () => {
    expect(escapeLinkDestination('https://example.com')).toBe('https://example.com');
  });

  it('uses the pointy-bracket form when the destination holds a space', () => {
    expect(escapeLinkDestination('https://example.com/a b')).toBe('<https://example.com/a b>');
  });
});
