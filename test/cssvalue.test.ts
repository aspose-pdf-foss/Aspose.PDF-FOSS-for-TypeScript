import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import {
  trimWs, keywordOf, cssWideOf, numberOf, lengthOf, absoluteLengthOf,
  colorOf, resolveLengthPct, fixedPx,
} from '../src/cssvalue.js';
import type { LengthContext, LengthPct } from '../src/cssvalue.js';

const V = (s: string) => parseComponentValueList(s);
const CTX: LengthContext = { fontSize: 20, rootFontSize: 16 };

describe('trimWs', () => {
  it('strips whitespace at BOTH ends and nothing inside', () => {
    // A declaration value always carries a leading whitespace token from
    // after the colon, and an !important one carries a trailing token too.
    expect(trimWs(V(' a  b ')).length).toBe(3);
  });

  it('leaves an all-whitespace value empty', () => {
    expect(trimWs(V('   '))).toEqual([]);
  });
});

describe('keywordOf', () => {
  it('lowercases a lone ident', () => {
    expect(keywordOf(V(' AUTO '))).toBe('auto');
  });

  it('refuses anything that is not exactly one ident', () => {
    for (const s of ['', 'a b', '5px', '#abc', 'rgb(1 2 3)']) {
      expect(keywordOf(V(s))).toBeUndefined();
    }
  });
});

describe('cssWideOf', () => {
  it('recognises all four, case-insensitively', () => {
    expect(cssWideOf(V('inherit'))).toBe('inherit');
    expect(cssWideOf(V('INITIAL'))).toBe('initial');
    expect(cssWideOf(V(' unset '))).toBe('unset');
    expect(cssWideOf(V('Revert'))).toBe('revert');
  });

  it('is undefined for an ordinary keyword', () => {
    expect(cssWideOf(V('auto'))).toBeUndefined();
    expect(cssWideOf(V('inherit x'))).toBeUndefined();
  });
});

describe('numberOf', () => {
  it('reads an integer and a fraction', () => {
    expect(numberOf(V('0'), CTX)).toBe(0);
    expect(numberOf(V('1.5'), CTX)).toBe(1.5);
    expect(numberOf(V('-2'), CTX)).toBe(-2);
  });

  it('refuses a dimension or a percentage', () => {
    expect(numberOf(V('1.5em'), CTX)).toBeUndefined();
    expect(numberOf(V('50%'), CTX)).toBeUndefined();
  });
});

describe('lengthOf', () => {
  it('converts every absolute unit to px', () => {
    // 1in = 96px by definition; the rest follow from it.
    expect(lengthOf(V('10px'), CTX)).toEqual({ px: 10, pct: 0 });
    expect(lengthOf(V('1in'), CTX)).toEqual({ px: 96, pct: 0 });
    expect(lengthOf(V('12pt'), CTX)).toEqual({ px: 16, pct: 0 });
    expect(lengthOf(V('1pc'), CTX)).toEqual({ px: 16, pct: 0 });
    expect((lengthOf(V('1cm'), CTX) as { px: number }).px).toBeCloseTo(37.795275, 5);
    expect((lengthOf(V('1mm'), CTX) as { px: number }).px).toBeCloseTo(3.7795275, 6);
    expect((lengthOf(V('1Q'), CTX) as { px: number }).px).toBeCloseTo(0.9448818, 6);
  });

  it('is case-insensitive about units, including Q', () => {
    expect(lengthOf(V('10PX'), CTX)).toEqual({ px: 10, pct: 0 });
    expect(lengthOf(V('1q'), CTX)).toEqual(lengthOf(V('1Q'), CTX));
  });

  it('resolves em against the context font size and rem against the root', () => {
    expect(lengthOf(V('2em'), CTX)).toEqual({ px: 40, pct: 0 });
    expect(lengthOf(V('2rem'), CTX)).toEqual({ px: 32, pct: 0 });
  });

  it('resolves ex and ch on the documented 0.5em fallback', () => {
    // We have no font metrics here. CSS names 0.5em as the fallback for both,
    // so this is the spec's answer rather than a guess — and it is why the
    // oracle excludes them: Chrome has metrics and we do not.
    expect(lengthOf(V('2ex'), CTX)).toEqual({ px: 20, pct: 0 });
    expect(lengthOf(V('2ch'), CTX)).toEqual({ px: 20, pct: 0 });
  });

  it('keeps a percentage AS a percentage', () => {
    // It resolves against the containing block, which is zch2.3's to know.
    expect(lengthOf(V('50%'), CTX)).toEqual({ px: 0, pct: 50 });
  });

  it('accepts a bare ZERO and no other bare number', () => {
    // `margin: 0` is valid CSS and `margin: 5` is not. Accepting any number
    // makes a typo silently become a length.
    expect(lengthOf(V('0'), CTX)).toEqual({ px: 0, pct: 0 });
    expect(lengthOf(V('5'), CTX)).toBeUndefined();
    // `-0` arrives as +0: csstoken.ts normalises negative zero, which is one
    // of its own recorded invariants and the reason this reads oddly. Object.is
    // distinguishes the two, so an assertion of -0 here fails against a
    // perfectly correct tokenizer.
    expect(lengthOf(V('-0'), CTX)).toEqual({ px: 0, pct: 0 });
  });

  it('refuses an unknown unit rather than guessing', () => {
    expect(lengthOf(V('5vw'), CTX)).toBeUndefined();
    expect(lengthOf(V('5vh'), CTX)).toBeUndefined();
    expect(lengthOf(V('5furlong'), CTX)).toBeUndefined();
  });
});

