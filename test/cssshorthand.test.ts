import { describe, it, expect } from 'vitest';
import { parseComponentValueList } from '../src/cssparse.js';
import { expandShorthand, SHORTHANDS } from '../src/cssshorthand.js';
import { keywordOf } from '../src/cssvalue.js';

const V = (s: string) => parseComponentValueList(s);

/** Expand, then render each longhand's value as a comparable string. */
const ex = (name: string, src: string): Record<string, string> | undefined => {
  const got = expandShorthand(name, V(src));
  if (got === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of got) {
    out[k] = v.map((t) => {
      const x = t as { kind: string; value?: unknown; unit?: string };
      if (x.kind === 'whitespace') return ' ';
      if (x.kind === 'dimension') return `${String(x.value)}${String(x.unit)}`;
      if (x.kind === 'percentage') return `${String(x.value)}%`;
      if (x.kind === 'hash') return `#${String(x.value)}`;
      // A comma renders bare: the whitespace that follows it in the source is
      // its own token and is rendered separately, so ', ' here doubles it.
      if (x.kind === 'comma') return ',';
      return String(x.value ?? x.kind);
    }).join('').trim();
  }
  return out;
};

describe('the shorthand set', () => {
  it('names exactly the fourteen shorthands in scope', () => {
    expect([...SHORTHANDS].sort()).toEqual([
      'background', 'border', 'border-bottom', 'border-color', 'border-left',
      'border-right', 'border-style', 'border-top', 'border-width', 'font',
      'list-style', 'margin', 'padding', 'text-decoration',
    ].sort());
  });
});

describe('margin and padding', () => {
  it('expands one value to all four sides', () => {
    expect(ex('margin', '1px')).toEqual({
      'margin-top': '1px', 'margin-right': '1px',
      'margin-bottom': '1px', 'margin-left': '1px',
    });
  });

  it('expands two values as vertical then horizontal', () => {
    expect(ex('padding', '1px 2px')).toEqual({
      'padding-top': '1px', 'padding-right': '2px',
      'padding-bottom': '1px', 'padding-left': '2px',
    });
  });

  it('expands three values as top, horizontal, bottom', () => {
    expect(ex('margin', '1px 2px 3px')).toEqual({
      'margin-top': '1px', 'margin-right': '2px',
      'margin-bottom': '3px', 'margin-left': '2px',
    });
  });

  it('expands four values clockwise from the top', () => {
    expect(ex('margin', '1px 2px 3px 4px')).toEqual({
      'margin-top': '1px', 'margin-right': '2px',
      'margin-bottom': '3px', 'margin-left': '4px',
    });
  });

  it('refuses zero or more than four values', () => {
    expect(ex('margin', '')).toBeUndefined();
    expect(ex('margin', '1px 2px 3px 4px 5px')).toBeUndefined();
  });

  it('carries auto through, margin having one', () => {
    expect(ex('margin', '0 auto')?.['margin-left']).toBe('auto');
  });
});

describe('border and its per-side forms', () => {
  it('sets all twelve longhands from one border declaration', () => {
    const got = ex('border', '1px solid red');
    expect(Object.keys(got ?? {}).length).toBe(12);
    expect(got?.['border-top-width']).toBe('1px');
    expect(got?.['border-left-style']).toBe('solid');
    expect(got?.['border-bottom-color']).toBe('red');
  });

  it('accepts the three components in ANY order', () => {
    expect(ex('border', 'red 1px solid')).toEqual(ex('border', '1px solid red'));
    expect(ex('border', 'solid red 1px')).toEqual(ex('border', '1px solid red'));
  });

  it('RESETS an omitted component to initial rather than leaving it alone', () => {
    // The rule that needs no special case: an unmentioned longhand is emitted
    // with a synthetic `initial`, and the CSS-wide keyword machinery does the
    // rest. Without it, `border: 1px` after `border-color: red` would wrongly
    // keep the red.
    const got = ex('border', '1px');
    expect(got?.['border-top-width']).toBe('1px');
    expect(got?.['border-top-style']).toBe('initial');
    expect(got?.['border-top-color']).toBe('initial');
  });

  it('scopes border-top to one side only', () => {
    const got = ex('border-top', '2px dashed blue');
    expect(Object.keys(got ?? {}).sort())
      .toEqual(['border-top-color', 'border-top-style', 'border-top-width']);
  });

  it('expands border-width, border-style and border-color four ways', () => {
    expect(ex('border-width', '1px 2px')?.['border-left-width']).toBe('2px');
    expect(ex('border-style', 'solid')?.['border-bottom-style']).toBe('solid');
    expect(ex('border-color', 'red green blue')?.['border-left-color']).toBe('green');
  });

  it('refuses a border component it cannot classify', () => {
    expect(ex('border', '1px solid notacolour')).toBeUndefined();
    expect(ex('border', '1px solid red green')).toBeUndefined();
  });
});

