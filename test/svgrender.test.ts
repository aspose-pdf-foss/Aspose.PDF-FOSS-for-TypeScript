import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf, VECTOR_CONTENT, TEXT_CONTENT, HELV_RESOURCES, flateImagePdf, jpegImagePdf, CLIP_CONTENT, axialShadingPdf, shadingPatternPdf, patternTextPdf, formXObjectPdf } from './helpers/build-svg-fixtures.js';
import { strokePatternPdf, tilingPatternOffsetClipPdf } from './helpers/build-transparency-fixtures.js';

describe('Page.ToSvg — geometry', () => {
  it('returns a standalone <svg> sized to the CropBox', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], content: '' }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/width="300"/);
    expect(svg).toMatch(/height="400"/);
    expect(svg).toMatch(/viewBox="0 0 300 400"/);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
  });

  it('swaps width/height for /Rotate 90', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 400], rotate: 90, content: '' }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/width="400"/);
    expect(svg).toMatch(/height="300"/);
  });

  it('honors a non-zero-origin CropBox', () => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 300, 400], cropBox: [50, 60, 250, 360], content: '',
    }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/width="200"/);
    expect(svg).toMatch(/height="300"/);
  });
});

describe('Page.ToSvg — paths', () => {
  it('emits filled and stroked paths with fill-rule, color, dash', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: VECTOR_CONTENT }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<path[^>]*fill-rule="evenodd"/);
    expect(svg).toMatch(/<path[^>]*fill="#ff0000"/);
    expect(svg).toMatch(/<path[^>]*stroke="#0000ff"/);
    expect(svg).toMatch(/<path[^>]*stroke-width="4"/);
    expect(svg).toMatch(/<path[^>]*stroke-dasharray="6 3"/);
    // the fill path must not also carry a stroke
    expect(svg).toMatch(/<path[^>]*fill="#ff0000"[^>]*stroke="none"/);
  });
});

describe('Page.ToSvg — text', () => {
  it('emits positioned <text> with font-size, family, and fill', () => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200], resources: HELV_RESOURCES, content: TEXT_CONTENT,
    }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<text[^>]*font-size="24"/);
    expect(svg).toMatch(/<text[^>]*>Hi<\/text>/);
    expect(svg).toMatch(/font-family="sans-serif"/);
    expect(svg).toMatch(/font-weight="bold"/);
    // baseline at pixel y = 200 - 100 = 100 (identity page): transform ends with 72 100
    expect(svg).toMatch(/<text[^>]*transform="matrix\(1 0 0 1 72 100\)"/);
  });

  it('decodes an embedded simple font with /Differences', () => {
    const res = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Custom '
      + '/Encoding << /Type /Encoding /Differences [65 /A /B] >> /FirstChar 65 /LastChar 66 '
      + '/Widths [500 500] >> >> >>';
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 200, 200], resources: res, content: 'BT /F1 12 Tf 10 10 Td (AB) Tj ET',
    }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<text[^>]*>AB<\/text>/);
  });
});

