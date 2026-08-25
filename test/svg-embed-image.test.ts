import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { isDict, isRef, isStream, type PdfDict } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A 2x2 RGB PNG: red, green / blue, yellow. */
const PNG_BYTES = buildPngRgbWith(2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 0,
], 0);

/** The same image as a base64 data URI. */
const DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;

/** An SVG payload as a base64 data URI. */
const svgUri = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
/** A 10x10-viewBox payload that paints a full-bleed green square. */
const NESTED = svgUri('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>');

/** Place `src` on a 200x200 page and return the form XObject plus the result. */
function place(src: string, opts: Record<string, unknown> = {}) {
  const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
  const page = doc.Pages[0];
  const skipped = page.AddSVGObject(enc(src), [0, 0, 200, 200], { fit: 'fill', ...opts }).skipped;
  // The form is the single /Fm* entry the placement just registered.
  const res = doc.resolve(page.Dict.get('Resources'));
  if (!isDict(res)) throw new Error('no page resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!isDict(xo)) throw new Error('no page /XObject');
  const formRef = [...xo].find(([k]) => k.startsWith('Fm'))![1];
  const form = doc.resolve(formRef);
  if (!isStream(form)) throw new Error('form is not a stream');
  const formRes = doc.resolve(form.dict.get('Resources')) as PdfDict;
  return {
    doc, skipped, formRes,
    content: new TextDecoder('latin1').decode(form.raw),
    // NB: doc.resolve(undefined) returns null, so an absent /XObject reads as
    // null rather than undefined.
    xobjects: doc.resolve(formRes.get('XObject')),
  };
}

const IMG = (attrs: string) =>
  `<svg viewBox="0 0 200 200"><image ${attrs} href="${DATA_URI}"/></svg>`;

describe('AddSVGObject — <image>', () => {
  it('embeds a data: URI as an Image XObject and draws it', () => {
    const { skipped, content, xobjects } = place(IMG('x="10" y="20" width="40" height="40"'));
    expect(skipped).toEqual([]);
    expect(isDict(xobjects)).toBe(true);
    const entries = [...(xobjects as PdfDict)];
    expect(entries).toHaveLength(1);
    const [key, val] = entries[0];
    expect(key).toBe('Im0');
    expect(isRef(val)).toBe(true);
    expect(content).toContain('/Im0 Do');
    // A 2x2 image in a 40x40 box: scale 40, and the y-down flip puts the unit
    // square's origin at the box bottom (20 + 40).
    expect(content).toContain('40 0 0 -40 10 60 cm');
  });

  it('names image in skipped for an href it cannot embed, drawing nothing', () => {
    for (const href of ['photo.png', 'https://example.com/a.png', '']) {
      const { skipped, content, xobjects } =
        place(`<svg viewBox="0 0 200 200"><image width="10" height="10" href="${href}"/></svg>`);
      expect(skipped).toEqual(['image']);
      expect(content).not.toContain(' Do');
      expect(xobjects).toBeNull();
    }
  });

  it('embeds one XObject for two elements sharing an href', () => {
    const { content, xobjects } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="10" height="10" href="${DATA_URI}"/>` +
      `<image x="20" width="10" height="10" href="${DATA_URI}"/></svg>`);
    const entries = [...(xobjects as PdfDict)];
    expect(entries).toHaveLength(1);
    // Both draws must name the SAME key: a per-element key that happened to
    // collide would satisfy a length check alone.
    expect(content.match(/\/Im0 Do/g)).toHaveLength(2);
  });

  it('clips to the element rect under slice', () => {
    const { content } = place(
      IMG('width="40" height="20" preserveAspectRatio="xMidYMid slice"'));
    expect(content).toContain('0 0 40 20 re');
    expect(content).toContain('W n');
  });

  it('applies group opacity through /ExtGState', () => {
    const { content } = place(
      `<svg viewBox="0 0 200 200"><g opacity="0.5">` +
      `<image width="10" height="10" href="${DATA_URI}"/></g></svg>`);
    expect(content).toMatch(/\/GS\d+ gs/);
  });

  it('draws nothing and allocates nothing for an image inside defs', () => {
    const { content, xobjects } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<image width="10" height="10" href="${DATA_URI}"/></defs></svg>`);
    expect(content).not.toContain(' Do');
    expect(xobjects).toBeNull();
  });

  it('registers an image used only in a pattern tile in the TILE resources', () => {
    // A tile's content stream cannot see the form's /Resources, so the image
    // must land in the tile's own dictionary and NOT in the form's.
    const { doc, formRes, xobjects } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse">` +
      `<image width="20" height="20" href="${DATA_URI}"/></pattern></defs>` +
      `<rect width="200" height="200" fill="url(#p)"/></svg>`);
    expect(xobjects).toBeNull();                    // not in the form
    const patterns = doc.resolve(formRes.get('Pattern'));
    if (!isDict(patterns)) throw new Error('no /Pattern in the form resources');
    const tile = doc.resolve([...patterns][0][1]);
    if (!isStream(tile)) throw new Error('a tiling pattern must be a stream');
    const tileRes = doc.resolve(tile.dict.get('Resources'));
    if (!isDict(tileRes)) throw new Error('no tile /Resources');
    const tileXo = doc.resolve(tileRes.get('XObject'));
    if (!isDict(tileXo)) throw new Error('no tile /XObject');
    expect([...tileXo].map(([k]) => k)).toEqual(['Im0']);
    expect(new TextDecoder('latin1').decode(tile.raw)).toContain('/Im0 Do');
  });

  it('survives a Save/Open round trip', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
    doc.Pages[0].AddSVGObject(enc(IMG('width="50" height="50"')), [0, 0, 200, 200]);
    const rt = Document.Open(doc.Save());
    expect(rt.Pages.length).toBe(1);
  });
});

