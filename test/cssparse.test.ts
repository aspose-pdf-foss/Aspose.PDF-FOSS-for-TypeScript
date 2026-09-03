import { describe, it, expect } from 'vitest';
import {
  parseComponentValueList, parseOneComponentValue, parseOneDeclaration,
  parseRuleList, parseStylesheet,
} from '../src/cssparse.js';
import { serializeCss } from './helpers/css-parsing.js';

const s = (v: unknown): unknown => serializeCss(v);

// Every expectation below is transcribed from the vendored corpus, with its
// suite named. If one disagrees with the vendored case of the same shape, THE
// VENDORED CASE WINS — there is no .dat line to diff against here, so a
// transcription error looks exactly like a parser bug.
describe('the CSS parser', () => {
  // one_declaration
  it('reports an empty declaration', () => {
    expect(s(parseOneDeclaration(''))).toEqual(['error', 'empty']);
  });

  // one_declaration — a declaration with an empty value is valid.
  it('parses a declaration with no value', () => {
    expect(s(parseOneDeclaration('foo:'))).toEqual(['declaration', 'foo', [], false]);
  });

  // one_declaration — !important is case-insensitive and the bang may be
  // separated from the word.
  it('reads important case-insensitively', () => {
    const d = parseOneDeclaration('foo: 9000  !Important') as { important: boolean };
    expect(d.important).toBe(true);
  });

  // rule_list — an at-rule with no block has a NULL block, not an empty one.
  it('gives an at-rule with no block a null block', () => {
    expect(s(parseRuleList('@foo'))).toEqual([['at-rule', 'foo', [], null]]);
  });

  // rule_list — the prelude ends at the block.
  it('splits an at-rule prelude from its block', () => {
    expect(s(parseRuleList('@foo bar{'))).toEqual([
      ['at-rule', 'foo', [' ', ['ident', 'bar']], []],
    ]);
  });

  // rule_list — a qualified rule's prelude is everything before the {.
  it('parses a qualified rule', () => {
    expect(s(parseRuleList('a{b:c}'))).toEqual([
      ['qualified rule', [['ident', 'a']], [['ident', 'b'], ':', ['ident', 'c']]],
    ]);
  });

  // component_value_list — nesting is the parser's job; the tokenizer emits
  // flat open and close tokens.
  it('nests blocks and functions', () => {
    expect(s(parseComponentValueList('[(a)]'))).toEqual([['[]', ['()', ['ident', 'a']]]]);
    expect(s(parseComponentValueList('f(a)'))).toEqual([['function', 'f', ['ident', 'a']]]);
  });

  // component_value_list — an unmatched close is an error VALUE, not a throw
  // and not a dropped token.
  it('reports an unmatched close bracket as an error value', () => {
    expect(s(parseComponentValueList(')'))).toEqual([['error', ')']]);
  });

  // one_component_value — an entry point taking ONE value rejects extra input.
  it('rejects extra input at a single-value entry point', () => {
    expect(s(parseOneComponentValue('a b'))).toEqual(['error', 'extra-input']);
  });

  // stylesheet — CDO and CDC are dropped at the top level of a stylesheet and
  // kept everywhere else.
  it('drops CDO and CDC at stylesheet top level but keeps them elsewhere', () => {
    expect(s(parseStylesheet('<!-- -->'))).toEqual([]);
    expect(s(parseComponentValueList('<!-- -->'))).toEqual(['<!--', ' ', '-->']);
  });

  it('never throws, on any input', () => {
    for (const src of ['', '{', '}', '@', 'a{', '"', 'url(', ';;;']) {
      expect(() => parseStylesheet(src)).not.toThrow();
      expect(() => parseComponentValueList(src)).not.toThrow();
    }
  });
});
