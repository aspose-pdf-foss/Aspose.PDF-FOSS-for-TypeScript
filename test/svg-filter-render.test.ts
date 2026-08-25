import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { rasterizeFormRgba } from '../src/raster.js';
import { deflateSync } from 'node:zlib';
import { enc } from '../src/serialize.js';
import { isDict, isName, isStream, name, type PdfDict, type PdfObject } from '../src/types.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

/** A Form XObject over BBox [0,0,10,10] painting a red square in its
 *  bottom-left quadrant (PDF y-up). */
function redQuadrant(): { dict: PdfDict; content: string } {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [0, 0, 10, 10]],
    ['Matrix', [1, 0, 0, 1, 0, 0]],
    ['Resources', new Map<string, PdfObject>()],
  ]);
  return { dict, content: '1 0 0 rg\n0 0 5 5 re\nf' };
}

describe('rasterizeFormRgba', () => {
  it('renders a form at the requested pixel size, top-down', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const { dict, content } = redQuadrant();
    const img = rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, 20, 20);
    expect(img.w).toBe(20);
    expect(img.h).toBe(20);
    // BBox y=0..5 is the BOTTOM half in PDF space, so it lands in the BOTTOM
    // half of the raster: row 0 is the top.
    const at = (x: number, y: number) => img.data.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 4);
    expect([...at(5, 15)]).toEqual([255, 0, 0, 255]);   // bottom-left: painted
    expect(at(5, 5)[3]).toBe(0);                        // top-left: unpainted
    expect(at(15, 15)[3]).toBe(0);                      // bottom-right: unpainted
  });

  it('leaves unpainted area transparent rather than white', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const { dict, content } = redQuadrant();
    const img = rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, 4, 4);
    expect(img.data[3]).toBe(0);
  });

  it('honours a BBox that does not start at the origin', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['FormType', 1],
      ['BBox', [100, 100, 110, 110]], ['Matrix', [1, 0, 0, 1, 0, 0]],
      ['Resources', new Map<string, PdfObject>()],
    ]);
    // Fill the whole BBox: every pixel must be red, which is only true if the
    // BBox origin was subtracted.
    const img = rasterizeFormRgba(
      doc, { kind: 'stream', dict, raw: enc('1 0 0 rg\n100 100 10 10 re\nf') }, 8, 8);
    expect([...img.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...img.data.slice(-4)]).toEqual([255, 0, 0, 255]);
  });

  it('does not add the scratch page to the document', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 20, 20], content: '' }));
    const before = doc.Pages.length;
    const { dict, content } = redQuadrant();
    rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, 4, 4);
    expect(doc.Pages.length).toBe(before);
  });
});

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point. */
function render(src: string, opts: Record<string, unknown> = {}) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill', ...opts });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), result: r, doc: rt };
}

const isRed = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return r > 200 && g < 80 && b < 80;
};
const isWhite = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return r > 240 && g > 240 && b > 240;
};

/** Every Image XObject reachable from the page, as [width, hasSMask] pairs. */
function images(d: Document): Array<[number, boolean]> {
  const out: Array<[number, boolean]> = [];
  const seen = new Set<PdfObject>();
  const scan = (res: PdfObject | undefined): void => {
    if (!isDict(res) || seen.has(res)) return;
    seen.add(res);
    const xo = d.resolve(res.get('XObject'));
    if (!isDict(xo)) return;
    for (const v of xo.values()) {
      const s = d.resolve(v);
      if (!isStream(s)) continue;
      const st = s.dict.get('Subtype');
      if (isName(st) && st.name === 'Image') {
        const w = s.dict.get('Width');
        out.push([typeof w === 'number' ? w : 0, s.dict.has('SMask')]);
      } else if (isName(st) && st.name === 'Form') {
        scan(d.resolve(s.dict.get('Resources')));
      }
    }
  };
  scan(d.Pages[0].Resources);
  return out;
}

/** A red square shifted 50 user units right and down by an feOffset. */
const SHIFT =
  '<svg viewBox="0 0 200 200"><defs>' +
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
  '<feOffset dx="50" dy="50"/></filter></defs>' +
  '<rect x="0" y="0" width="50" height="50" fill="#ff0000" filter="url(#f)"/></svg>';

/** SHIFT, padded with a no-op second primitive so it does NOT take a vector
 *  fast path (1gg0.10.5). Two primitives is enough — `classify` matches only a
 *  lone one — and an feOffset of (0, 0) is an exact identity: offsetKernel
 *  rounds its delta to whole pixels, and 0 rounds to 0. These tests are about
 *  the raster path, so they have to keep taking it. */
const SHIFT_RASTER = SHIFT.replace(
  '<feOffset dx="50" dy="50"/>',
  '<feOffset dx="50" dy="50"/><feOffset dx="0" dy="0"/>');