describe('font', () => {
  it('expands size and family, resetting style and weight', () => {
    const got = ex('font', '12px serif');
    expect(got?.['font-size']).toBe('12px');
    expect(got?.['font-family']).toBe('serif');
    expect(got?.['font-style']).toBe('initial');
    expect(got?.['font-weight']).toBe('initial');
    expect(got?.['line-height']).toBe('initial');
  });

  it('reads the optional prefix in any order', () => {
    const got = ex('font', 'italic bold 12px serif');
    expect(got?.['font-style']).toBe('italic');
    expect(got?.['font-weight']).toBe('bold');
    expect(ex('font', 'bold italic 12px serif')).toEqual(got);
  });

  it('reads a numeric weight in the prefix', () => {
    expect(ex('font', '600 12px serif')?.['font-weight']).toBe('600');
  });

  it('reads the size/line-height pair, which has no spaces around the slash', () => {
    // Measured: `12px/1.5` tokenizes as dimension, delim '/', number — all
    // inside one whitespace-delimited part, so the slash must be found at
    // TOKEN level rather than by splitting on spaces.
    const got = ex('font', 'italic 12px/1.5 Georgia, serif');
    expect(got?.['font-size']).toBe('12px');
    expect(got?.['line-height']).toBe('1.5');
    expect(got?.['font-family']).toBe('Georgia, serif');
  });

  it('reads the slash form with spaces around it too', () => {
    expect(ex('font', '12px / 1.5 serif')?.['line-height']).toBe('1.5');
  });

  it('accepts a font-size keyword as the size', () => {
    expect(ex('font', 'large serif')?.['font-size']).toBe('large');
  });

  it('requires both a size and a family', () => {
    expect(ex('font', '12px')).toBeUndefined();
    expect(ex('font', 'serif')).toBeUndefined();
    expect(ex('font', 'italic bold')).toBeUndefined();
  });

  it('REFUSES the system font keywords rather than half-applying them', () => {
    // `font: menu` means "whatever this platform's menu font is", which we
    // cannot answer. Refusing records it for zch2.7; guessing would set a
    // family the author never named.
    for (const k of ['caption', 'icon', 'menu', 'message-box', 'small-caption',
      'status-bar']) {
      expect(ex('font', k), k).toBeUndefined();
    }
  });
});

describe('the remaining shorthands', () => {
  it('takes only the colour from background', () => {
    expect(ex('background', 'red')).toEqual({ 'background-color': 'red' });
  });

  it('refuses a background carrying anything but a colour', () => {
    // Refusing records it for zch2.7. Taking the colour and dropping the
    // image would render a flat panel where the author wrote a picture.
    expect(ex('background', 'url(x.png)')).toBeUndefined();
    expect(ex('background', 'red url(x.png) no-repeat')).toBeUndefined();
  });

  it('expands list-style, in either order, resetting the other half', () => {
    expect(ex('list-style', 'square inside')).toEqual({
      'list-style-type': 'square', 'list-style-position': 'inside',
    });
    expect(ex('list-style', 'inside square')).toEqual(ex('list-style', 'square inside'));
    expect(ex('list-style', 'square')?.['list-style-position']).toBe('initial');
  });

  it('reads a bare none on list-style as the TYPE', () => {
    // `none` is legal for both the type and the image. The image is out of
    // scope, so the type is the only reading that means anything here.
    expect(ex('list-style', 'none')?.['list-style-type']).toBe('none');
  });

  it('expands text-decoration in any order, resetting the rest', () => {
    const got = ex('text-decoration', 'underline dotted red');
    expect(got?.['text-decoration-line']).toBe('underline');
    expect(got?.['text-decoration-style']).toBe('dotted');
    expect(got?.['text-decoration-color']).toBe('red');
    expect(ex('text-decoration', 'underline')?.['text-decoration-color']).toBe('initial');
  });

  it('reads a multi-word text-decoration line', () => {
    expect(ex('text-decoration', 'underline line-through')?.['text-decoration-line'])
      .toBe('underline line-through');
  });
});

describe('the whole set', () => {
  it('returns undefined for a name that is not a shorthand', () => {
    expect(expandShorthand('color', V('red'))).toBeUndefined();
  });

  it('never throws, for any shorthand, on any value', () => {
    for (const name of SHORTHANDS) {
      for (const s of ['', '  ', 'initial', '1px', 'red', 'a b c d e f', '/', '1px/']) {
        expect(() => expandShorthand(name, V(s)), `${name}: ${s}`).not.toThrow();
      }
    }
  });

  it('passes a CSS-wide keyword straight through to every longhand', () => {
    // `margin: inherit` means all four sides inherit. Handling it inside each
    // shorthand's own grammar would be four more places to get it wrong.
    expect(ex('margin', 'inherit')).toEqual({
      'margin-top': 'inherit', 'margin-right': 'inherit',
      'margin-bottom': 'inherit', 'margin-left': 'inherit',
    });
    expect(ex('font', 'unset')?.['font-family']).toBe('unset');
    expect(keywordOf(V('unset'))).toBe('unset');
  });
});
