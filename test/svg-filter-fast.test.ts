import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { classify, resolveFilter, type FilterSpec } from '../src/svgfilter.js';
import { drawSvg } from '../src/svgdraw.js';
import { isDict, type PdfDict, type PdfObject } from '../src/types.js';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const xml = (s: string) => new TextEncoder().encode(s);

/** The element carrying `id`, from a document fragment. */
function nodeOf(src: string, id = 'f'): XmlNode {
  const root = parseXml(xml(src));
  let found: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.attrs.get('id') === id) found ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return found!;
}

const VP = { minX: 0, minY: 0, w: 200, h: 100 };
const BOX = { x: 10, y: 20, w: 40, h: 80 };

/** resolveFilter, asserting it resolved to a runnable spec. */
function spec(src: string, bbox = BOX): FilterSpec {
  const r = resolveFilter(nodeOf(src), bbox, VP);
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}

/** A <filter> wrapping `prims`, pinned to user space so the region is exactly
 *  0,0 200x100 and every subregion assertion below reads directly. */
const filt = (prims: string, attrs = '') =>
  `<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ` +
  `width="200" height="100" ${attrs}>${prims}</filter></svg>`;

describe('classify — offset', () => {
  it('matches a lone feOffset from SourceGraphic', () => {
    const f = classify(spec(filt('<feOffset dx="5" dy="-7"/>')));
    expect(f).toEqual({ kind: 'offset', dx: 5, dy: -7,
                        clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('defaults a missing dx/dy to zero, which is the identity chain', () => {
    expect(classify(spec(filt('<feOffset/>'))))
      .toEqual({ kind: 'offset', dx: 0, dy: 0, clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('refuses an feOffset on SourceAlpha', () => {
    // The alpha channel painted black is not the source graphic, and PDF has
    // no operator that produces it.
    expect(classify(spec(filt('<feOffset in="SourceAlpha" dx="5"/>')))).toBeNull();
  });

  it('refuses a chain of two primitives', () => {
    expect(classify(spec(filt('<feOffset dx="5"/><feOffset dx="0"/>')))).toBeNull();
  });

  it('carries the subregion as the clip, already cut to the filter region', () => {
    const f = classify(spec(filt('<feOffset dx="5" x="20" y="10" width="500" height="30"/>')));
    // width 500 from x=20 runs past the region's right edge at 200, and
    // resolveFilter has already intersected it.
    expect(f).toEqual({ kind: 'offset', dx: 5, dy: 0,
                       clip: { x: 20, y: 10, w: 180, h: 30 } });
  });

  it('scales dx and dy by the right bbox side under primitiveUnits', () => {
    // objectBoundingBox: dx is a fraction of the box WIDTH (40), dy of its
    // HEIGHT (80). A square box could not tell the two apart.
    const f = classify(spec(
      filt('<feOffset dx="0.5" dy="0.5"/>', 'primitiveUnits="objectBoundingBox"')));
    expect(f).toMatchObject({ kind: 'offset', dx: 20, dy: 40 });
  });

  it('matches a one-node feMerge as the identity', () => {
    expect(classify(spec(filt('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>'))))
      .toEqual({ kind: 'offset', dx: 0, dy: 0, clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('matches a one-node feMerge whose node names no input', () => {
    // An feMergeNode is not a primitive and joins no implicit chain, so a
    // missing `in` means SourceGraphic — reading the PRIMITIVE's resolved in1
    // would get this right by accident here and wrong in a longer chain.
    expect(classify(spec(filt('<feMerge><feMergeNode/></feMerge>'))))
      .toMatchObject({ kind: 'offset', dx: 0, dy: 0 });
  });

  it('refuses a two-node feMerge', () => {
    expect(classify(spec(filt(
      '<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="SourceGraphic"/></feMerge>'))))
      .toBeNull();
  });

  it('refuses a one-node feMerge on SourceAlpha', () => {
    expect(classify(spec(filt('<feMerge><feMergeNode in="SourceAlpha"/></feMerge>'))))
      .toBeNull();
  });
});

/** A stream sink that records what it was asked to allocate and hands back a
 *  ref, standing in for svgembed.ts. */
function recordingSink() {
  const streams: { dict: PdfDict; content: string }[] = [];
  return {
    streams,
    sink: {
      stream: (dict: PdfDict, content: string): PdfObject => {
        streams.push({ dict, content });
        return { kind: 'ref' as const, num: streams.length, gen: 0 };
      },
    },
    images: { image: (): PdfObject => ({ kind: 'ref' as const, num: 999, gen: 0 }) },
  };
}

/** A font provider with no faces — none of these fixtures draw text. */
const noFonts = {
  dict: () => new Map<string, PdfObject>(),
  face: () => { throw new Error('no font expected'); },
};

function draw(src: string) {
  const rec = recordingSink();
  const r = drawSvg(parseXml(xml(src)), { minX: 0, minY: 0, w: 100, h: 100 },
    noFonts as never, rec.sink, rec.images as never);
  return { ...r, streams: rec.streams };
}

/** A red square filtered by `prims`, over a 100x100 user-space region. */
const doc = (prims: string) =>
  '<svg viewBox="0 0 100 100"><defs>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">' +
  prims + '</filter></defs>' +
  '<rect x="0" y="0" width="40" height="40" fill="#ff0000" filter="url(#f)"/></svg>';

describe('drawSvg — offset fast path', () => {
  it('emits the subtree through a form and a translate, not an image', () => {
    const { content, rasterized, skipped } = draw(doc('<feOffset dx="30" dy="20"/>'));
    expect(content).toContain('1 0 0 1 30 20 cm');
    expect(content).toMatch(/\/Fm\d+ Do/);
    // No rasterizer was involved, so nothing was flattened and nothing lost.
    expect(rasterized).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('clips the source to the filter region inside the form, before the shift', () => {
    // The form BBox is the region, and it applies in the form's OWN space. If
    // the region clip were applied after the translate instead, ink the region
    // had already removed could be dragged back in.
    const { streams } = draw(doc('<feOffset dx="30" dy="20"/>'));
    const form = streams.find((s) => {
      const b = s.dict.get('BBox');
      return Array.isArray(b) && b[2] === 100 && b[3] === 100;
    });
    expect(form).toBeDefined();
    // The source rect is in there (svgdraw emits a <rect> as m/l subpaths, not
    // as `re`, so match on its fill colour), and the shift is NOT.
    expect(form!.content).toContain('1 0 0 rg');
    expect(form!.content).not.toContain('1 0 0 1 30 20 cm');
  });

  it('clips the result to a narrow subregion', () => {
    const { content } = draw(doc('<feOffset dx="30" dy="20" x="10" y="5" width="20" height="15"/>'));
    expect(content).toContain('10 5 20 15 re');
    expect(content).toContain('W n');
  });

  it('omits the translate for an identity chain', () => {
    const { content } = draw(doc('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>'));
    expect(content).toMatch(/\/Fm\d+ Do/);
    expect(content).not.toContain(' cm');
  });

  it('still rasterizes a chain that does not classify', () => {
    // No raster sink is wired here, so the raster path cannot run and degrades
    // to unfiltered — which is the pre-existing behaviour this must not change.
    const { rasterized, skipped } = draw(doc('<feGaussianBlur stdDeviation="2"/>'));
    expect(rasterized).toEqual([]);
    expect(skipped).toEqual(['filter']);
  });
});

describe('classify — flood', () => {
  it('matches a lone feFlood', () => {
    expect(classify(spec(filt('<feFlood flood-color="#ff0000"/>'))))
      .toEqual({ kind: 'flood', color: [1, 0, 0], opacity: 1,
                 clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('defaults flood-color to black and flood-opacity to 1', () => {
    expect(classify(spec(filt('<feFlood/>'))))
      .toMatchObject({ kind: 'flood', color: [0, 0, 0], opacity: 1 });
  });

  it('carries flood-opacity, clamped', () => {
    expect(classify(spec(filt('<feFlood flood-opacity="0.25"/>'))))
      .toMatchObject({ opacity: 0.25 });
    expect(classify(spec(filt('<feFlood flood-opacity="3"/>'))))
      .toMatchObject({ opacity: 1 });
  });

  it('clips to the subregion', () => {
    expect(classify(spec(filt('<feFlood x="10" y="20" width="30" height="40"/>'))))
      .toMatchObject({ clip: { x: 10, y: 20, w: 30, h: 40 } });
  });

  it('rasterizes a flood that paints nothing', () => {
    // flood-color="none" and an unparseable value both flood nothing. Rather
    // than grow a fourth emission that draws nothing, hand these to the raster
    // path, which already produces the same empty result. Divergence here is
    // exactly the kind nobody writes a test for.
    expect(classify(spec(filt('<feFlood flood-color="none"/>')))).toBeNull();
    expect(classify(spec(filt('<feFlood flood-color="url(#g)"/>')))).toBeNull();
  });
});

describe('drawSvg — flood fast path', () => {
  it('emits a solid fill over the subregion, with no form and no image', () => {
    const { content, rasterized } = draw(doc('<feFlood flood-color="#0000ff"/>'));
    expect(content).toContain('0 0 1 rg');
    expect(content).toContain('0 0 100 100 re');
    expect(content).not.toMatch(/\/Fm\d+ Do/);
    expect(rasterized).toEqual([]);
  });

  it('folds flood-opacity into the constant alpha', () => {
    const { content, resources } = draw(doc('<feFlood flood-color="#0000ff" flood-opacity="0.5"/>'));
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const extg = resources.get('ExtGState');
    if (!isDict(extg)) throw new Error('no /ExtGState');
    const gs = extg.get(gsName);
    if (!isDict(gs)) throw new Error(`no /${gsName}`);
    expect(gs.get('ca')).toBe(0.5);
  });

  it('emits no /ExtGState for an opaque flood', () => {
    const { content } = draw(doc('<feFlood flood-color="#0000ff"/>'));
    expect(content).not.toContain(' gs');
  });
});

/** The icon-recolour recipe, over the standard 200x100 region. */
const TINT = '<feFlood flood-color="#00ff00"/><feComposite in2="SourceAlpha" operator="in"/>';

describe('classify — tint', () => {
  it('matches feFlood then feComposite operator="in" on SourceAlpha', () => {
    expect(classify(spec(filt(TINT))))
      .toEqual({ kind: 'tint', color: [0, 1, 0], opacity: 1,
                 clip: { x: 0, y: 0, w: 200, h: 100 } });
  });

  it('matches the SourceGraphic spelling too', () => {
    // operator="in" reads in2's ALPHA and nothing else, so SourceGraphic and
    // SourceAlpha are the same input here.
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00"/><feComposite in2="SourceGraphic" operator="in"/>'))))
      .toMatchObject({ kind: 'tint', color: [0, 1, 0] });
  });

  it('matches when the composite names its first input explicitly', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" result="c"/>' +
      '<feComposite in="c" in2="SourceAlpha" operator="in"/>'))))
      .toMatchObject({ kind: 'tint' });
  });

  it('refuses a different operator', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00"/><feComposite in2="SourceAlpha" operator="over"/>'))))
      .toBeNull();
    // operator is required: its default is "over", which is not this recipe.
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00"/><feComposite in2="SourceAlpha"/>')))).toBeNull();
  });

  it('refuses the inputs the other way round', () => {
    // flood as in2 gives the source's alpha coloured black, masked by the
    // flood's alpha -- a different picture entirely.
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" result="c"/>' +
      '<feComposite in="SourceAlpha" in2="c" operator="in"/>')))).toBeNull();
  });

  it('intersects the flood and composite subregions', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" x="0" y="0" width="60" height="60"/>' +
      '<feComposite in2="SourceAlpha" operator="in" x="40" y="10" width="100" height="20"/>'))))
      .toMatchObject({ clip: { x: 40, y: 10, w: 20, h: 20 } });
  });

  it('carries flood-opacity', () => {
    expect(classify(spec(filt(
      '<feFlood flood-color="#00ff00" flood-opacity="0.4"/>' +
      '<feComposite in2="SourceAlpha" operator="in"/>'))))
      .toMatchObject({ kind: 'tint', opacity: 0.4 });
  });
});

describe('drawSvg — tint fast path', () => {
  const TINT_DOC = doc(TINT);

  it('emits a solid fill behind an ALPHA soft mask', () => {
    const { content, resources, rasterized } = draw(TINT_DOC);
    expect(content).toContain('0 1 0 rg');
    expect(rasterized).toEqual([]);
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const extg = resources.get('ExtGState');
    if (!isDict(extg)) throw new Error('no /ExtGState');
    const gs = extg.get(gsName);
    if (!isDict(gs)) throw new Error(`no /${gsName}`);
    const smask = gs.get('SMask');
    if (!isDict(smask)) throw new Error('no /SMask');
    const s = smask.get('S');
    // Alpha, NOT Luminosity: feComposite operator="in" reads in2's alpha and
    // nothing else. A luminosity mask of dark artwork is ~0, so the tint would
    // silently vanish on exactly the icons this recipe is used for.
    expect(s).toEqual({ kind: 'name', name: 'Alpha' });
    expect(smask.get('G')).toBeDefined();
  });

  it('puts the source subtree in the mask group, not on the page', () => {
    const { streams } = draw(TINT_DOC);
    const form = streams.find((s) => {
      const b = s.dict.get('BBox');
      return Array.isArray(b) && b[2] === 100 && b[3] === 100;
    });
    expect(form).toBeDefined();
    expect(form!.content).toContain('1 0 0 rg');    // the red source rect
  });

  it('folds flood-opacity into the constant alpha alongside the mask', () => {
    const { content, resources } = draw(doc(
      '<feFlood flood-color="#00ff00" flood-opacity="0.4"/>' +
      '<feComposite in2="SourceAlpha" operator="in"/>'));
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const extg = resources.get('ExtGState');
    if (!isDict(extg)) throw new Error('no /ExtGState');
    const gs = extg.get(gsName);
    if (!isDict(gs)) throw new Error(`no /${gsName}`);
    expect(gs.get('ca')).toBe(0.4);
    expect(isDict(gs.get('SMask'))).toBe(true);
  });
});

/** Place `src` over a 200x200 page at 1 px per point and rasterize it. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(xml(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), result: r };
}

/** The same chain, padded so it can no longer classify. An feOffset of (0, 0)
 *  is an exact identity -- offsetKernel rounds its delta to whole pixels -- so
 *  the two documents are the same picture by spec, and differ only in which
 *  code path drew them. This is what keeps the fast paths honest without a
 *  test-only opt-out flag that no caller would ever exercise. */
const padded = (prims: string) => prims + '<feOffset dx="0" dy="0"/>';

/** Mean absolute RGB difference per channel, 0..255. */
function meanDiff(a: DecodedPng, b: DecodedPng): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let sum = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const p = a.at(x, y), q = b.at(x, y);
      for (let c = 0; c < 3; c++) sum += Math.abs(p[c] - q[c]);
    }
  return sum / (a.width * a.height * 3);
}

/** A 60x60 red square at (20, 20), filtered by `prims`, over a user-space
 *  region covering the whole 200x200 viewBox. */
const page = (prims: string) =>
  '<svg viewBox="0 0 200 200"><defs>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
  prims + '</filter></defs>' +
  '<rect x="20" y="20" width="60" height="60" fill="#ff0000" filter="url(#f)"/></svg>';

/** Assert the fast path and the raster path draw the same picture, and that
 *  each actually took the path it was supposed to. */
function agree(prims: string, tolerance: number, build = page): void {
  const fast = render(build(prims));
  const slow = render(build(padded(prims)));
  expect(fast.result.rasterized).toEqual([]);
  expect(slow.result.rasterized).toEqual(['filter']);
  expect(fast.result.skipped).toEqual([]);
  expect(slow.result.skipped).toEqual([]);
  expect(meanDiff(fast.png, slow.png)).toBeLessThan(tolerance);
}

describe('fast path vs raster path — same picture', () => {
  it('agrees on a lone feOffset', () => {
    agree('<feOffset dx="50" dy="30"/>', 4);
  });

  it('agrees on the identity feMerge', () => {
    agree('<feMerge><feMergeNode in="SourceGraphic"/></feMerge>', 4);
  });

  it('agrees on an feOffset that shifts ink INTO a narrow subregion', () => {
    // The one fixture that separates "clip the source to the REGION, then
    // shift, then clip to the SUBREGION" from clipping to the subregion twice.
    // The square lives at x = 20..80, outside this subregion but inside the
    // region; dx = 100 lands it at 120..180, inside. Clip to the subregion
    // first and there is nothing left to shift, so the picture goes blank.
    // Found by mutation: with subregion == region, as in every other fixture
    // here, the two orders are indistinguishable.
    agree('<feOffset dx="100" x="100" y="0" width="100" height="200"/>', 4);
  });

  it('agrees on a lone feFlood', () => {
    agree('<feFlood flood-color="#0000ff" flood-opacity="0.4" ' +
          'x="30" y="40" width="90" height="70"/>', 4);
  });

  it('agrees on the tint recipe', () => {
    agree('<feFlood flood-color="#00aa44"/>' +
          '<feComposite in2="SourceAlpha" operator="in"/>', 4);
  });

  it('agrees on the tint recipe over a shape with soft edges', () => {
    // A circle's antialiased rim is where an alpha mask and a resampled raster
    // are most likely to part company; a rectangle's axis-aligned edges hide it.
    agree('<feFlood flood-color="#00aa44"/>' +
          '<feComposite in2="SourceAlpha" operator="in"/>', 5,
      (prims) =>
        '<svg viewBox="0 0 200 200"><defs>' +
        '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
        prims + '</filter></defs>' +
        '<circle cx="100" cy="100" r="60" fill="#ff0000" filter="url(#f)"/></svg>');
  });
});

describe('fast path — spot checks in flat interiors', () => {
  it('moves the square by the offset and leaves the source position empty', () => {
    const { png } = render(page('<feOffset dx="50" dy="30"/>'));
    const [r, g, b] = png.at(100, 80);       // 20+50+30, 20+30+30: inside the shifted square
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(80);
    expect(png.at(40, 40)[1]).toBeGreaterThan(240);   // where it was: white page
  });

  it('paints the tint colour, not the source colour, inside the shape', () => {
    const { png } = render(page(
      '<feFlood flood-color="#00aa44"/><feComposite in2="SourceAlpha" operator="in"/>'));
    const [r, g, b] = png.at(50, 50);
    expect(r).toBeLessThan(80);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeLessThan(120);
    expect(png.at(150, 150)[0]).toBeGreaterThan(240); // outside the shape: untinted white
  });
});