describe('AddSVGObject — filters through Save/Open/ToImage', () => {
  it('draws the filtered result, not the source', () => {
    const { png, result } = render(SHIFT_RASTER);
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    expect(isRed(png, 75, 75)).toBe(true);      // where the offset put it
    expect(isWhite(png, 25, 25)).toBe(true);    // where the source was
  });

  it('emits the result as an image with an /SMask, not as vector ink', () => {
    const { doc } = render(SHIFT_RASTER);
    expect(images(doc).some(([, hasSMask]) => hasSMask)).toBe(true);
  });

  it('scales the raster with filterScale', () => {
    const widest = (d: Document): number =>
      images(d).reduce((m, [w]) => Math.max(m, w), 0);
    const small = render(SHIFT_RASTER, { filterScale: 1 });
    const big = render(SHIFT_RASTER, { filterScale: 4 });
    expect(widest(big.doc)).toBeGreaterThan(widest(small.doc) * 3);
  });

  it('rejects a bad filterScale before allocating anything', () => {
    const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
    const before = p.Document.Save().length;
    expect(() => p.AddSVGObject(svg(SHIFT), [0, 0, 200, 200], { filterScale: 0 }))
      .toThrow(TypeError);
    expect(() => p.AddSVGObject(svg(SHIFT), [0, 0, 200, 200], { filterScale: 99 }))
      .toThrow(TypeError);
    expect(p.Document.Save().length).toBe(before);
  });

  it('draws unfiltered and reports an unsupported primitive', () => {
    const { png, result } = render(
      SHIFT.replace('<feOffset dx="50" dy="50"/>', '<feNonesuch/>'));
    // A made-up primitive: SVG 1.1's real set is now fully supported, so a
    // real name here would pass vacuously.
    expect(result.skipped).toEqual(['feNonesuch']);
    expect(result.rasterized).toEqual([]);
    expect(isRed(png, 25, 25)).toBe(true);      // the source, unfiltered
  });

  it('draws unfiltered and reports an unresolvable filter reference', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200">' +
      '<rect width="50" height="50" fill="#ff0000" filter="url(#nope)"/></svg>');
    expect(result.skipped).toEqual(['url()']);
    expect(isRed(png, 25, 25)).toBe(true);
  });

  it('renders nothing, and reports nothing, for a zero-area filter region', () => {
    const { png, result } = render(SHIFT.replace('width="200"', 'width="0"'));
    expect(result.skipped).toEqual([]);
    expect(isWhite(png, 25, 25)).toBe(true);
    expect(isWhite(png, 75, 75)).toBe(true);
  });

  it('applies the SAME filter independently to an ancestor and a descendant', () => {
    // Legal SVG: each element applies the filter on its own. The offsets
    // compose -- the inner one shifts the rect, the outer one shifts the
    // group's already-filtered result -- so the ink lands at 20+30+30 = 80..120
    // and NOT at 50..90, which is where it sits if the descendant is refused.
    // Padded to keep both filters on the RASTER path.
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feOffset dx="30" dy="0"/><feOffset dx="0" dy="0"/></filter></defs>' +
      '<g filter="url(#f)"><rect x="20" y="20" width="40" height="40" fill="#ff0000" ' +
      'filter="url(#f)"/></g></svg>');
    expect(result.skipped).toEqual([]);
    expect(isRed(png, 100, 40)).toBe(true);     // both offsets applied
    expect(isWhite(png, 70, 40)).toBe(true);    // only the outer one would land here
  });

  it('terminates on an feImage cycle, and reports it', () => {
    // The one path by which a filter can re-enter arbitrary document content,
    // and so the only unbounded recursion: filter f draws element x, and x
    // carries filter f. Broken by the `active` element-id set that <use>
    // already uses -- NOT by anything filter-specific.
    const { result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="#x"/></filter></defs>' +
      '<rect id="x" x="20" y="20" width="40" height="40" fill="#ff0000" ' +
      'filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual(['filter']);
  });

  it('applies a clip-path to the FILTERED result, not to the source', () => {
    // SVG's order is filter -> clip -> mask -> opacity. A clip covering only
    // the shifted half proves the clip ran after the offset.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      // Padded so it keeps proving the ordering through the RASTER path; the
      // vector fast path gets its own coverage in svg-filter-fast.test.ts.
      '<feOffset dx="50" dy="50"/><feOffset dx="0" dy="0"/></filter>' +
      '<clipPath id="c"><rect x="50" y="50" width="150" height="150"/></clipPath>' +
      '</defs><rect width="50" height="50" fill="#ff0000" ' +
      'filter="url(#f)" clip-path="url(#c)"/></svg>');
    expect(isRed(png, 75, 75)).toBe(true);
  });
});