describe('AddSVGObject — resolveImage', () => {
  const REL = `<svg viewBox="0 0 200 200"><image width="40" height="40" href="photo.png"/></svg>`;

  it('embeds bytes the resolver supplies for a relative href', () => {
    const { skipped, content, xobjects } = place(REL, {
      resolveImage: (h: string) => (h === 'photo.png' ? PNG_BYTES : undefined),
    });
    expect(skipped).toEqual([]);
    expect([...(xobjects as PdfDict)].map(([k]) => k)).toEqual(['Im0']);
    expect(content).toContain('/Im0 Do');
  });

  it('still reports image when the resolver declines', () => {
    const { skipped, content } = place(REL, { resolveImage: () => undefined });
    expect(skipped).toEqual(['image']);
    expect(content).not.toContain(' Do');
  });

  it('reaches an <image> inside a pattern tile', () => {
    // A tile forks a child Emitter. A resolver not carried across the fork works
    // at the top level and silently vanishes here — and in markers, masks and
    // filter subtrees, which fork the same way.
    const { doc, formRes } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse">` +
      `<image width="20" height="20" href="tile.png"/></pattern></defs>` +
      `<rect width="200" height="200" fill="url(#p)"/></svg>`,
      { resolveImage: () => PNG_BYTES });
    const patterns = doc.resolve(formRes.get('Pattern'));
    if (!isDict(patterns)) throw new Error('no /Pattern in the form resources');
    const tile = doc.resolve([...patterns][0][1]);
    if (!isStream(tile)) throw new Error('a tiling pattern must be a stream');
    expect(new TextDecoder('latin1').decode(tile.raw)).toContain('/Im0 Do');
  });

  it('calls the resolver once for two elements sharing an href', () => {
    let calls = 0;
    const { content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="10" height="10" href="a.png"/>` +
      `<image x="20" width="10" height="10" href="a.png"/></svg>`,
      { resolveImage: () => { calls++; return PNG_BYTES; } });
    expect(calls).toBe(1);
    expect(content.match(/\/Im0 Do/g)).toHaveLength(2);
  });

  it('rejects a non-function resolveImage', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
    expect(() => doc.Pages[0].AddSVGObject(
      enc('<svg viewBox="0 0 200 200"/>'), [0, 0, 200, 200],
      { resolveImage: 'nope' as never })).toThrow(TypeError);
  });
});

describe('AddSVGObject — nested SVG payload', () => {
  it('draws a nested payload as a form, fitted by its own viewBox', () => {
    const { skipped, content, formRes } = place(
      `<svg viewBox="0 0 200 200"><image x="10" y="20" width="80" height="40" href="${NESTED}"/></svg>`);
    expect(skipped).toEqual([]);
    // viewBoxFitDown(10x10 -> 80x40, default xMidYMid meet): scale 4, content
    // 40x40 centred in the 80x40 box (tx 20, ty 0), then translated by x/y.
    expect(content).toContain('4 0 0 4 30 20 cm');
    expect(content).toMatch(/\/Fm\d+ Do/);
    expect(formRes.get('XObject')).toBeDefined();
  });

  it('draws a nested payload the resolver supplies', () => {
    const bytes = new TextEncoder().encode(
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>');
    const { skipped, content } = place(
      `<svg viewBox="0 0 200 200"><image width="40" height="40" href="logo.svg"/></svg>`,
      { resolveImage: () => bytes });
    expect(skipped).toEqual([]);
    expect(content).toMatch(/\/Fm\d+ Do/);
  });

  it('does not resolve a nested url(#id) against the OUTER document', () => {
    // The one test that proves subdoc() rather than child(). `#g` exists only in
    // the outer document; with a shared `ids` index the nested <use> would find
    // it and silently draw the outer content inside the payload.
    const payload = svgUri(
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/>' +
      '<use href="#g"/></svg>');
    const { skipped } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<g id="g"><rect width="200" height="200" fill="#ff0000"/></g></defs>` +
      `<image width="40" height="40" href="${payload}"/></svg>`);
    expect(skipped).toEqual(['use']);
  });

  it('allocates one form for two elements sharing a payload', () => {
    const { content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="40" height="40" href="${NESTED}"/>` +
      `<image x="50" width="40" height="40" href="${NESTED}"/></svg>`);
    const keys = [...content.matchAll(/\/(Fm\d+) Do/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('reports image past the nesting cap', () => {
    let src = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>';
    for (let i = 0; i < 5; i++)
      src = `<svg viewBox="0 0 10 10"><image width="10" height="10" href="${svgUri(src)}"/></svg>`;
    const { skipped } = place(
      `<svg viewBox="0 0 200 200"><image width="40" height="40" href="${svgUri(src)}"/></svg>`);
    expect(skipped).toEqual(['image']);
  });

  it('reports image for a payload whose root is not <svg>', () => {
    const { skipped, content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="40" height="40" href="${svgUri('<html><body/></html>')}"/></svg>`);
    expect(skipped).toEqual(['image']);
    expect(content).not.toContain(' Do');
  });

  it('clips a nested payload to the image rect', () => {
    // slice scales the content past the rect while it still lies inside the
    // payload's viewBox, so the form's /BBox alone does not contain it.
    const payload = svgUri(
      '<svg viewBox="0 0 10 10" preserveAspectRatio="xMidYMid slice">' +
      '<rect width="10" height="10" fill="#00ff00"/></svg>');
    const { content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image x="10" y="20" width="80" height="40" href="${payload}"/></svg>`);
    expect(content).toContain('10 20 80 40 re');
    expect(content).toContain('W n');
  });

  it('reports image for a malformed payload instead of throwing', () => {
    // One bad payload in a 200-element illustration must not abort the whole
    // placement, which is the same rule decodeImage's broad catch encodes.
    const { skipped, content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="40" height="40" href="${svgUri('<svg><rect')}"/></svg>`);
    expect(skipped).toEqual(['image']);
    expect(content).not.toContain(' Do');
  });

  it("surfaces a nested payload's own losses in the outer skipped", () => {
    // `skipped` is shared across the document boundary: an @media rule the CSS
    // engine drops inside the payload is still a loss in the outer result.
    const payload = svgUri(
      '<svg viewBox="0 0 10 10"><style>@media print { rect { fill: red } }</style>' +
      '<rect width="10" height="10" fill="#00ff00"/></svg>');
    const { skipped } = place(
      `<svg viewBox="0 0 200 200"><image width="40" height="40" href="${payload}"/></svg>`);
    expect(skipped).toEqual(['style']);
  });
});
