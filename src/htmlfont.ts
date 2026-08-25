import { Rgb, rgbHex } from './colorspace.js';

/** Map the generic family (already derived by `pagerender.applyFontStyle`) plus
 *  bold/italic to a CSS font stack, weight, style, and the calibrated ascent
 *  ratio used to convert a PDF baseline to a CSS `top`. Ratios were measured in
 *  a browser against these exact stacks (see the design spec); they are size-
 *  and style-independent, so the ascent keys on family alone. */
export function resolveFont(
  fontFamily: string, bold: boolean, italic: boolean,
): { stack: string; weight: number; style: 'normal' | 'italic'; ascent: number } {
  const f = fontFamily === 'serif'
    ? { stack: '"Times New Roman", Times, serif', ascent: 0.836 }
    : fontFamily === 'monospace'
    ? { stack: '"Courier New", Courier, monospace', ascent: 0.756 }
    : { stack: 'Arial, Helvetica, sans-serif', ascent: 0.846 };
  return { stack: f.stack, ascent: f.ascent, weight: bold ? 700 : 400, style: italic ? 'italic' : 'normal' };
}

export interface RunFont { cls: string; ascent: number; }

/** Assigns a CSS class (`f0`, `f1`, …) per distinct (stack, weight, style,
 *  color) tuple and emits the matching rules — dedup is document-wide. */
export class FontRegistry {
  private map = new Map<string, { cls: string; rule: string }>();

  get(fontFamily: string, bold: boolean, italic: boolean, color: Rgb): RunFont {
    const r = resolveFont(fontFamily, bold, italic);
    const hex = rgbHex(color);
    const key = `${r.stack}|${r.weight}|${r.style}|${hex}`;
    let e = this.map.get(key);
    if (!e) {
      const cls = `f${this.map.size}`;
      const rule = `.${cls}{font-family:${r.stack};font-weight:${r.weight};font-style:${r.style};color:${hex}}`;
      e = { cls, rule };
      this.map.set(key, e);
    }
    return { cls: e.cls, ascent: r.ascent };
  }

  css(): string {
    return [...this.map.values()].map((e) => e.rule).join('');
  }
}
