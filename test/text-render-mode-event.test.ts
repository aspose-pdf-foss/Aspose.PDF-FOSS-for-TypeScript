import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildRenderModePdf } from './helpers/build-render-mode-pdf.js';

/** Every glyph event of page 0, in order. */
function glyphs(bytes: Uint8Array): GlyphEvent[] {
  const doc = Document.Open(bytes);
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => { out.push(e); } });
  return out;
}

describe('GlyphEvent.renderMode', () => {
  it('is ABSENT for mode 0, the PDF initial value', () => {
    // GlyphEvent.color's precedent: a key present on every glyph would move
    // every fixture that compares an event. Asserted with `in` rather than a
    // value comparison, since `undefined` and absent differ to toEqual.
    const [g] = glyphs(buildRenderModePdf([{ text: 'a' }]));
    expect('renderMode' in g).toBe(false);
  });

  it('is present for every other mode', () => {
    for (const mode of [1, 2, 3, 7]) {
      const [g] = glyphs(buildRenderModePdf([{ text: 'a', mode }]));
      expect(g.renderMode, `mode ${mode}`).toBe(mode);
    }
  });

  it('is RESTORED by Q', () => {
    // Scoped before its siblings were (q7hc.4.3; the rest followed in g5x6,
    // see text-state-q.test.ts). An OCR tool that wraps its invisible layer in q...Q would otherwise leave
    // the mode stuck at 3 and silently EXEMPT the visible text after it — a
    // false negative on exactly the population mode 3 exists to excuse.
    const out = glyphs(buildRenderModePdf([
      { text: 'a', mode: 3, wrapInQ: true },
      { text: 'b' },
    ]));
    expect(out).toHaveLength(2);
    expect(out[0].renderMode).toBe(3);
    expect('renderMode' in out[1]).toBe(false);
  });

  it('persists WITHOUT a q/Q, since Tr is not reset by BT', () => {
    const out = glyphs(buildRenderModePdf([
      { text: 'a', mode: 3 },
      { text: 'b' },
    ]));
    expect(out[0].renderMode).toBe(3);
    expect(out[1].renderMode).toBe(3);
  });
});