describe('Page.ToSvg — images', () => {
  it('embeds a DCTDecode image as a JPEG data URI', () => {
    const doc = Document.Open(jpegImagePdf());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<image[^>]*href="data:image\/jpeg;base64,/);
    expect(svg).toMatch(/<image[^>]*transform="matrix\(/);
  });

  it('re-encodes a Flate image as a PNG data URI', () => {
    const doc = Document.Open(flateImagePdf());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<image[^>]*href="data:image\/png;base64,/);
  });
});

describe('Page.ToSvg — clipping', () => {
  it('clips leaves by attribute instead of wrapping them in a group', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: CLIP_CONTENT }));
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<defs>.*<clipPath id="clip\d+">.*<\/clipPath>.*<\/defs>/s);
    // clip-path establishes a stacking context, so a clip wrapper would isolate
    // a non-isolated group's inner blend from the page (7wg). Leaves only.
    expect(svg).not.toMatch(/<g[^>]*clip-path=/);
    expect(svg).toMatch(/<path[^>]*clip-path="url\(#clip\d+\)"/);
    const opens = (svg.match(/<g /g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  // SVG intersects a <clipPath> with its own clip-path, which is what lets
  // nested clips compose without a wrapper element.
  it('chains nested clipPaths, and leaves carry the innermost id', () => {
    const content = 'q 0 0 100 100 re W n q 0 0 50 50 re W n 1 0 0 rg 0 0 200 200 re f Q Q';
    const svg = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content })).Pages[0].ToSvg();
    const defs = [...svg.matchAll(/<clipPath id="(clip\d+)"([^>]*)>/g)];
    expect(defs).toHaveLength(2);
    const [outer, inner] = defs;
    expect(outer[2]).not.toContain('clip-path');                     // nothing encloses it
    expect(inner[2]).toContain(`clip-path="url(#${outer[1]})"`);     // intersects the outer
    expect(svg).toMatch(new RegExp(`<path[^>]*clip-path="url\\(#${inner[1]}\\)"`));
  });

  // aspose-…-cul: clip-path resolves in the referencing leaf's user space, so a
  // leaf that carried transform=CTM would re-apply it to the device-space clip
  // geometry and mirror the clip. Fills/strokes therefore bake the CTM into `d`
  // and carry no transform — their user space is the identity, and the clip
  // lands where it should. Verified cross-engine by the nested-clip golden.
  it('bakes the CTM into leaf geometry so a device-space clip resolves correctly', () => {
    // Clip to user y[0,60] (the BOTTOM band); fill the whole page red.
    const content = 'q 0 0 100 60 re W n 1 0 0 rg 0 0 100 100 re f Q';
    const svg = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 100, 100], content })).Pages[0].ToSvg();
    const fill = (svg.match(/<path[^>]*fill="#ff0000"[^>]*\/>/) ?? [''])[0];
    expect(fill).toContain('clip-path="url(#clip0)"');
    expect(fill).not.toContain('transform=');                 // identity user space
    expect(fill).toContain('d="M0 100L100 100L100 0L0 0Z"');  // page flip baked in
  });

  // Image and glyph runs cannot bake into path `d`, so they keep their own
  // transform; the clip then rides on an identity <g> wrapper, not on the
  // element, so the element's transform does not re-apply to the clip.
  it('wraps a clipped glyph run in a group so its transform does not re-apply to the clip', () => {
    const content = 'q 0 0 100 100 re W n BT /F1 24 Tf 20 20 Td (Hi) Tj ET Q';
    const svg = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 100, 100], resources: HELV_RESOURCES, content,
    })).Pages[0].ToSvg();
    expect(svg).toMatch(/<g clip-path="url\(#clip\d+\)"><text[^>]*transform=/);
  });

  it('drops the clip at Q, leaving later content unclipped', () => {
    const content = 'q 0 0 50 50 re W n 1 0 0 rg 0 0 200 200 re f Q 0 0 1 rg 0 0 200 200 re f';
    const svg = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content })).Pages[0].ToSvg();
    const paths = (svg.match(/<path[^>]*\/>/g) ?? []);
    const red = paths.find((p) => p.includes('#ff0000')) ?? '';
    const blue = paths.find((p) => p.includes('#0000ff')) ?? '';
    expect(red).toContain('clip-path=');
    expect(blue).not.toContain('clip-path=');
  });

  // A captured definition is built once and used elsewhere: the active clip
  // applies where it is *used*. A tiling cell in particular lives outside the
  // region it fills, so baking the clip into the cell would erase it.
  it('does not bake the active clip into a tiling pattern cell', () => {
    const svg = Document.Open(tilingPatternOffsetClipPdf()).Pages[0].ToSvg();
    const cell = svg.match(/<pattern[^>]*>(.*?)<\/pattern>/s)?.[1] ?? '';
    expect(cell).not.toContain('clip-path=');
    expect(svg).toMatch(/<rect[^>]*fill="url\(#tile\d+\)"[^>]*clip-path="url\(#clip\d+\)"/);
  });

  // Per SVG 1.1 §14.3.5 the `stroke` property does not contribute to a clipping
  // path — only the child's fill geometry counts. So a stroke-shaped clip must
  // be emitted as an outlined (filled) region, not as a stroked zero-area line,
  // or a real SVG engine clips everything away and the paint vanishes.
  describe('stroke-shaped clips (SCN stroke pattern)', () => {
    const svg = Document.Open(strokePatternPdf()).Pages[0].ToSvg();
    const clip = svg.match(/<clipPath id="sclip\d+">(.*?)<\/clipPath>/s)?.[1] ?? '';

    it('emits the clip as filled geometry, not as a stroke', () => {
      expect(clip).not.toMatch(/stroke-width=/);
      expect(clip).not.toMatch(/fill="none"/);
    });

    // The fixture strokes a 20-wide line at user y=50 across a 100×100 page, so
    // the outline is the device band y 40..60. Assert the region itself, not the
    // markup: these are the same two probes raster-transparency.test.ts uses.
    it('covers the stroke band and nothing above it', () => {
      const polys = clipPolygons(clip);
      expect(polys.length).toBeGreaterThan(0);
      expect(insidePolys(polys, 50, 50)).toBe(true);   // inside the band
      expect(insidePolys(polys, 50, 10)).toBe(false);  // above the band
    });
  });
});

