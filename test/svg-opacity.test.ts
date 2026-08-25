import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { drawSvg } from '../src/svgdraw.js';
import { ref, isDict, isName, type PdfDict } from '../src/types.js';
import { fakeProvider } from './helpers/fake-svg-font.js';
import { resolveStyle, INITIAL } from '../src/svgstyle.js';

const VP = { minX: 0, minY: 0, w: 100, h: 100 };
const noStreams = () => { let n = 0; return { stream: () => ref(++n) }; };
const noImages = () => { let n = 100; return { image: () => ref(++n) }; };

const draw = (svg: string) =>
  drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(),
    noStreams(), noImages());

/** Every `ca` value the drawing registered, so a test can assert the set of
 *  constant alphas without depending on resource-key numbering. */
function alphas(svg: string): number[] {
  const eg = draw(svg).resources.get('ExtGState');
  if (!isDict(eg)) return [];
  const out: number[] = [];
  for (const v of eg.values()) {
    if (!isDict(v)) continue;
    const ca = (v as PdfDict).get('ca');
    if (typeof ca === 'number') out.push(ca);
  }
  return out.sort((a, b) => a - b);
}

describe('<text> resolves its own style exactly once', () => {
  it('does not square fill-opacity on the text element', () => {
    expect(alphas('<svg><text x="0" y="10" fill-opacity="0.5">Hi</text></svg>'))
      .toEqual([0.5]);
  });

  it('does not square opacity on the text element', () => {
    expect(alphas('<svg><text x="0" y="10" opacity="0.5">Hi</text></svg>'))
      .toEqual([0.5]);
  });

  it('combines opacity and fill-opacity once each', () => {
    // 0.25 effective, but no longer as a single folded alpha: `opacity` is a
    // transparency group at ca 0.5 and `fill-opacity` stays on the glyphs at
    // ca 0.5. gsKey shares one ExtGState between the two equal values, so the
    // resource set is a single 0.5 — the squaring this guards against would
    // show up as a 0.0625 entry.
    const svg = '<svg><text x="0" y="10" opacity="0.5" fill-opacity="0.5">Hi</text></svg>';
    expect(alphas(svg)).toEqual([0.5]);
    expect(formCount(svg)).toBe(1);
  });

  it('still applies an ancestor group opacity to text', () => {
    expect(alphas('<svg><g opacity="0.5"><text x="0" y="10">Hi</text></g></svg>'))
      .toEqual([0.5]);
  });

  it('still applies opacity on a tspan', () => {
    expect(alphas(
      '<svg><text x="0" y="10"><tspan opacity="0.5">Hi</tspan></text></svg>'))
      .toEqual([0.5]);
  });
});

describe('resolveStyle — group opacity is returned, not folded', () => {
  const of = (attrs: Record<string, string>) =>
    resolveStyle(INITIAL, new Map(Object.entries(attrs)));

  it('returns opacity separately and leaves the paint alphas alone', () => {
    const r = of({ opacity: '0.5' });
    expect(r.groupOpacity).toBe(0.5);
    expect(r.paint.fillOpacity).toBe(1);
    expect(r.paint.strokeOpacity).toBe(1);
  });

  it('defaults groupOpacity to 1 and clamps out of range', () => {
    expect(of({}).groupOpacity).toBe(1);
    expect(of({ opacity: '-2' }).groupOpacity).toBe(0);
    expect(of({ opacity: '7' }).groupOpacity).toBe(1);
  });

  it('still folds fill-opacity and stroke-opacity into the paint', () => {
    const r = of({ 'fill-opacity': '0.5', 'stroke-opacity': '0.25' });
    expect(r.paint.fillOpacity).toBe(0.5);
    expect(r.paint.strokeOpacity).toBe(0.25);
    expect(r.groupOpacity).toBe(1);
  });

  it('does not inherit opacity to a child', () => {
    const parent = of({ opacity: '0.5' });
    expect(resolveStyle(parent.paint, new Map()).groupOpacity).toBe(1);
  });
});

/** How many Form XObjects the drawing registered in this stream's resources. */
function formCount(svg: string): number {
  const xo = draw(svg).resources.get('XObject');
  if (!isDict(xo)) return 0;
  return [...xo.keys()].filter((k) => k.startsWith('Fm')).length;
}

/** Every stream dict the drawing allocated, so a test can inspect the form
 *  dictionaries themselves — they are not reachable through /Resources. */
function streamDicts(svg: string): PdfDict[] {
  const dicts: PdfDict[] = [];
  drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(),
    { stream: (d: PdfDict) => { dicts.push(d); return ref(dicts.length); } },
    noImages());
  return dicts;
}