describe('lengthOf, the math functions', () => {
  it('reads a calc() at any length site', () => {
    expect(lengthOf(V('calc(1em + 2px)'), CTX)).toEqual({ px: 22, pct: 0 });
  });

  it('carries a mixed px-and-percentage calc() through unresolved', () => {
    expect(lengthOf(V('calc(100% - 20px)'), CTX)).toEqual({ px: -20, pct: 100 });
  });

  it('retains a percentage-bearing comparison as an expression', () => {
    const v = lengthOf(V('min(50%, 100px)'), CTX);
    expect(v).toEqual({ expr: expect.objectContaining({ kind: 'fn', fn: 'min' }) });
  });

  it('refuses a NUMBER-typed math function at a length site', () => {
    // `width: calc(5)` is invalid for the same reason `width: 5` is, and it
    // falls out of the type algebra rather than needing a rule of its own.
    expect(lengthOf(V('calc(2 + 3)'), CTX)).toBeUndefined();
  });

  it('refuses a math function beside anything else', () => {
    // lengthOf takes exactly ONE component value, calc included.
    expect(lengthOf(V('calc(1px) calc(2px)'), CTX)).toBeUndefined();
  });
});

describe('numberOf, the math functions', () => {
  it('reads a NUMBER-typed math function', () => {
    expect(numberOf(V('calc(2 * 3 + 1)'), CTX)).toBe(7);
    expect(numberOf(V('clamp(1, 5, 3)'), CTX)).toBe(3);
  });

  it('refuses a LENGTH-typed math function at a number site', () => {
    expect(numberOf(V('calc(1px + 1px)'), CTX)).toBeUndefined();
  });
});

describe('resolveLengthPct', () => {
  it('adds the percentage part to the px part', () => {
    expect(resolveLengthPct({ px: -20, pct: 100 }, 200)).toBe(180);
  });

  it('resolves a retained expression against the basis', () => {
    const v = lengthOf(V('min(50%, 100px)'), CTX) as LengthPct;
    expect(resolveLengthPct(v, 100)).toBe(50);
    expect(resolveLengthPct(v, 1000)).toBe(100);
  });
});

describe('fixedPx', () => {
  it('answers only for a value that does not depend on the basis', () => {
    expect(fixedPx({ px: 3, pct: 0 })).toBe(3);
    expect(fixedPx({ px: 3, pct: 10 })).toBeUndefined();
    expect(fixedPx(lengthOf(V('min(50%, 100px)'), CTX) as LengthPct)).toBeUndefined();
  });
});

describe('absoluteLengthOf', () => {
  it('is lengthOf with percentages refused', () => {
    // Border widths and letter spacing take no percentage; a caller that
    // cannot resolve one must not be handed one.
    expect(absoluteLengthOf(V('3px'), CTX)).toBe(3);
    expect(absoluteLengthOf(V('50%'), CTX)).toBeUndefined();
  });

  it('accepts a percentage-free calc() and refuses one that carries any', () => {
    expect(absoluteLengthOf(V('calc(1em - 2px)'), CTX)).toBe(18);
    expect(absoluteLengthOf(V('calc(50% + 2px)'), CTX)).toBeUndefined();
    expect(absoluteLengthOf(V('min(50%, 2px)'), CTX)).toBeUndefined();
  });
});

