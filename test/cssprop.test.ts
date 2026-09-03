import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import { PROPERTIES, INITIAL_STYLE, FONT_SIZE_KEYWORDS } from '../src/cssprop.js';
import type { PropContext } from '../src/cssprop.js';

const V = (s: string) => parseComponentValueList(s);
const CTX: PropContext = {
  fontSize: 16, parentFontSize: 16, rootFontSize: 16, parentWeight: 400,
  color: { rgb: [0, 0, 0], a: 1 },
};
const run = (prop: string, src: string, ctx: PropContext = CTX): unknown =>
  PROPERTIES.get(prop)?.compute(V(src), ctx);

describe('the property table', () => {
  it('holds exactly 43 longhands', () => {
    // Asserted so a half-pasted table is a red build rather than a property
    // that silently falls through to unknown-property.
    expect(PROPERTIES.size).toBe(43);
  });

  it('marks exactly the 13 inherited properties as inherited', () => {
    const inherited = [...PROPERTIES.entries()]
      .filter(([, d]) => d.inherited).map(([n]) => n).sort();
    expect(inherited).toEqual([
      'border-collapse', 'border-spacing', 'color', 'font-family', 'font-size',
      'font-style', 'font-weight', 'line-height', 'list-style-position',
      'list-style-type', 'text-align', 'text-indent', 'white-space',
    ]);
  });

  it('inherits border-collapse and border-spacing, which read wrong', () => {
    // They are inherited so that setting them on a container reaches the
    // table. Asserted on their own because "a border property is inherited"
    // is exactly the row someone will later 'correct'.
    expect(PROPERTIES.get('border-collapse')?.inherited).toBe(true);
    expect(PROPERTIES.get('border-spacing')?.inherited).toBe(true);
    expect(PROPERTIES.get('border-top-color')?.inherited).toBe(false);
  });

  it('does NOT inherit text-decoration or vertical-align', () => {
    // text-decoration PROPAGATES visually to in-flow descendants, which is a
    // rendering rule zch2.4 owns. It is not inheritance and must not be
    // modelled as it, or a descendant that sets its own would wrongly win.
    expect(PROPERTIES.get('text-decoration-line')?.inherited).toBe(false);
    expect(PROPERTIES.get('vertical-align')?.inherited).toBe(false);
  });

  it('gives every property an initial value present in INITIAL_STYLE', () => {
    for (const [name, d] of PROPERTIES) {
      expect(INITIAL_STYLE, name).toHaveProperty(d.key);
    }
  });

  it('names each ComputedStyle key exactly once', () => {
    const keys = [...PROPERTIES.values()].map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('computing individual properties', () => {
  it('reads font-size from a length, a percentage and a keyword', () => {
    expect(run('font-size', '20px')).toBe(20);
    expect(run('font-size', '150%')).toBe(24);        // of parentFontSize 16
    expect(run('font-size', 'medium')).toBe(16);
    expect(run('font-size', 'x-large')).toBe(24);
  });

  it('resolves a font-size em against the PARENT size, not its own', () => {
    // The trap this whole design names. Given ctx.fontSize 16 and
    // parentFontSize 10, `2em` on font-size must be 20 and not 32.
    const ctx = { ...CTX, fontSize: 16, parentFontSize: 10 };
    expect(run('font-size', '2em', ctx)).toBe(20);
  });

  it('scales smaller and larger against the parent', () => {
    const ctx = { ...CTX, parentFontSize: 20 };
    expect(run('font-size', 'larger', ctx)).toBeCloseTo(24, 10);
    expect(run('font-size', 'smaller', ctx)).toBeCloseTo(20 / 1.2, 10);
  });

  it('reads font-weight as a number, a keyword, and relative to the parent', () => {
    expect(run('font-weight', '600')).toBe(600);
    expect(run('font-weight', 'normal')).toBe(400);
    expect(run('font-weight', 'bold')).toBe(700);
    expect(run('font-weight', 'bolder', { ...CTX, parentWeight: 400 })).toBe(700);
    expect(run('font-weight', 'lighter', { ...CTX, parentWeight: 400 })).toBe(100);
    expect(run('font-weight', 'bolder', { ...CTX, parentWeight: 700 })).toBe(900);
  });

  it('refuses a font-weight outside 1..1000', () => {
    expect(run('font-weight', '0')).toBeUndefined();
    expect(run('font-weight', '1001')).toBeUndefined();
  });

  it('reads a font-family list, unquoting strings and keeping case', () => {
    expect(run('font-family', '"Fira Code", Georgia , serif'))
      .toEqual(['Fira Code', 'Georgia', 'serif']);
  });

  it('keeps a line-height NUMBER as a number and a PERCENTAGE as px', () => {
    // Different values, not two spellings. A number inherits as a number so
    // each descendant multiplies by its own size; a percentage inherits as
    // the px it computed to.
    expect(run('line-height', '1.5')).toEqual({ number: 1.5 });
    expect(run('line-height', '150%')).toEqual({ px: 24 });   // of fontSize 16
    expect(run('line-height', '20px')).toEqual({ px: 20 });
    expect(run('line-height', 'normal')).toBe('normal');
  });

  it('resolves currentColor against the context colour', () => {
    const ctx = { ...CTX, color: { rgb: [1, 0, 0] as [number, number, number], a: 1 } };
    expect(run('border-top-color', 'currentColor', ctx)).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('keeps a percentage margin AS a percentage', () => {
    // It resolves against the containing block, which is zch2.3's to know.
    expect(run('margin-top', '10%')).toEqual({ px: 0, pct: 10 });
    expect(run('margin-top', '10px')).toEqual({ px: 10, pct: 0 });
    expect(run('margin-top', 'auto')).toBe('auto');
  });

  it('takes no auto for padding, which has none', () => {
    expect(run('padding-top', 'auto')).toBeUndefined();
    expect(run('padding-top', '10%')).toEqual({ px: 0, pct: 10 });
  });

  it('reads the three border-width keywords as px', () => {
    expect(run('border-top-width', 'thin')).toBe(1);
    expect(run('border-top-width', 'medium')).toBe(3);
    expect(run('border-top-width', 'thick')).toBe(5);
    expect(run('border-top-width', '2px')).toBe(2);
    expect(run('border-top-width', '10%')).toBeUndefined();
  });

  it('reads text-decoration-line as a SET, in any order', () => {
    expect(run('text-decoration-line', 'none')).toEqual([]);
    expect(run('text-decoration-line', 'underline')).toEqual(['underline']);
    expect(run('text-decoration-line', 'line-through underline'))
      .toEqual(['underline', 'line-through']);
    expect(run('text-decoration-line', 'underline underline')).toBeUndefined();
  });

  it('refuses a keyword outside a property own set', () => {
    expect(run('float', 'centre')).toBeUndefined();
    expect(run('display', 'flex')).toBeUndefined();     // out of scope, recorded
    expect(run('white-space', 'pre-wrap')).toBe('pre-wrap');
  });

  it('refuses an EMPTY value for every property', () => {
    // cssparse.ts reports `color:` as a VALID declaration whose value is [].
    // Accepting it makes `color:` set a colour.
    for (const [name, d] of PROPERTIES) {
      expect(d.compute([], CTX), name).toBeUndefined();
    }
  });

  it('never throws, for any property, on any value', () => {
    for (const [name, d] of PROPERTIES) {
      for (const s of ['', 'auto', '0', 'red', '"x"', 'rgb(', '1 2 3 4 5']) {
        expect(() => d.compute(V(s), CTX), `${name}: ${s}`).not.toThrow();
      }
    }
  });
});

describe('FONT_SIZE_KEYWORDS', () => {
  it('is the seven absolute keywords with medium at 16', () => {
    expect(Object.keys(FONT_SIZE_KEYWORDS).sort()).toEqual(
      ['large', 'medium', 'small', 'x-large', 'x-small', 'xx-large', 'xx-small']);
    expect(FONT_SIZE_KEYWORDS['medium']).toBe(16);
  });
});
