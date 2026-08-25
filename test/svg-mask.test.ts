import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { resolveMask } from '../src/svgmask.js';
import { IDENTITY } from '../src/text.js';
import { drawSvg } from '../src/svgdraw.js';
import { isDict, isName, type PdfDict, type PdfObject } from '../src/types.js';

const xml = (s: string) => new TextEncoder().encode(s);

function maskOf(src: string, id = 'm'): XmlNode {
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
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('resolveMask — region', () => {
  it('defaults to a 10% bleed around the box under objectBoundingBox', () => {
    const s = resolveMask(maskOf('<svg><mask id="m"/></svg>'), BOX, VP)!;
    near(s.region.x, 10 - 4);      // x - 0.1*w
    near(s.region.y, 20 - 8);      // y - 0.1*h
    near(s.region.w, 40 * 1.2);
    near(s.region.h, 80 * 1.2);
  });

  it('takes explicit fractions under objectBoundingBox', () => {
    const s = resolveMask(
      maskOf('<svg><mask id="m" x="0" y="0" width="0.5" height="0.25"/></svg>'), BOX, VP)!;
    near(s.region.x, 10); near(s.region.y, 20);
    near(s.region.w, 20); near(s.region.h, 20);
  });

  it('takes literal user units under userSpaceOnUse', () => {
    const s = resolveMask(
      maskOf('<svg><mask id="m" maskUnits="userSpaceOnUse" x="5" y="6" width="7" height="8"/></svg>'),
      BOX, VP)!;
    near(s.region.x, 5); near(s.region.y, 6);
    near(s.region.w, 7); near(s.region.h, 8);
  });

  it('resolves the DEFAULT percentages against the viewport under userSpaceOnUse', () => {
    // The defaults are the strings -10%/-10%/120%/120%, and under
    // userSpaceOnUse a percentage is a percentage of the viewport, NOT the box.
    const s = resolveMask(
      maskOf('<svg><mask id="m" maskUnits="userSpaceOnUse"/></svg>'), BOX, VP)!;
    near(s.region.x, -20); near(s.region.y, -10);
    near(s.region.w, 240); near(s.region.h, 120);
  });

  it('returns null for a zero-area region', () => {
    expect(resolveMask(
      maskOf('<svg><mask id="m" width="0"/></svg>'), BOX, VP)).toBeNull();
  });

  it('returns null for objectBoundingBox units on a box with no area', () => {
    expect(resolveMask(maskOf('<svg><mask id="m"/></svg>'),
      { x: 0, y: 0, w: 0, h: 10 }, VP)).toBeNull();
    expect(resolveMask(maskOf('<svg><mask id="m"/></svg>'), null, VP)).toBeNull();
  });

  it('needs no box under userSpaceOnUse', () => {
    const s = resolveMask(
      maskOf('<svg><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="9" height="9"/></svg>'),
      null, VP)!;
    near(s.region.w, 9);
  });
});

describe('resolveMask — content units', () => {
  it('defaults to userSpaceOnUse, an identity content matrix', () => {
    const s = resolveMask(maskOf('<svg><mask id="m"/></svg>'), BOX, VP)!;
    expect(s.content).toEqual([...IDENTITY]);
  });

  it('maps the unit square onto the box under objectBoundingBox', () => {
    const s = resolveMask(
      maskOf('<svg><mask id="m" maskContentUnits="objectBoundingBox"/></svg>'), BOX, VP)!;
    // Unlike patternContentUnits, this carries the translate: nothing else has
    // placed the content.
    expect(s.content).toEqual([40, 0, 0, 80, 10, 20]);
  });

  it('falls back to identity when objectBoundingBox content meets no box', () => {
    const s = resolveMask(
      maskOf('<svg><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="9" height="9" ' +
             'maskContentUnits="objectBoundingBox"/></svg>'), null, VP)!;
    expect(s.content).toEqual([...IDENTITY]);
  });
});

describe('resolveMask — luminosity vs alpha', () => {
  it('defaults to Luminosity', () => {
    expect(resolveMask(maskOf('<svg><mask id="m"/></svg>'), BOX, VP)!.type).toBe('Luminosity');
  });

  it('honours mask-type="alpha"', () => {
    expect(resolveMask(maskOf('<svg><mask id="m" mask-type="alpha"/></svg>'), BOX, VP)!.type)
      .toBe('Alpha');
  });

  it('honours mask-type in an inline style, which outranks the attribute', () => {
    expect(resolveMask(
      maskOf('<svg><mask id="m" mask-type="luminance" style="mask-type:alpha"/></svg>'),
      BOX, VP)!.type).toBe('Alpha');
  });

  it('honours the mask-mode spelling', () => {
    expect(resolveMask(maskOf('<svg><mask id="m" mask-mode="alpha"/></svg>'), BOX, VP)!.type)
      .toBe('Alpha');
  });

  it('treats an unknown value as luminance', () => {
    expect(resolveMask(maskOf('<svg><mask id="m" mask-type="sideways"/></svg>'), BOX, VP)!.type)
      .toBe('Luminosity');
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

const sub = (res: PdfDict, k: string): PdfDict => {
  const v = res.get(k);
  if (!isDict(v)) throw new Error(`no /${k}`);
  return v;
};

describe('svgdraw — ExtGState soft-mask subtype', () => {
  it('still writes Luminosity for a gradient alpha ramp', () => {
    // A varying stop-opacity is the pre-existing /SMask caller; it must not
    // change spelling now that the subtype is a parameter.
    const { resources } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<linearGradient id="g"><stop offset="0" stop-color="#f00" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#f00" stop-opacity="1"/></linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/></svg>');
    const gs = sub(sub(resources, 'ExtGState'), 'GS0');
    const smask = gs.get('SMask');
    if (!isDict(smask)) throw new Error('no /SMask');
    const s = smask.get('S');
    expect(isName(s) && s.name).toBe('Luminosity');
  });
});

const MASKED =
  '<svg viewBox="0 0 100 100"><defs>' +
  '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="50" height="100">' +
  '<rect width="50" height="100" fill="#fff"/></mask></defs>' +
  '<rect width="100" height="100" fill="#f00" mask="url(#m)"/></svg>';

describe('svgdraw — mask wiring', () => {
  it('reports nothing for a resolvable mask', () => {
    expect(draw(MASKED).skipped).toEqual([]);
  });

  it('paints the element through a group with a soft mask', () => {
    const { content, resources } = draw(MASKED);
    expect(content).toContain(' gs');
    expect(content).toMatch(/\/Fm\d+ Do/);
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const gs = sub(sub(resources, 'ExtGState'), gsName);
    const smask = gs.get('SMask');
    if (!isDict(smask)) throw new Error('no /SMask');
    expect(isName(smask.get('S')) && (smask.get('S') as { name: string }).name)
      .toBe('Luminosity');
    expect(smask.get('G')).toBeDefined();
  });

  it('does not paint the shape into the outer stream', () => {
    // The fill moved INTO the group. A red `rg` left behind means the element
    // was painted twice — once masked, once not.
    const { content } = draw(MASKED);
    expect(content).not.toContain('1 0 0 rg');
  });

  it('allocates a Luminosity group and the element group as streams', () => {
    const { streams } = draw(MASKED);
    // Two transparency groups: the mask, and the element's own.
    const groups = streams.filter((s) => isDict(s.dict.get('Group')));
    expect(groups.length).toBe(2);
    for (const g of groups) {
      const grp = g.dict.get('Group') as PdfDict;
      expect(isName(grp.get('S')) && (grp.get('S') as { name: string }).name)
        .toBe('Transparency');
    }
  });

  it('gives the mask group DeviceGray and the element group no /CS', () => {
    const { streams } = draw(MASKED);
    const cs = streams
      .filter((s) => isDict(s.dict.get('Group')))
      .map((s) => {
        const g = (s.dict.get('Group') as PdfDict).get('CS');
        return isName(g) ? g.name : undefined;
      });
    expect(cs).toContain('DeviceGray');   // the luminosity mask
    expect(cs).toContain(undefined);      // the element group inherits
  });

  it('uses the mask region as the group /BBox', () => {
    const { streams } = draw(MASKED);
    const boxes = streams
      .filter((s) => isDict(s.dict.get('Group')))
      .map((s) => s.dict.get('BBox'));
    // region = 0,0,50,100 in the y-down frame svgdraw emits in.
    expect(boxes).toContainEqual([0, 0, 50, 100]);
  });

  it('writes /S /Alpha for mask-type="alpha"', () => {
    const { content, resources } = draw(MASKED.replace('<mask id="m"', '<mask id="m" mask-type="alpha"'));
    const gsName = /\/(GS\d+) gs/.exec(content)![1];
    const smask = sub(sub(resources, 'ExtGState'), gsName).get('SMask') as PdfDict;
    expect(isName(smask.get('S')) && (smask.get('S') as { name: string }).name).toBe('Alpha');
  });

  it('masks a group, using the union of its children as the box', () => {
    const { skipped, content } = draw(
      '<svg viewBox="0 0 100 100"><defs><mask id="m"><rect width="100" height="100" fill="#fff"/></mask></defs>' +
      '<g mask="url(#m)"><rect width="20" height="20" fill="#f00"/>' +
      '<rect x="80" y="80" width="20" height="20" fill="#00f"/></g></svg>');
    expect(skipped).toEqual([]);
    expect(content).toMatch(/\/Fm\d+ Do/);
  });

  it('draws unmasked and reports url() when the target is missing', () => {
    const { skipped, content } = draw(
      '<svg viewBox="0 0 100 100"><rect width="10" height="10" fill="#f00" mask="url(#gone)"/></svg>');
    expect(skipped).toEqual(['url()']);
    expect(content).toContain('1 0 0 rg');    // still painted
    expect(content).not.toContain(' gs');
  });

  it('draws unmasked and reports when the mask region has no area', () => {
    const { skipped, content } = draw(
      '<svg viewBox="0 0 100 100"><defs><mask id="m" width="0"><rect width="9" height="9" fill="#fff"/></mask></defs>' +
      '<rect width="10" height="10" fill="#f00" mask="url(#m)"/></svg>');
    expect(skipped).toEqual(['mask']);
    expect(content).toContain('1 0 0 rg');
  });

  it('never paints a <mask> where it sits', () => {
    const { content } = draw(
      '<svg viewBox="0 0 100 100"><mask id="m"><rect width="99" height="99" fill="#fff"/></mask></svg>');
    expect(content.trim()).toBe('');
    expect(draw('<svg viewBox="0 0 100 100"><mask id="m"><rect width="9" height="9"/></mask></svg>')
      .skipped).toEqual([]);
  });

  it('breaks a mask reference cycle instead of recursing forever', () => {
    const { skipped } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<mask id="m"><rect width="50" height="50" fill="#fff" mask="url(#m)"/></mask></defs>' +
      '<rect width="100" height="100" fill="#f00" mask="url(#m)"/></svg>');
    expect(skipped).toEqual(['mask']);       // returns, does not hang
  });

  it('reuses one group for two elements sharing a mask', () => {
    const { streams } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="50" height="100">' +
      '<rect width="50" height="100" fill="#fff"/></mask></defs>' +
      '<rect width="100" height="100" fill="#f00" mask="url(#m)"/>' +
      '<rect width="100" height="100" fill="#00f" mask="url(#m)"/></svg>');
    // Two element groups, but ONE mask group: e.masks caches by canonical dict.
    const grays = streams.filter((s) => {
      const g = s.dict.get('Group');
      if (!isDict(g)) return false;
      const cs = g.get('CS');
      return isName(cs) && cs.name === 'DeviceGray';
    });
    expect(grays.length).toBe(1);
  });
});