/** Just the transparency-group forms among them, at any nesting depth. */
function transparencyGroups(svg: string): PdfDict[] {
  return streamDicts(svg).filter((d) => {
    const g = d.get('Group');
    if (!isDict(g)) return false;
    const s = g.get('S');
    return isName(s) && s.name === 'Transparency';
  });
}

describe('group opacity — when a transparency group is emitted', () => {
  it('wraps a <g> and applies the alpha once, not per child', () => {
    const svg = '<svg><g opacity="0.5">' +
      '<rect width="10" height="10" fill="red"/>' +
      '<rect x="5" width="10" height="10" fill="blue"/></g></svg>';
    expect(formCount(svg)).toBe(1);
    expect(alphas(svg)).toEqual([0.5]);
  });

  it('folds for a fill-only shape rather than allocating a form', () => {
    const svg = '<svg><rect width="10" height="10" fill="red" opacity="0.5"/></svg>';
    expect(formCount(svg)).toBe(0);
    expect(alphas(svg)).toEqual([0.5]);
  });

  it('folds for a stroke-only shape', () => {
    const svg = '<svg><rect width="10" height="10" fill="none" stroke="red" ' +
      'opacity="0.5"/></svg>';
    expect(formCount(svg)).toBe(0);
  });

  it('groups a shape that both fills and strokes', () => {
    const svg = '<svg><rect width="10" height="10" fill="red" stroke="blue" ' +
      'opacity="0.5"/></svg>';
    expect(formCount(svg)).toBe(1);
  });

  it('groups a shape carrying markers', () => {
    const svg = '<svg><defs><marker id="m" markerWidth="4" markerHeight="4">' +
      '<rect width="4" height="4" fill="red"/></marker></defs>' +
      '<path d="M0 0 L10 10" stroke="black" marker-end="url(#m)" opacity="0.5"/></svg>';
    expect(formCount(svg)).toBeGreaterThanOrEqual(1);
  });

  it('groups a <text>, whose glyphs can overlap each other', () => {
    expect(formCount('<svg><text x="0" y="10" opacity="0.5">Hi</text></svg>')).toBe(1);
  });

  it('applies a grouped <text> alpha once, not also folded into the glyphs', () => {
    expect(alphas('<svg><text x="0" y="10" opacity="0.5">Hi</text></svg>'))
      .toEqual([0.5]);
  });

  it('emits no group and no alpha at opacity 1', () => {
    const svg = '<svg><g opacity="1"><rect width="10" height="10"/></g></svg>';
    expect(formCount(svg)).toBe(0);
    expect(alphas(svg)).toEqual([]);
  });

  it('marks the group as a transparency group', () => {
    const groups = transparencyGroups(
      '<svg><g opacity="0.5"><rect width="10" height="10"/>' +
      '<rect x="5" width="10" height="10"/></g></svg>');
    expect(groups.length).toBe(1);
    const sub = groups[0].get('Subtype');
    expect(isName(sub) && sub.name).toBe('Form');
  });

  it('does not throw on a singular transform', () => {
    expect(() => draw('<svg><g opacity="0.5" transform="scale(0)">' +
      '<rect width="10" height="10"/></g></svg>')).not.toThrow();
  });

  it('nests two groups for nested opacity', () => {
    const svg = '<svg><g opacity="0.5"><g opacity="0.5">' +
      '<rect width="10" height="10"/><rect x="5" width="10" height="10"/>' +
      '</g></g></svg>';
    // formCount sees only the OUTER stream's /Resources; the inner form is
    // registered in the inner emitter's own dictionary, so the outer count is
    // one. The two groups are visible in the allocated stream dicts.
    expect(formCount(svg)).toBe(1);
    expect(transparencyGroups(svg).length).toBe(2);
  });
});

// A 1x1 PNG, so the element has real bytes to embed.
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAf' +
  'FcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('<image> — group opacity only', () => {
  const img = (attrs: string) =>
    `<svg><image width="10" height="10" href="${PX}" ${attrs}/></svg>`;

  it('applies group opacity', () => {
    expect(alphas(img('opacity="0.5"'))).toEqual([0.5]);
  });

  it('ignores fill-opacity, which SVG does not apply to an image', () => {
    expect(alphas(img('fill-opacity="0.5"'))).toEqual([]);
  });

  it('does not multiply the two together', () => {
    expect(alphas(img('opacity="0.5" fill-opacity="0.5"'))).toEqual([0.5]);
  });

  it('needs no transparency group — an image is one paint operation', () => {
    expect(formCount(img('opacity="0.5"'))).toBe(0);
    expect(transparencyGroups(img('opacity="0.5"')).length).toBe(0);
  });

  it('still inherits an ancestor group opacity through the group', () => {
    const svg = `<svg><g opacity="0.5"><image width="10" height="10" ` +
      `href="${PX}"/></g></svg>`;
    expect(alphas(svg)).toEqual([0.5]);
  });
});
