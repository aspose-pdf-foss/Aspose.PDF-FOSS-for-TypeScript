import { describe, it, expect } from 'vitest';
import { loadCssCases, CSS_SUITES, serializeCss } from './helpers/css-parsing.js';

describe('the css-parsing-tests loader', () => {
  it('declares eight suites', () => {
    expect(CSS_SUITES.length).toBe(8);
  });

  // Counts asserted so a corpus update reddens the build rather than quietly
  // changing what zch2.2.1 tests.
  it('loads every case, with known per-suite counts', () => {
    expect(loadCssCases(['component_value_list']).length).toBe(50);
    expect(loadCssCases(['one_declaration']).length).toBe(21);
    expect(loadCssCases(['stylesheet']).length).toBe(16);
    expect(loadCssCases(['rule_list']).length).toBe(15);
    expect(loadCssCases(['one_rule']).length).toBe(14);
    expect(loadCssCases(['blocks_contents']).length).toBe(13);
    expect(loadCssCases(['declaration_list']).length).toBe(10);
    expect(loadCssCases(['one_component_value']).length).toBe(10);
    expect(loadCssCases().length).toBe(149);
  });

  // The file is a FLAT array of alternating input and expected, not an array
  // of pairs. A loader that reads it as pairs finds half the cases and a
  // trailing undefined, which looks like a corpus problem rather than a
  // reader bug.
  it('reads the flat alternating array', () => {
    const c = loadCssCases(['one_declaration']);
    expect(c[0]?.input).toBe('');
    expect(c[0]?.expected).toEqual(['error', 'empty']);
    expect(c[0]?.index).toBe(0);
    expect(c[1]?.index).toBe(1);
  });

  it('records which suite a case came from', () => {
    expect(loadCssCases(['stylesheet'])[0]?.suite).toBe('stylesheet');
  });

  it('rejects a suite that is not declared', () => {
    expect(() => loadCssCases(['nope' as never])).toThrow(/not a declared/);
  });
});

describe('the css-parsing-tests serializer', () => {
  // The whole point: reproduce a vendored expectation byte for byte from a
  // structure built by hand, before any tokenizer exists to produce one.
  it('reproduces a vendored expectation exactly', () => {
    const expected = loadCssCases(['one_declaration'])
      .find((c) => c.input === 'foo:')?.expected;
    const built = {
      kind: 'declaration', name: 'foo', value: [], important: false,
    };
    expect(serializeCss(built)).toEqual(expected);
  });

  it('writes the bare-string tokens', () => {
    expect(serializeCss({ kind: 'whitespace' })).toBe(' ');
    expect(serializeCss({ kind: 'colon' })).toBe(':');
    expect(serializeCss({ kind: 'semicolon' })).toBe(';');
    expect(serializeCss({ kind: 'comma' })).toBe(',');
    expect(serializeCss({ kind: 'cdo' })).toBe('<!--');
    expect(serializeCss({ kind: 'cdc' })).toBe('-->');
    expect(serializeCss({ kind: 'delim', value: '&' })).toBe('&');
  });

  // The seven the corpus's era tokenizes and the current draft does not.
  it('writes the era-specific tokens', () => {
    expect(serializeCss({ kind: 'match', value: '^=' })).toBe('^=');
    expect(serializeCss({ kind: 'column' })).toBe('||');
    expect(serializeCss({ kind: 'unicode-range', start: 1, end: 16 }))
      .toEqual(['unicode-range', 1, 16]);
  });

  // A number carries its REPRESENTATION and a type flag beside its value.
  // 1 and 1.0 have equal values and differ only in the flag.
  it('writes a number with its representation and type flag', () => {
    expect(serializeCss({ kind: 'number', repr: '1', value: 1, int: true }))
      .toEqual(['number', '1', 1, 'integer']);
    expect(serializeCss({ kind: 'number', repr: '1.0', value: 1, int: false }))
      .toEqual(['number', '1.0', 1, 'number']);
  });

  // A dimension is FIVE elements, though the README's prose says four.
  it('writes a dimension with five elements', () => {
    expect(serializeCss({ kind: 'dimension', repr: '2', value: 2, int: true, unit: 'em' }))
      .toEqual(['dimension', '2', 2, 'integer', 'em']);
  });

  it('writes a hash with its id-or-unrestricted type', () => {
    expect(serializeCss({ kind: 'hash', value: 'a', id: true }))
      .toEqual(['hash', 'a', 'id']);
    expect(serializeCss({ kind: 'hash', value: '1', id: false }))
      .toEqual(['hash', '1', 'unrestricted']);
  });

  it('writes blocks and functions with their contents inline', () => {
    expect(serializeCss({ kind: 'block', open: '{', contents: [{ kind: 'colon' }] }))
      .toEqual(['{}', ':']);
    expect(serializeCss({ kind: 'block', open: '[', contents: [] })).toEqual(['[]']);
    expect(serializeCss({ kind: 'function', name: 'f', args: [{ kind: 'comma' }] }))
      .toEqual(['function', 'f', ',']);
  });

  it('writes rules and errors', () => {
    expect(serializeCss({ kind: 'at-rule', name: 'foo', prelude: [], block: null }))
      .toEqual(['at-rule', 'foo', [], null]);
    expect(serializeCss({ kind: 'qualified-rule', prelude: [], block: [] }))
      .toEqual(['qualified rule', [], []]);
    expect(serializeCss({ kind: 'error', code: 'invalid' }))
      .toEqual(['error', 'invalid']);
  });

  it('serializes an array by mapping over it', () => {
    expect(serializeCss([{ kind: 'colon' }, { kind: 'whitespace' }])).toEqual([':', ' ']);
  });
});