/** Parse the M/L/Z subpaths of a clipPath child into flat [x,y,...] polygons.
 *  The stroke outliner emits only lines, so no curve handling is needed. */
function clipPolygons(clip: string): number[][] {
  const d = clip.match(/\bd="([^"]*)"/)?.[1] ?? '';
  return d.split(/(?=M)/).filter(Boolean)
    .map((sub) => (sub.match(/-?[\d.]+/g) ?? []).map(Number))
    .filter((p) => p.length >= 6);
}

/** Nonzero-winding containment — the rule the outline's unioned contours use. */
function insidePolys(polys: number[][], x: number, y: number): boolean {
  let w = 0;
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      const x0 = p[i], y0 = p[i + 1];
      const x1 = p[(i + 2) % p.length], y1 = p[(i + 3) % p.length];
      const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
      if (y0 <= y && y1 > y && side > 0) w++;
      else if (y0 > y && y1 <= y && side < 0) w--;
    }
  }
  return w !== 0;
}

describe('Page.ToSvg — shadings', () => {
  it('emits a linearGradient for an axial shading', () => {
    const doc = Document.Open(axialShadingPdf());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<linearGradient id="grad\d+"/);
    expect(svg).toMatch(/<stop /);
    expect(svg).toMatch(/fill="url\(#grad\d+\)"/);
  });

  it('renders a shading-pattern fill (scn) as a gradient clipped to the path', () => {
    const doc = Document.Open(shadingPatternPdf());
    const svg = doc.Pages[0].ToSvg();
    // The fill path becomes a clip group; the shading gradient paints inside it.
    expect(svg).toMatch(/<clipPath id="clip\d+">/);
    expect(svg).toMatch(/<linearGradient id="grad\d+"/);
    // The gradient paints through a viewport rect carrying the clip, not a wrapper.
    expect(svg).toMatch(/<rect[^>]*fill="url\(#grad\d+\)"[^>]*clip-path="url\(#clip\d+\)"/);
    // groups stay balanced
    const opens = (svg.match(/<g /g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('renders a shading-pattern fill on TEXT as a gradient clipped to the glyphs', () => {
    const doc = Document.Open(patternTextPdf());
    const svg = doc.Pages[0].ToSvg();
    // SVG 1.1 §14.3.5 admits <text> as clipPath content, so the glyphs become
    // the clip and the gradient paints through them.
    expect(svg).toMatch(/<clipPath id="tclip\d+"><text[^>]*>HHH<\/text><\/clipPath>/);
    expect(svg).toMatch(/<linearGradient id="grad\d+"/);
    expect(svg).toMatch(/<rect[^>]*fill="url\(#grad\d+\)"[^>]*clip-path="url\(#tclip\d+\)"/);
    // The placeholder colour scn stores must not reach the output as a paint.
    expect(svg).not.toMatch(/<text[^>]*fill="#808080"/);
    const opens = (svg.match(/<g /g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe('Page.ToSvg — form xobjects', () => {
  it('recurses into a Form XObject and applies its Matrix', () => {
    const doc = Document.Open(formXObjectPdf());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toMatch(/<path[^>]*fill="#00ff00"/);      // the form's green rect
    // The /BBox clip rides on the leaf, not on a wrapper: a wrapper would
    // establish a stacking context and isolate the form's contents (7wg).
    expect(svg).toMatch(/<clipPath id="clip\d+">/);
    expect(svg).toMatch(/<path[^>]*fill="#00ff00"[^>]*clip-path="url\(#clip\d+\)"/);
    // groups stay balanced
    const opens = (svg.match(/<g /g) ?? []).length;
    const closes = (svg.match(/<\/g>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
