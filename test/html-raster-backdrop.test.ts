import { describe, it, expect, vi } from 'vitest';
import { Document } from '../src/document.js';
import { renderPageGraphicsToPng } from '../src/raster.js';
import { decodePng } from './helpers/decode-png.js';

/** Flips `renderPageBackdropToPng` into throwing, for the degrade case.
 *
 *  A module mock rather than a spy on `page.ToImage`: since `kf8h.1`, BOTH
 *  backdrop kinds go through `renderPageBackdropToPng` so the form-widget
 *  suppression set can reach a rendered page, and `htmlfixed.ts` holds that as
 *  a direct ESM import binding that `vi.spyOn` cannot replace. */
const raster = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/raster.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/raster.js')>();
  return {
    ...actual,
    renderPageBackdropToPng: (
      ...args: Parameters<typeof actual.renderPageBackdropToPng>
    ): Uint8Array => {
      if (raster.fail) throw new Error('synthetic rasterizer failure');
      return actual.renderPageBackdropToPng(...args);
    },
  };
});

/** A4 height in points — the fixture's page, and the y-flip reference. */
const H = 842;

/** A page with one line of 36pt text and one filled red rect below it. The rect
 *  is the graphics half, the text the half a glyph-less render must drop.
 *
 *  36pt on purpose: the probes below count dark pixels inside a glyph's quad,
 *  and thin text at body size leaves too few to assert on confidently. If a
 *  probe is ever awkward, make the font BIGGER — never loosen the assertion. */
function textAndRect(): Document {
  const doc = Document.New();
  const { page } = doc.AddPage();
  page.AddText('Hello', 50, 700, { fontSize: 36 });
  const g = page.Graphics();
  g.setFillColor([1, 0, 0]).rect(50, 400, 200, 100).fill();
  g.apply();
  return doc;
}

/** Dark pixels inside a PDF-page-space box, in a PNG rendered at scale 1.
 *
 *  Renders at scale 1 so one point is one pixel, and flips y: PDF space is
 *  bottom-up, a raster top-down. `decodePng().at(x, y)` returns [r,g,b,a]. */
function darkPixelsIn(png: Uint8Array, quad: [number, number, number, number]): number {
  const img = decodePng(png);
  const [x0, y0, x1, y1] = quad;
  let n = 0;
  for (let y = Math.round(H - y1); y < Math.round(H - y0); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      if (y < 0 || y >= img.height || x < 0 || x >= img.width) continue;
      const [r, g] = img.at(x, y);
      if (r < 128 && g < 128) n++;
    }
  }
  return n;
}

/** The first text fragment's quad — where the glyphs actually landed, rather
 *  than a coordinate guessed from the AddText call. */
const glyphQuad = (doc: Document) =>
  doc.Pages[0].GetTextFragments()[0].quad as [number, number, number, number];

describe('renderPageGraphicsToPng', () => {
  it('keeps the graphics', () => {
    const doc = textAndRect();
    const img = decodePng(renderPageGraphicsToPng(doc, doc.Pages[0], { scale: 1 }));
    // Inside the red rect: page-space (150, 450) -> device (150, 842-450).
    const [r, g, b] = img.at(150, H - 450);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  it('drops the glyphs', () => {
    // The claim itself, measured at pixels INSIDE the glyphs rather than by
    // comparing the two PNGs — "they differ" would pass if the flag changed
    // anything at all.
    const doc = textAndRect();
    const png = renderPageGraphicsToPng(doc, doc.Pages[0], { scale: 1 });
    expect(darkPixelsIn(png, glyphQuad(doc))).toBe(0);
  });

  it('page.ToImage still draws them', () => {
    // The companion that stops the above passing because the fixture is blank
    // or the quad is off the page.
    const doc = textAndRect();
    const png = doc.Pages[0].ToImage({ scale: 1 });
    expect(darkPixelsIn(png, glyphQuad(doc))).toBeGreaterThan(0);
  });
});

describe("backdrop: 'raster'", () => {
  it('emits an <img> and no <svg>', () => {
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'raster' });
    expect(html).toContain('<img src="data:image/png;base64,');
    expect(html).not.toContain('<svg');
  });

  it('keeps the text spans visible', () => {
    // The whole point of this mode over 'page': the text is real, styled HTML.
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'raster' });
    expect(html).toContain('>Hello<');
    expect(html).not.toContain('class="pg sel"');
  });
});

