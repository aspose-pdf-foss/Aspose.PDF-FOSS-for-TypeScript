import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildMcPropsPdf } from './helpers/build-mcprops-pdf.js';

function glyphs(bytes: Uint8Array): GlyphEvent[] {
  const doc = Document.Open(bytes);
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => { out.push(e); } });
  return out;
}

describe('GlyphEvent.mcProps', () => {
  it('is ABSENT when no BDC in scope states one', () => {
    // renderMode's rule: a key present on every glyph would move every fixture
    // that compares an event.
    const [g] = glyphs(buildMcPropsPdf([{ text: 'a' }]));
    expect('mcProps' in g).toBe(false);
  });

  it('carries /ActualText, /Alt and /Lang from the enclosing BDC', () => {
    const [g] = glyphs(buildMcPropsPdf([
      { text: 'a', props: { ActualText: 'x', Alt: 'y', Lang: 'en-GB' } },
    ]));
    expect(g.mcProps).toEqual({ actualText: 'x', alt: 'y', lang: 'en-GB' });
  });

  it('INHERITS through nesting, inner winning', () => {
    // containsStringKey reads the inherited attribute, so an outer /Alt covers
    // an inner sequence that states none.
    const out = glyphs(buildMcPropsPdf([
      { text: 'a', props: { Alt: 'outer' }, nested: { props: {}, text: 'b' } },
    ]));
    expect(out).toHaveLength(2);
    expect(out[1].mcProps?.alt).toBe('outer');
  });

  it('lets an INNER value override the outer one', () => {
    const out = glyphs(buildMcPropsPdf([
      { text: 'a', props: { Alt: 'outer' }, nested: { props: { Alt: 'inner' }, text: 'b' } },
    ]));
    expect(out[0].mcProps?.alt).toBe('outer');
    expect(out[1].mcProps?.alt).toBe('inner');
  });

  it('is POPPED at EMC, so a later glyph is uncovered', () => {
    const out = glyphs(buildMcPropsPdf([
      { text: 'a', props: { Alt: 'y' } },
      { text: 'b' },
    ]));
    expect(out[0].mcProps?.alt).toBe('y');
    expect('mcProps' in out[1]).toBe(false);
  });

  it('applies to a BDC with NO /MCID, which fires no marked event', () => {
    // The whole reason this rides on the glyph rather than on
    // MarkedContentEvent, whose q7hc.1 invariant is that it fires only when an
    // /MCID resolves. veraPDF's containsStringKey checks the inherited
    // marked-content attribute BEFORE it looks at the structure element, so
    // this shape genuinely excuses a PUA glyph.
    const [g] = glyphs(buildMcPropsPdf([{ text: 'a', props: { Alt: 'y' }, noMcid: true }]));
    expect(g.mcProps?.alt).toBe('y');
  });
});
