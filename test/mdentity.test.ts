import { describe, it, expect } from 'vitest';
import { namedEntity } from '../src/mdentity.js';

describe('HTML5 named entities', () => {
  it('resolves the common ones', () => {
    expect(namedEntity('copy')).toBe('©');
    expect(namedEntity('amp')).toBe('&');
    expect(namedEntity('nbsp')).toBe(' ');
    expect(namedEntity('MediumSpace')).toBe(' ');
  });

  it('resolves a two-code-point value', () => {
    expect(namedEntity('NotEqualTilde')).toBe('≂̸');
    expect(namedEntity('nvap')).toBe('≍⃒');
  });

  it('is case sensitive', () => {
    expect(namedEntity('Alpha')).toBe('Α');
    expect(namedEntity('alpha')).toBe('α');
    expect(namedEntity('ALPHA')).toBeUndefined();
  });

  it('rejects a name that is not an entity', () => {
    expect(namedEntity('nope')).toBeUndefined();
    expect(namedEntity('')).toBeUndefined();
  });

  it('does not inherit from Object.prototype', () => {
    expect(namedEntity('constructor')).toBeUndefined();
    expect(namedEntity('__proto__')).toBeUndefined();
    expect(namedEntity('toString')).toBeUndefined();
  });

  it('carries only semicolon-terminated forms', () => {
    // entities.json lists both "&copy;" and the legacy "&copy"; CommonMark
    // recognises only the first, so the table must key on the bare name and
    // admit neither the framing characters nor a semicolon-less-only spelling.
    expect(namedEntity('copy')).toBeDefined();
    expect(namedEntity('copy;')).toBeUndefined();
    expect(namedEntity('&copy')).toBeUndefined();
  });
});
