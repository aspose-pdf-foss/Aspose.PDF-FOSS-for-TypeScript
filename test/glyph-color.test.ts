import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

function glyphs(stream: string): GlyphEvent[] {
  const doc = Document.Open(buildSimpleTextPdf(stream));
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => out.push(e) });
  return out;
}

describe('GlyphEvent.color', () => {
  it('omits the colour when no colour operator ran at all', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td (A) Tj ET');
    expect(g).toHaveLength(1);
    expect(g[0].color).toBeUndefined();
  });

  it('omits the colour for an EXPLICIT black fill', () => {
    // Absent, not [0,0,0]: black is the PDF initial fill, so a key here would
    // appear on every glyph of every existing fixture.
    //
    // The explicit operator is the point. With no colour operator the fill is
    // already undefined and the assertion holds whatever the black rule does —
    // measured: replacing `paint` with the identity left that case green. This
    // is the only test in the file that goes red for it.
    const g = glyphs('BT /F1 12 Tf 20 100 Td 0 0 0 rg (A) Tj 0 g (B) Tj ET');
    expect(g[0].color).toBeUndefined();
    expect(g[1].color).toBeUndefined();
  });

  it('carries a DeviceRGB fill set by rg', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td (A) Tj 1 0 0 rg (B) Tj ET');
    expect(g[0].color).toBeUndefined();
    expect(g[1].color).toEqual([255, 0, 0]);
  });

  it('carries a DeviceGray fill set by g', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td 0.5 g (A) Tj ET');
    expect(g[0].color).toEqual([128, 128, 128]);
  });

  it('converts a DeviceCMYK fill set by k', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td 0 1 1 0 k (A) Tj ET');
    expect(g[0].color).toEqual([255, 0, 0]);
  });

  it('resolves a cs/scn fill through the colourspace', () => {
    const g = glyphs('BT /F1 12 Tf 20 100 Td /DeviceRGB cs 0 1 0 scn (A) Tj ET');
    expect(g[0].color).toEqual([0, 255, 0]);
  });

  it('restores the fill colour at Q', () => {
    const g = glyphs(
      'q 0 0 1 rg BT /F1 12 Tf 20 100 Td (A) Tj ET Q'
      + ' BT /F1 12 Tf 20 80 Td (B) Tj ET',
    );
    expect(g[0].color).toEqual([0, 0, 255]);
    // Q pops the fill along with the CTM; without that the second run stays blue.
    expect(g[1].color).toBeUndefined();
  });
});
