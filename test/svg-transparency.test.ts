import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  constantAlphaPdf, luminositySoftMaskPdf, tilingPatternPdf, blendModePdf,
  isolatedBlendGroupPdf,
} from './helpers/build-transparency-fixtures.js';

describe('Page.ToSvg — ExtGState constant alpha', () => {
  it('emits fill-opacity for ca', () => {
    const svg = Document.Open(constantAlphaPdf()).Pages[0].ToSvg();
    expect(svg).toMatch(/fill-opacity="0\.5"/);
  });
});

// These assert the markup we emit, not that a browser paints it like Acrobat
// would — rasterizing our own SVG would need a runtime dependency the library
// does not take. See the SVG limitation bullet in README.md.
describe('Page.ToSvg — soft masks and tiling patterns', () => {
  it('emits a luminance <mask> and references it', () => {
    const svg = Document.Open(luminositySoftMaskPdf()).Pages[0].ToSvg();
    expect(svg).toMatch(/<mask id="(mask\d+)"[^>]*style="mask-type:luminance"/);
    const id = /<mask id="(mask\d+)"/.exec(svg)?.[1];
    expect(svg).toContain(`mask="url(#${id})"`);
  });

  it('emits a <pattern> on the XStep/YStep lattice', () => {
    const svg = Document.Open(tilingPatternPdf()).Pages[0].ToSvg();
    expect(svg).toMatch(/<pattern id="tile\d+" patternUnits="userSpaceOnUse"/);
    expect(svg).toMatch(/width="20" height="20"/);
    const id = /<pattern id="(tile\d+)"/.exec(svg)?.[1];
    expect(svg).toContain(`fill="url(#${id})"`);
  });

  it('emits mix-blend-mode with the CSS spelling, not the PDF one', () => {
    const svg = Document.Open(blendModePdf('ColorDodge')).Pages[0].ToSvg();
    expect(svg).toContain('mix-blend-mode:color-dodge');
    expect(svg).not.toContain('mix-blend-mode:ColorDodge');
  });

  it('leaves Normal blending unstyled', () => {
    const svg = Document.Open(blendModePdf('Normal')).Pages[0].ToSvg();
    expect(svg).not.toContain('mix-blend-mode');
  });
});

describe('Page.ToSvg — isolated group with an inner blend mode', () => {
  // `isolation` is a CSS property that CSS Compositing never defined as an SVG
  // presentation attribute, so `isolation="isolate"` parses as an unknown
  // attribute and is dropped. Chrome 150 and resvg 2.6.2 both ignore it and
  // both honour `style="isolation:isolate"` — measured, see PROVENANCE.md.
  it('isolates via the style property, not the inert presentation attribute', () => {
    const svg = Document.Open(isolatedBlendGroupPdf(true)).Pages[0].ToSvg();
    expect(svg).toMatch(/style="[^"]*isolation:isolate/);
    expect(svg).not.toMatch(/isolation="isolate"/);
  });

  // Two style properties on one element must share one `style` attribute: a
  // repeated attribute is a well-formedness error in XML, and in HTML parsing
  // the later one is discarded — either way one of the two silently stops
  // applying, and which one is a parser detail we should not depend on.
  it('merges isolation and mix-blend-mode into a single style attribute', () => {
    const svg = Document.Open(isolatedBlendGroupPdf(true)).Pages[0].ToSvg();
    const g = svg.match(/<g [^>]*isolation:isolate[^>]*>/)?.[0] ?? '';
    expect(g).toContain('opacity="1"');
    expect(g.match(/style="/g) ?? []).toHaveLength(1);
    expect(svg).toContain('mix-blend-mode:multiply');
  });
});