describe('AddSVGObject — a realistic chain', () => {
  it('renders a drop shadow: soft dark ink below-right of the shape', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feGaussianBlur in="SourceAlpha" stdDeviation="4"/>' +
      '<feOffset dx="20" dy="20" result="s"/>' +
      '<feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge>' +
      '</filter></defs>' +
      '<rect x="20" y="20" width="60" height="60" fill="#ff0000" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    expect(isRed(png, 50, 50)).toBe(true);            // the shape itself
    const [r, g, b] = png.at(100, 100);               // inside the shadow
    expect(r).toBeLessThan(240);
    expect(Math.abs(r - g)).toBeLessThan(20);         // grey, not red
    expect(Math.abs(g - b)).toBeLessThan(20);
    expect(isWhite(png, 180, 180)).toBe(true);        // clear of both
  });
});

/** A 2x2 PNG as a data: URI, built here so the test carries no fixture file.
 *
 *  Deliberately vertically ASYMMETRIC — red top row, blue bottom row. A
 *  uniformly red image cannot detect a dropped y-flip, which is exactly the bug
 *  that bit the filter seam once already. */
const RED_PNG_URI = (() => {
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const t = new TextEncoder().encode(type);
    const body = new Uint8Array(t.length + data.length);
    body.set(t); body.set(data, t.length);
    const out = new Uint8Array(4 + body.length + 4);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(body, 4);
    dv.setUint32(4 + body.length, crc(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, 2); idv.setUint32(4, 2);
  ihdr[8] = 8; ihdr[9] = 2;                      // 8-bit, truecolour
  // Two rows, each: filter byte 0 then two RGB triples.
  // Row 0 red, row 1 blue.
  const rawScan = new Uint8Array([
    0, 255, 0, 0, 255, 0, 0,
    0, 0, 0, 255, 0, 0, 255,
  ]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(rawScan)))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
})();

/** The same red/blue PNG as raw bytes, for a resolver to hand back. */
const RED_PNG_BYTES = new Uint8Array(Buffer.from(RED_PNG_URI.split(',')[1], 'base64'));

describe('AddSVGObject — feImage', () => {
  it('draws a same-document element reference', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<rect id="src" x="0" y="0" width="200" height="200" fill="#ff0000"/>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="#src"/></filter></defs>' +
      '<rect x="0" y="0" width="200" height="200" fill="#0000ff" ' +
      'filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual([]);
    expect(result.rasterized).toEqual(['filter']);
    // The referenced red rect replaced the blue source entirely.
    expect(isRed(png, 100, 100)).toBe(true);
  });

  it('draws a data: URI raster', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      `<feImage href="${RED_PNG_URI}"/></filter></defs>` +
      '<rect width="200" height="200" fill="#00ff00" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual([]);
    // The image's RED row must land on top and its BLUE row underneath: a
    // dropped y-flip swaps them, and a uniform image could not tell.
    expect(isRed(png, 100, 50)).toBe(true);
    const [r, g, b] = png.at(100, 150);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(80);
    expect(g).toBeLessThan(80);
  });

  it('draws unfiltered and reports an feImage whose target is missing', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="#gone"/></filter></defs>' +
      '<rect width="100" height="100" fill="#ff0000" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual(['filter']);
    expect(isRed(png, 50, 50)).toBe(true);      // the source, unfiltered
  });

  it('draws unfiltered and reports an external href', () => {
    const { result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="https://example.com/a.png"/></filter></defs>' +
      '<rect width="100" height="100" fill="#ff0000" filter="url(#f)"/></svg>');
    expect(result.skipped).toEqual(['feImage']);
  });

  it('draws an external href the caller resolves', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="https://example.com/a.png"/></filter></defs>' +
      '<rect width="200" height="200" fill="#00ff00" filter="url(#f)"/></svg>',
      { resolveImage: () => RED_PNG_BYTES });
    expect(result.skipped).toEqual([]);
    // The image's RED row on top, as in the data: URI case: a resolver that
    // reached the wrong code path could still produce ink, but not this ink.
    expect(isRed(png, 100, 50)).toBe(true);
  });

  it('reports filter, not feImage, when the resolver declines an external href', () => {
    // Merely HAVING a resolver moves an external href past filter validation,
    // because only the resolver knows whether it has the bytes and it is not
    // consulted until rasterize time. Declining therefore fails the rasterize,
    // which is the generic path: the filter refuses and the element draws
    // unfiltered. Without a resolver the same href reports 'feImage' instead.
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="https://example.com/a.png"/></filter></defs>' +
      '<rect width="100" height="100" fill="#ff0000" filter="url(#f)"/></svg>',
      { resolveImage: () => undefined });
    expect(result.skipped).toEqual(['filter']);
    expect(isRed(png, 50, 50)).toBe(true);      // the source, unfiltered
  });
});
