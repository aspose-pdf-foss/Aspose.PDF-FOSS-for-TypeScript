import { describe, it, expect } from 'vitest';
import {
  loadTokenizerCases, SUITE_FILES, EXCLUDED, unescapeDoubled, concatCharacterTokens,
} from './helpers/html5lib-tokenizer.js';

describe('the html5lib tokenizer suite loader', () => {
  it('declares 14 files and excludes exactly one, with a reason', () => {
    expect(SUITE_FILES.length).toBe(14);
    expect(EXCLUDED.map((e) => e.file)).toEqual(['xmlViolation.test']);
    expect(EXCLUDED[0].reason).toMatch(/XML/);
  });

  it('loads every non-excluded file', () => {
    const cases = loadTokenizerCases();
    expect(cases.length).toBeGreaterThan(1000);
    expect(new Set(cases.map((c) => c.file)).size).toBe(13);
    expect(cases.some((c) => c.file === 'xmlViolation.test')).toBe(false);
  });

  // xmlViolation.test is excluded STRUCTURALLY: its root key is
  // "xmlViolationTests", not "tests". A name-based skip would silently accept
  // a file whose contents changed shape.
  it('excludes by root key, not by file name', () => {
    expect(() => loadTokenizerCases(['xmlViolation.test'])).toThrow(/xmlViolationTests/);
  });

  it('rejects a file that is not in the declared list', () => {
    expect(() => loadTokenizerCases(['nope.test'])).toThrow(/not a declared/);
  });

  it('resolves doubleEscaped inputs and outputs', () => {
    expect(unescapeDoubled('\\u0000')).toBe('\u0000');
    expect(unescapeDoubled('a\\uFFFDb')).toBe('a\uFFFDb');
    expect(unescapeDoubled('plain')).toBe('plain');
    const nul = loadTokenizerCases(['domjs.test']).find((c) => c.description === 'Raw NUL replacement');
    expect(nul?.input).toBe('\u0000');
    expect(nul?.output[0]).toEqual(['Character', '\uFFFD']);
  });

  // One input with several initialStates is several cases, or a state that
  // fails is hidden by a sibling that passes.
  it('expands initialStates into one case each', () => {
    const cases = loadTokenizerCases(['contentModelFlags.test']);
    const rc = cases.filter((c) => c.description === 'End tag closing RCDATA or RAWTEXT');
    expect(rc.map((c) => c.initialState).sort()).toEqual(['RAWTEXT state', 'RCDATA state']);
    expect(rc.every((c) => c.lastStartTag === 'xmp')).toBe(true);
  });

  it('defaults an unstated initial state to Data', () => {
    const c = loadTokenizerCases(['test1.test']).find((x) => x.description === 'Single Start Tag');
    expect(c?.initialState).toBe('Data state');
  });

  it('defaults a stated-nowhere errors array to empty', () => {
    const c = loadTokenizerCases(['test1.test']).find((x) => x.description === 'Single Start Tag');
    expect(c?.errors).toEqual([]);
  });

  it('concatenates consecutive character tokens, which is what expectations assume', () => {
    expect(concatCharacterTokens([
      ['Character', 'a'], ['Character', 'b'], ['EndTag', 'p'], ['Character', 'c'],
    ])).toEqual([['Character', 'ab'], ['EndTag', 'p'], ['Character', 'c']]);
    expect(concatCharacterTokens([])).toEqual([]);
  });
});
