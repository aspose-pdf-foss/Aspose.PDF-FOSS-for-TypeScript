import { describe, it, expect } from 'vitest';
import { validateTemplate, resolveTemplate, stampedNow } from '../src/decorate.js';

const values = {
  page: '2', total: '10', label: 'ii', bates: 'ABC-000042', date: '2026-07-17', time: '14:32',
};

describe('validateTemplate', () => {
  it('accepts the known tokens', () => {
    expect(() => validateTemplate('{page}/{total} {label} {date} {time}', false)).not.toThrow();
  });

  it('accepts text with no tokens', () => {
    expect(() => validateTemplate('DRAFT', false)).not.toThrow();
  });

  it('throws TypeError on an unknown token', () => {
    expect(() => validateTemplate('Page {pages}', false)).toThrow(TypeError);
  });

  it('names the offending token and lists the valid set', () => {
    expect(() => validateTemplate('Page {pages}', false)).toThrow(/\{pages\}.*\{page\}/s);
  });

  it('rejects {bates} when no counter is in scope', () => {
    expect(() => validateTemplate('{bates}', false)).toThrow(TypeError);
  });

  it('accepts {bates} when a counter is in scope', () => {
    expect(() => validateTemplate('{bates}', true)).not.toThrow();
  });

  it('ignores an escaped brace', () => {
    expect(() => validateTemplate('{{page}', false)).not.toThrow();
  });
});

describe('resolveTemplate', () => {
  it('substitutes each token', () => {
    expect(resolveTemplate('{page} of {total}', values)).toBe('2 of 10');
  });

  it('substitutes the page label', () => {
    expect(resolveTemplate('[{label}]', values)).toBe('[ii]');
  });

  it('substitutes date and time', () => {
    expect(resolveTemplate('{date} {time}', values)).toBe('2026-07-17 14:32');
  });

  it('unescapes {{ to a literal brace', () => {
    expect(resolveTemplate('{{page}', values)).toBe('{page}');
  });

  it('leaves a bare closing brace literal', () => {
    expect(resolveTemplate('a}b', values)).toBe('a}b');
  });

  it('repeats a token as many times as it appears', () => {
    expect(resolveTemplate('{page}{page}', values)).toBe('22');
  });

  it('leaves text without tokens untouched', () => {
    expect(resolveTemplate('CONFIDENTIAL', values)).toBe('CONFIDENTIAL');
  });
});

describe('stampedNow', () => {
  it('formats date as YYYY-MM-DD and time as HH:MM', () => {
    const s = stampedNow();
    expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.time).toMatch(/^\d{2}:\d{2}$/);
  });
});