describe('colorOf', () => {
  const rgb = (v: string) => {
    const c = colorOf(V(v));
    if (c === undefined || c === 'currentcolor') throw new Error(`not a colour: ${v}`);
    return c;
  };

  it('reads 6-digit hex', () => {
    expect(rgb('#ff0000')).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('reads 6-digit hex whose name is NOT an identifier', () => {
    // THE TRAP, and it is the exact inverse of cssselect.ts's. A hash token
    // carries id:true only when its name is an identifier, so #123456 and
    // #1a2b3c are id:false while #abc and #a1b2c3 are id:true. An id SELECTOR
    // must require the flag; a COLOUR must ignore it entirely. Keying on it
    // here rejects one of the commonest colour values there is.
    expect(rgb('#123456').rgb[0]).toBeCloseTo(0x12 / 255, 10);
    expect(rgb('#1a2b3c').rgb[2]).toBeCloseTo(0x3c / 255, 10);
  });

  it('reads 3-digit hex by doubling each digit', () => {
    expect(rgb('#abc')).toEqual(rgb('#aabbcc'));
  });

  it('reads 4- and 8-digit hex, the last channel being alpha', () => {
    expect(rgb('#ff000080').a).toBeCloseTo(0x80 / 255, 10);
    expect(rgb('#f008')).toEqual(rgb('#ff000088'));
  });

  it('refuses a hex of any other length', () => {
    for (const s of ['#a', '#ab', '#abcde', '#abcdefa', '#abcdefabc']) {
      expect(colorOf(V(s))).toBeUndefined();
    }
  });

  it('refuses a hex carrying a non-hex character', () => {
    expect(colorOf(V('#gghhii'))).toBeUndefined();
  });

  it('reads rgb() in the comma form and the space form alike', () => {
    expect(rgb('rgb(255, 0, 0)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('rgb(255 0 0)')).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('reads the alpha of rgba(), and of rgb() with a slash', () => {
    expect(rgb('rgba(255, 0, 0, 0.5)').a).toBe(0.5);
    expect(rgb('rgb(255 0 0 / 0.5)').a).toBe(0.5);
    expect(rgb('rgb(255 0 0 / 50%)').a).toBe(0.5);
  });

  it('reads percentage rgb components', () => {
    expect(rgb('rgb(100%, 0%, 0%)')).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('clamps out-of-range components rather than refusing them', () => {
    expect(rgb('rgb(300, -20, 0)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('rgba(0,0,0,5)').a).toBe(1);
  });

  it('reads hsl(), including the hue as a bare number or a deg angle', () => {
    expect(rgb('hsl(0 100% 50%)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('hsl(0deg 100% 50%)')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('hsl(120, 100%, 50%)')).toEqual({ rgb: [0, 1, 0], a: 1 });
  });

  it('wraps a hue outside 0..360', () => {
    expect(rgb('hsl(480 100% 50%)')).toEqual(rgb('hsl(120 100% 50%)'));
    expect(rgb('hsl(-120 100% 50%)')).toEqual(rgb('hsl(240 100% 50%)'));
  });

  it('reads hsla()', () => {
    expect(rgb('hsla(0, 100%, 50%, 0.25)').a).toBe(0.25);
  });

  it('reads a named colour, case-insensitively', () => {
    expect(rgb('red')).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(rgb('ReBeCcApUrPlE')).toEqual(rgb('rebeccapurple'));
  });

  it('reads transparent as an ALPHA rather than an absence', () => {
    // a: 0 rather than a separate case, so nothing downstream has to
    // special-case "no colour" beside "a colour".
    expect(rgb('transparent')).toEqual({ rgb: [0, 0, 0], a: 0 });
  });

  it('reports currentColor as a sentinel, not a colour', () => {
    // It cannot be resolved here: it means the element's own computed `color`,
    // which csscompute.ts knows and this module does not.
    expect(colorOf(V('currentColor'))).toBe('currentcolor');
    expect(colorOf(V('CURRENTCOLOR'))).toBe('currentcolor');
  });

  it('refuses a value it cannot read, and never throws', () => {
    for (const s of ['', 'notacolour', 'rgb(1)', 'rgb(1,2)', 'hsl(1,2,3,4,5)',
      'url(x.png)', '5px', 'red blue']) {
      expect(() => colorOf(V(s))).not.toThrow();
      expect(colorOf(V(s))).toBeUndefined();
    }
  });
});
