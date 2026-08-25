import { describe, it, expect } from 'vitest';
import { escapeMarkdown } from '../src/mdexport.js';
import { parseMarkdown } from '../src/markdown.js';
import type { MdBlock, MdInline, MdNode } from '../src/mdast.js';

/** The literal text a parsed document renders, ignoring structure.
 *
 *  Only reaches node kinds a correctly escaped paragraph can produce. A
 *  construct appearing here that should not (a heading, a list, a code span)
 *  shows up as missing or extra text in the caller's comparison. */
function mdText(node: MdNode): string {
  switch (node.type) {
    case 'text': return node.value;
    case 'code': return node.value;
    case 'softbreak': return '\n';
    case 'linebreak': return '\n';
    case 'html_inline': return node.literal;
    case 'html_block': return node.literal;
    case 'code_block': return node.literal;
    case 'thematic_break': return '';
    default: {
      const kids = (node as { children?: (MdBlock | MdInline)[] }).children ?? [];
      return kids.map(mdText).join('');
    }
  }
}

/** The invariant: escaping is correct when the parser recovers the input. */
function roundTrips(s: string): void {
  const escaped = escapeMarkdown(s);
  const parsed = parseMarkdown(escaped, { gfm: true });
  expect(mdText(parsed)).toBe(s);
}

describe('escapeMarkdown — the parser is the oracle', () => {
  const cases: [string, string][] = [
    ['plain text', 'plain text'],
    ['emphasis markers', 'a *b* c and _d_ e'],
    ['a code span', 'use `npm test` now'],
    ['brackets', 'see [1] and ![2]'],
    ['a pipe', 'a | b'],
    ['an angle bracket', 'compare <b> to <https://x>'],
    ['an ampersand entity', 'AT&T and &copy; and &#65;'],
    ['a tilde', 'approx ~5 and ~~six~~'],
    ['a backslash', 'a \\ b and \\* c'],
    ['a leading hash', '# not a heading'],
    ['a leading dash', '- not a list'],
    ['a leading plus', '+ not a list'],
    ['a leading angle', '> not a quote'],
    ['a leading number', '1. not a list'],
    ['a leading paren number', '1) not a list'],
    ['a thematic break', '---'],
    ['a setext underline', '==='],
    ['everything at once', '# 1) a *b* `c` [d] <e> & ~f~ | g \\ h'],
  ];
  for (const [name, input] of cases) {
    it(name, () => roundTrips(input));
  }

  it('leaves text with nothing structural untouched', () => {
    expect(escapeMarkdown('Revenue grew twelve percent this year.'))
      .toBe('Revenue grew twelve percent this year.');
  });

  it('does not escape a mid-line hash or dash', () => {
    // Over-escaping is a defect too: these are not structural where they sit.
    expect(escapeMarkdown('issue #42 and a-b')).toBe('issue #42 and a-b');
  });
});
