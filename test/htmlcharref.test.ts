import { describe, it, expect } from 'vitest';
import { resolveCharRef, C1_REPLACEMENTS } from '../src/htmlcharref.js';

const inText = (s: string) => resolveCharRef(s, 0, false);
const inAttr = (s: string) => resolveCharRef(s, 0, true);

describe('named character references', () => {
  it('resolves a semicolon-terminated reference', () => {
    expect(inText('&copy;')).toEqual({ text: '©', end: 6, errors: [] });
  });

  // Longest match, not first match — and the scan must CONTINUE past a name
  // that is in the table but unusable here. 'notin' is spelled only with its
  // semicolon, so an unterminated '&notin' falls back to the legacy '&not'.
  it('takes the longest usable match', () => {
    expect(inText('&notin;')).toEqual({ text: '∉', end: 7, errors: [] });
    expect(inText('&notit;')).toEqual({
      text: '¬',
      end: 4,
      errors: [{ code: 'missing-semicolon-after-character-reference', offset: 4 }],
    });
    expect(inText('&notin')).toEqual({
      text: '¬',
      end: 4,
      errors: [{ code: 'missing-semicolon-after-character-reference', offset: 4 }],
    });
  });

  it('resolves a legacy reference in text, with an error at the terminator', () => {
    expect(inText('&COPY ')).toEqual({
      text: '©',
      end: 5,
      errors: [{ code: 'missing-semicolon-after-character-reference', offset: 5 }],
    });
  });

  // The attribute rule, and the whole reason mdentity.ts carries the legacy
  // name set. The consumed text is flushed LITERALLY, not dropped.
  it('declines a semicolon-less match in an attribute before = or alphanumeric', () => {
    expect(inAttr('&copy=2')).toEqual({ text: '&copy', end: 5, errors: [] });
    expect(inAttr('&copy1')).toEqual({ text: '&copy', end: 5, errors: [] });
  });

  it('accepts a semicolon-less match in an attribute before anything else', () => {
    expect(inAttr("&COPY'")).toEqual({
      text: '©',
      end: 5,
      errors: [{ code: 'missing-semicolon-after-character-reference', offset: 5 }],
    });
  });

  it('applies no attribute rule to a semicolon-terminated match', () => {
    expect(inAttr('&copy;=2')).toEqual({ text: '©', end: 6, errors: [] });
  });

  it('leaves an unknown reference literal and reports it at the semicolon', () => {
    expect(inText('&nosuch;')).toEqual({
      text: '&',
      end: 1,
      errors: [{ code: 'unknown-named-character-reference', offset: 7 }],
    });
  });

  it('reports nothing for an alphanumeric run with no semicolon', () => {
    expect(inText('&nosuch ')).toEqual({ text: '&', end: 1, errors: [] });
  });

  it('leaves a bare ampersand literal with no error', () => {
    expect(inText('& ')).toEqual({ text: '&', end: 1, errors: [] });
    expect(inText('&')).toEqual({ text: '&', end: 1, errors: [] });
  });
});

describe('numeric character references', () => {
  it('resolves decimal and hexadecimal', () => {
    expect(inText('&#65;')).toEqual({ text: 'A', end: 5, errors: [] });
    expect(inText('&#x41;')).toEqual({ text: 'A', end: 6, errors: [] });
    expect(inText('&#X41;')).toEqual({ text: 'A', end: 6, errors: [] });
  });

  it('reports a missing semicolon at the terminator', () => {
    expect(inText('&#65 ')).toEqual({
      text: 'A',
      end: 4,
      errors: [{ code: 'missing-semicolon-after-character-reference', offset: 4 }],
    });
  });

  // Skipped, these become C1 controls: they draw nothing, so the page looks
  // like a font problem rather than a decode fault.
  it('maps 0x80..0x9F through the windows-1252 table', () => {
    expect(C1_REPLACEMENTS.size).toBe(27);
    expect(inText('&#x80;').text).toBe('€');
    expect(inText('&#x92;').text).toBe('’');
    expect(inText('&#x9F;').text).toBe('Ÿ');
    expect(inText('&#x80;').errors[0]?.code).toBe('control-character-reference');
  });

  it('passes through the five values the table deliberately omits', () => {
    for (const [hex, cp] of [['81', 0x81], ['8D', 0x8d], ['8F', 0x8f], ['90', 0x90], ['9D', 0x9d]] as const) {
      expect(inText(`&#x${hex};`).text).toBe(String.fromCodePoint(cp));
    }
  });

  it('replaces null, out-of-range and surrogate references with U+FFFD', () => {
    expect(inText('&#0;').text).toBe('�');
    expect(inText('&#0;').errors[0]?.code).toBe('null-character-reference');
    expect(inText('&#x110000;').text).toBe('�');
    expect(inText('&#x110000;').errors[0]?.code).toBe('character-reference-outside-unicode-range');
    expect(inText('&#xD800;').text).toBe('�');
    expect(inText('&#xD800;').errors[0]?.code).toBe('surrogate-character-reference');
  });

  it('reports a reference with no digits and consumes nothing past the prefix', () => {
    expect(inText('&#x;')).toEqual({
      text: '&#x',
      end: 3,
      errors: [{ code: 'absence-of-digits-in-numeric-character-reference', offset: 3 }],
    });
    expect(inText('&#;')).toEqual({
      text: '&#',
      end: 2,
      errors: [{ code: 'absence-of-digits-in-numeric-character-reference', offset: 2 }],
    });
  });

  it('reports a noncharacter but passes it through', () => {
    expect(inText('&#xFFFF;').text).toBe('￿');
    expect(inText('&#xFFFF;').errors[0]?.code).toBe('noncharacter-character-reference');
    expect(inText('&#xFDD0;').errors[0]?.code).toBe('noncharacter-character-reference');
  });

  it('does not report ASCII whitespace as a control reference', () => {
    expect(inText('&#x0A;')).toEqual({ text: '\n', end: 6, errors: [] });
    expect(inText('&#x20;')).toEqual({ text: ' ', end: 6, errors: [] });
    // CR is the one whitespace the spec DOES report.
    expect(inText('&#x0D;').errors[0]?.code).toBe('control-character-reference');
  });
});
