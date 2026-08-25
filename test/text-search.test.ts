import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const page = (bytes: Uint8Array) => Document.Open(bytes).Pages[0];
const glyphText = (hits: { text: string }[]) => hits.map((h) => h.text).join('');

describe('Page.Search', () => {
  it('finds a literal substring on one line', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    const matches = p.Search('World');
    expect(matches.length).toBe(1);
    expect(matches[0].text).toBe('World');
    expect(glyphText(matches[0].hits)).toBe('World');
  });

  it('returns one quad covering the match, ordered after an earlier match', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    const [hello] = p.Search('Hello');
    const [world] = p.Search('World');
    expect(hello.quads.length).toBe(1);
    expect(world.quads.length).toBe(1);
    const [hx0, hy0, hx1, hy1] = hello.quads[0];
    expect(hx0).toBeLessThan(hx1);
    expect(hy0).toBeLessThan(hy1);
    // "World" sits to the right of "Hello".
    expect(world.quads[0][0]).toBeGreaterThan(hx1 - 1);
  });

  it('returns all non-overlapping occurrences of a literal', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    expect(p.Search('l').length).toBe(3);
  });

  it('matches across an inferred (non-glyph) space', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td [(Hello)-400(World)] TJ ET'));
    const matches = p.Search('Hello World');
    expect(matches.length).toBe(1);
    expect(matches[0].text).toBe('Hello World');
    // The inferred space has no glyph, so only the real glyphs come back.
    expect(glyphText(matches[0].hits)).toBe('HelloWorld');
    expect(matches[0].quads.length).toBe(1);
  });

  it('supports a global RegExp', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    const matches = p.Search(/[A-Z]/g);
    expect(matches.map((m) => m.text)).toEqual(['H', 'W']);
  });

  it('uses a non-global RegExp globally (all occurrences)', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    expect(p.Search(/o/).length).toBe(2);
  });

  it('spans a line break with one quad per line', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (first) Tj 0 -20 Td (second) Tj ET'));
    const matches = p.Search(/first\nsecond/);
    expect(matches.length).toBe(1);
    expect(matches[0].quads.length).toBe(2);
    expect(glyphText(matches[0].hits)).toBe('firstsecond');
    // Top line above the bottom line.
    expect(matches[0].quads[0][1]).toBeGreaterThan(matches[0].quads[1][1]);
  });

  it('returns [] when nothing matches', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    expect(p.Search('xyz')).toEqual([]);
  });

  it('carries op provenance back to the show operator', () => {
    // ops: BT(0) Tf(1) Td(2) Tj(3) ET(4)
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET'));
    const [m] = p.Search('World');
    for (const h of m.hits) {
      expect(h.addr.streamIndex).toBe(0);
      expect(h.addr.opIndex).toBe(3);
      expect(h.addr.path).toEqual([]);
    }
    // 'W' is the 7th byte (index 6) of "Hello World".
    expect(m.hits[0].byteStart).toBe(6);
  });

  it('does not match a zero-width regex infinitely', () => {
    const p = page(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello) Tj ET'));
    // Empty-match-capable regex must terminate; each anchor yields a match.
    expect(p.Search(/x*/).length).toBeGreaterThan(0);
  });
});