describe("backdrop: 'page'", () => {
  it('emits an <img> and makes the spans transparent', () => {
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' });
    expect(html).toContain('<img src="data:image/png;base64,');
    expect(html).toContain('class="pg sel"');
    expect(html).toContain('.sel>span{color:transparent}');
  });

  it('still emits the text, because transparent text is what makes it selectable', () => {
    // A mode that dropped the spans would be page.ToImage with extra steps.
    expect(textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' })).toContain('>Hello<');
  });
});

describe('the emitted backdrops differ in what they hold', () => {
  // Two opposite assertions on the SAME pixel box, read out of the actual
  // emitted HTML rather than by calling the renderers again — which is what
  // proves fixedBody routes each mode to the right one.
  it("'raster' bakes no glyphs into its <img>", () => {
    const doc = textAndRect();
    const html = doc.ToHtml({ mode: 'fixed', backdrop: 'raster', backdropScale: 1 });
    expect(darkPixelsIn(pngOf(html), glyphQuad(doc))).toBe(0);
  });

  it("'page' bakes them in", () => {
    const doc = textAndRect();
    const html = doc.ToHtml({ mode: 'fixed', backdrop: 'page', backdropScale: 1 });
    expect(darkPixelsIn(pngOf(html), glyphQuad(doc))).toBeGreaterThan(0);
  });
});

describe('backdropScale', () => {
  it('defaults to 2', () => {
    // Asserted through the emitted PNG's own dimensions rather than by reading
    // the option back, so it measures what shipped. The fixture page is A4:
    // 595 x 842 points.
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' });
    expect(decodePng(pngOf(html)).width).toBe(Math.round(595 * 2));
  });

  it('is honoured when set', () => {
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page', backdropScale: 1 });
    expect(decodePng(pngOf(html)).width).toBe(595);
  });
});

describe('a page that will not rasterize', () => {
  it('falls back to vector rather than emitting a blank page', () => {
    // The failure this rule exists to prevent: dropping only the backdrop, as
    // docxexport.ts does, leaves transparent text over nothing.
    //
    // Driven through the module mock above. This used to spy on
    // `doc.Pages[0].ToImage`, which worked while 'page' called it directly;
    // kf8h.1 routed both backdrops through renderPageBackdropToPng so the
    // form-widget suppression set could reach a rendered page, and the spy then
    // intercepted nothing — the page rasterized fine and this case went red for
    // the right reason.
    raster.fail = true;
    let html: string;
    try {
      html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' });
    } finally {
      raster.fail = false;
    }

    expect(html).toContain('<svg');               // the vector backdrop is back
    expect(html).not.toContain('class="pg sel"'); // and the text is visible
    expect(html).toContain('>Hello<');
  });

  it("falls back to vector for 'raster' too — one rule, both kinds", () => {
    // Now reachable: the mock replaces the single entry both kinds use, which
    // the old per-method spy could not do.
    raster.fail = true;
    let html: string;
    try {
      html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'raster' });
    } finally {
      raster.fail = false;
    }
    expect(html).toContain('<svg');
    expect(html).toContain('>Hello<');
  });

  it('a page that rasterizes fine is unaffected by the fallback path', () => {
    // Guards the above against passing because the fixture never rasterizes.
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' });
    expect(html).toContain('<img');
    expect(html).toContain('class="pg sel"');
  });
});

/** The bytes of the first data:image/png in `html`. */
function pngOf(html: string): Uint8Array {
  const b64 = /<img src="data:image\/png;base64,([^"]+)"/.exec(html)![1];
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
