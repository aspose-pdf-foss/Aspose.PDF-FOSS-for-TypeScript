// test/afcall.test.ts
import { describe, it, expect } from 'vitest';
import { parseAfCall, AF_SIGNATURES } from '../src/afcall.js';

describe('parseAfCall accepts one call with literal arguments', () => {
  it('reads a number format call as Acrobat writes it', () => {
    expect(parseAfCall('AFNumber_Format(2, 0, 0, 0, "$", true);'))
      .toEqual({ name: 'AFNumber_Format', args: [2, 0, 0, 0, '$', true] });
  });

  it('accepts the calculation script Acrobat writes, new Array and all', () => {
    // Review Focus 1: Acrobat spells the list as `new Array (...)`, with a space.
    expect(parseAfCall('AFSimple_Calculate("SUM", new Array ("Text1", "Text2"));'))
      .toEqual({ name: 'AFSimple_Calculate', args: ['SUM', ['Text1', 'Text2']] });
  });

  it('accepts an array literal and a comma-separated string list', () => {
    expect(parseAfCall("AFSimple_Calculate('AVG', ['a', 'b'])")?.args).toEqual(['AVG', ['a', 'b']]);
    expect(parseAfCall('AFSimple_Calculate("SUM", "a, b")')?.args).toEqual(['SUM', 'a, b']);
  });

  it('tolerates whitespace, comments and a missing semicolon', () => {
    const s = '  /* fmt */\n AFDate_FormatEx ( "mm/dd/yyyy" ) // done\n';
    expect(parseAfCall(s)).toEqual({ name: 'AFDate_FormatEx', args: ['mm/dd/yyyy'] });
  });

  it('decodes the simple escapes', () => {
    expect(parseAfCall('AFSpecial_KeystrokeEx("a\\"b\\\\c\\n")')?.args).toEqual(['a"b\\c\n']);
  });

  it('reads negative and decimal numbers', () => {
    expect(parseAfCall('AFRange_Validate(true, -5.5, true, .5)')?.args).toEqual([true, -5.5, true, 0.5]);
  });

  it('allows an optional trailing argument to be omitted', () => {
    expect(parseAfCall('AFPercent_Format(2, 0)')?.args).toEqual([2, 0]);
    expect(parseAfCall('AFPercent_Format(2, 0, true)')?.args).toEqual([2, 0, true]);
  });

  it('knows all seventeen names', () => {
    expect(Object.keys(AF_SIGNATURES)).toHaveLength(17);
  });
});

describe('parseAfCall refuses everything else', () => {
  const refused = [
    ['a second statement', 'AFNumber_Format(2,0,0,0,"",true); app.alert(1)'],
    ['an identifier argument', 'AFRange_Validate(true, x, true, 100)'],
    ['an expression argument', 'AFRange_Validate(true, 1+1, true, 100)'],
    ['a \\u escape', 'AFSpecial_KeystrokeEx("\\u0041")'],
    ['a \\x escape', 'AFSpecial_KeystrokeEx("\\x41")'],
    ['an unknown name', 'AFFoo(1)'],
    ['a non-AF function', 'alert(1)'],
    ['a wrong argument type', 'AFNumber_Format("2", 0, 0, 0, "", true)'],
    ['too few arguments', 'AFNumber_Format(2, 0)'],
    ['too many arguments', 'AFDate_FormatEx("m/d", "x")'],
    ['an unterminated string', 'AFDate_FormatEx("m/d)'],
    ['an unterminated comment', 'AFDate_FormatEx("m/d") /* x'],
    ['a newline inside a string', 'AFDate_FormatEx("m\n/d")'],
    ['a number glued to an identifier', 'AFDate_Format(1x)'],
    ['a boolean spelled as an identifier prefix', 'AFRange_Validate(trueish, 0, true, 1)'],
    ['a non-string array member', 'AFSimple_Calculate("SUM", ["a", 1])'],
    ['an empty script', ''],
  ] as const;
  for (const [what, s] of refused) {
    it(`refuses ${what}`, () => { expect(parseAfCall(s)).toBeUndefined(); });
  }

  it('does not find Object.prototype names', () => {
    expect(parseAfCall('constructor()')).toBeUndefined();
    expect(parseAfCall('toString()')).toBeUndefined();
  });
});
