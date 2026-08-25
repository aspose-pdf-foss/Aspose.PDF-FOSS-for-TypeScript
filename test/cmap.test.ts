import { describe, it, expect } from 'vitest';
import { parseCMap } from '../src/cmap.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('parseCMap', () => {
  it('parses bfchar single mappings', () => {
    const cmap = parseCMap(enc(
      '/CIDInit /ProcSet findresource begin\n' +
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar\n<0041> <0041>\n<0042> <0062>\nendbfchar\n'
    ));
    expect(cmap.codeWidth).toBe(2);
    expect(cmap.lookup(0x0041)).toBe('A');
    expect(cmap.lookup(0x0042)).toBe('b');
    expect(cmap.lookup(0x0043)).toBeUndefined();
  });

  it('parses bfrange with destination base', () => {
    const cmap = parseCMap(enc(
      '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '1 beginbfrange\n<20> <22> <0061>\nendbfrange\n'
    ));
    expect(cmap.codeWidth).toBe(1);
    expect(cmap.lookup(0x20)).toBe('a');
    expect(cmap.lookup(0x21)).toBe('b');
    expect(cmap.lookup(0x22)).toBe('c');
  });

  it('parses bfrange with array destinations', () => {
    const cmap = parseCMap(enc(
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '1 beginbfrange\n<0003> <0005> [<0058> <0059> <005A>]\nendbfrange\n'
    ));
    expect(cmap.lookup(3)).toBe('X');
    expect(cmap.lookup(4)).toBe('Y');
    expect(cmap.lookup(5)).toBe('Z');
  });

  it('decodes multi-codepoint (ligature) bfchar destinations', () => {
    const cmap = parseCMap(enc(
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '1 beginbfchar\n<0001> <00660066>\nendbfchar\n' // "ff"
    ));
    expect(cmap.lookup(1)).toBe('ff');
  });

  // A truncated hex string leaves an unmatched `>` behind. The lexer hands it
  // back as a keyword instead of throwing, so the damage costs the block it
  // lands in rather than the whole CMap — the alternative is a font with no
  // decoder at all, and every glyph it draws extracting as nothing.
  it('keeps the mappings a truncated hex string did not damage', () => {
    const cmap = parseCMap(enc(
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar\n<0041> <0041>\n> \n<0042> <0062>\nendbfchar\n' +
      '1 beginbfchar\n<0043> <0063>\nendbfchar\n'
    ));
    expect(cmap.lookup(0x0041)).toBe('A'); // before the damage
    expect(cmap.lookup(0x0043)).toBe('c'); // a later block, untouched
    // The rest of the damaged block is lost: parseCMap ends a bfchar run at the
    // first operator, and the stray byte arrives as one.
    expect(cmap.lookup(0x0042)).toBeUndefined();
  });
});
