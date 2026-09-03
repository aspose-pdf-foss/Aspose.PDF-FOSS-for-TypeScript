import { describe, it, expect } from 'vitest';
import { namedEntity, allowsMissingSemicolon, MAX_ENTITY_NAME } from '../src/mdentity.js';

describe('the HTML5 named character reference table', () => {
  it('resolves every name through the one value accessor', () => {
    expect(namedEntity('copy')).toBe('©');
    // A legacy name is ALSO a semicolon key, with the same value — the legacy
    // set is a spelling permission, not a wider name table.
    expect(namedEntity('COPY')).toBe('©');
  });

  it('permits the 106 legacy names to match without a semicolon', () => {
    expect(allowsMissingSemicolon('COPY')).toBe(true);
    expect(allowsMissingSemicolon('AMP')).toBe(true);
    expect(allowsMissingSemicolon('copy')).toBe(true);
  });

  it('refuses the permission to a name that only exists with a semicolon', () => {
    expect(namedEntity('notin')).toBe('∉');
    expect(allowsMissingSemicolon('notin')).toBe(false);
    expect(allowsMissingSemicolon('NotEqualTilde')).toBe(false);
  });

  it('bounds the longest-match scan', () => {
    // 'CounterClockwiseContourIntegral' is the longest key in entities.json.
    expect(MAX_ENTITY_NAME).toBe(31);
    expect(namedEntity('CounterClockwiseContourIntegral')).toBe('∳');
  });

  it('probes with hasOwnProperty, so a document cannot name a prototype key', () => {
    expect(namedEntity('constructor')).toBeUndefined();
    expect(allowsMissingSemicolon('constructor')).toBe(false);
    expect(allowsMissingSemicolon('__proto__')).toBe(false);
  });

  it('resolves a multi-code-point replacement', () => {
    expect(namedEntity('NotEqualTilde')).toBe('≂̸');
  });
});
