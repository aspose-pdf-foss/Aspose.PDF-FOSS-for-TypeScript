import { describe, it, expect } from 'vitest';
import { dataUriBytes, decodeImage, decodePayload, imagePlacement, imageSize } from '../src/svgimage.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

/** A 2x2 RGB PNG: red, green / blue, yellow. Four distinct hues, none of them
 *  white, so the render test can tell the image apart from the page. */
const PNG = () => buildPngRgbWith(2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 0,
], 0);

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const BOM = String.fromCharCode(0xfeff);
const SVG_BYTES = new TextEncoder().encode('<svg viewBox="0 0 10 10"/>');
const svgUri = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;

describe('dataUriBytes', () => {
  it('decodes a base64 payload', () => {
    const bytes = PNG();
    expect(dataUriBytes(`data:image/png;base64,${b64(bytes)}`)).toEqual(bytes);
  });

  it('ignores whitespace inside a base64 payload', () => {
    // Pretty-printers wrap long attribute values, so the newlines are real.
    const bytes = PNG();
    const wrapped = b64(bytes).replace(/(.{8})/g, '$1\n  ');
    expect(dataUriBytes(`data:image/png;base64,${wrapped}`)).toEqual(bytes);
  });

  it('decodes a percent-encoded payload byte-wise, not as UTF-8', () => {
    // %89 is not valid UTF-8; decodeURIComponent would throw on it.
    expect(dataUriBytes('data:image/png,%89PNG%0D%0A'))
      .toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  });

  it('accepts a URI with no media type', () => {
    expect(dataUriBytes('data:,AB')).toEqual(new Uint8Array([0x41, 0x42]));
  });

  it('rejects a non-data scheme', () => {
    expect(dataUriBytes('photo.png')).toBeUndefined();
    expect(dataUriBytes('https://example.com/a.png')).toBeUndefined();
  });

  it('rejects a data URI with no comma', () => {
    expect(dataUriBytes('data:image/png;base64')).toBeUndefined();
  });

  it('rejects a malformed percent escape', () => {
    expect(dataUriBytes('data:,%zz')).toBeUndefined();
  });
});

describe('decodeImage', () => {
  it('builds an Image XObject from a PNG data URI', () => {
    const built = decodeImage(`data:image/png;base64,${b64(PNG())}`)!;
    expect(built).toBeDefined();
    expect(imageSize(built)).toEqual({ w: 2, h: 2 });
  });

  it('sniffs the bytes and ignores a contradicting media type', () => {
    // Data URIs in the wild carry wrong types; the bytes win.
    const built = decodeImage(`data:image/gif;base64,${b64(PNG())}`)!;
    expect(imageSize(built)).toEqual({ w: 2, h: 2 });
  });

  it('returns undefined for an SVG payload rather than recursing', () => {
    const svg = b64(new TextEncoder().encode('<svg><rect width="1" height="1"/></svg>'));
    expect(decodeImage(`data:image/svg+xml;base64,${svg}`)).toBeUndefined();
  });

  it('returns undefined for corrupt bytes instead of throwing', () => {
    // buildImageXObject throws UnsupportedFeatureError here; one bad icon must
    // not abort a whole placement.
    expect(decodeImage('data:image/png;base64,AAAAAAAA')).toBeUndefined();
    expect(decodeImage('data:,')).toBeUndefined();
  });

  it('returns undefined for a truncated PNG that parses no further', () => {
    const bytes = PNG().subarray(0, 20);
    expect(decodeImage(`data:image/png;base64,${b64(bytes)}`)).toBeUndefined();
  });
});

describe('imagePlacement', () => {
  const attrs = (o: Record<string, string>) => new Map(Object.entries(o));

  it('flips the unit square so the image lands upright in y-down space', () => {
    // A 10x10 box at (2, 3): the unit square's bottom edge goes to y = 13 and
    // its top edge to y = 3, which is the second flip cancelling the placement
    // one. Emit +h and the image renders mirrored.
    const p = imagePlacement(attrs({ x: '2', y: '3', width: '10', height: '10' }), 20, 20)!;
    expect(p.cm).toEqual([10, 0, 0, -10, 2, 13]);
    expect(p.box).toEqual({ x: 2, y: 3, w: 10, h: 10 });
    expect(p.clip).toBeUndefined();
  });

  it('defaults x and y to 0', () => {
    const p = imagePlacement(attrs({ width: '4', height: '4' }), 4, 4)!;
    expect(p.cm).toEqual([4, 0, 0, -4, 0, 4]);
  });

  it('letterboxes under the default meet fit', () => {
    // A 2:1 image in a 1:1 box: scaled to 10 wide, 5 tall, centred vertically.
    const p = imagePlacement(attrs({ width: '10', height: '10' }), 20, 10)!;
    expect(p.cm).toEqual([10, 0, 0, -5, 0, 7.5]);
    expect(p.box).toEqual({ x: 0, y: 2.5, w: 10, h: 5 });
    expect(p.clip).toBeUndefined();
  });

  it('stretches under preserveAspectRatio none', () => {
    const p = imagePlacement(
      attrs({ width: '10', height: '10', preserveAspectRatio: 'none' }), 20, 10)!;
    expect(p.cm).toEqual([10, 0, 0, -10, 0, 10]);
  });

  it('clips to the element rect under slice', () => {
    // slice covers the box, so the fitted image overflows it and must be clipped.
    const p = imagePlacement(
      attrs({ x: '1', y: '1', width: '10', height: '10',
              preserveAspectRatio: 'xMidYMid slice' }), 20, 10)!;
    expect(p.box.w).toBeCloseTo(20);
    expect(p.box.h).toBeCloseTo(10);
    expect(p.clip).toEqual([1, 1, 10, 10]);
  });

  it('clips under a slice that aligns to the min edge, where both offsets are 0', () => {
    // The overflow test must be a size comparison: xMinYMin leaves tx = ty = 0
    // while the image still spills off the right edge.
    const p = imagePlacement(
      attrs({ width: '10', height: '10', preserveAspectRatio: 'xMinYMin slice' }), 20, 10)!;
    expect(p.clip).toEqual([0, 0, 10, 10]);
  });

  it('uses the intrinsic pixel size when both dimensions are absent', () => {
    const p = imagePlacement(attrs({ x: '5', y: '5' }), 8, 4)!;
    expect(p.cm).toEqual([8, 0, 0, -4, 5, 9]);
  });

  it('derives the missing dimension from the intrinsic aspect ratio', () => {
    expect(imagePlacement(attrs({ width: '40' }), 20, 10)!.cm).toEqual([40, 0, 0, -20, 0, 20]);
    expect(imagePlacement(attrs({ height: '20' }), 20, 10)!.cm).toEqual([40, 0, 0, -20, 0, 20]);
  });

  it('draws nothing for a zero or negative dimension', () => {
    expect(imagePlacement(attrs({ width: '0', height: '10' }), 4, 4)).toBeNull();
    expect(imagePlacement(attrs({ width: '10', height: '-1' }), 4, 4)).toBeNull();
  });

  it('draws nothing for a degenerate intrinsic size', () => {
    expect(imagePlacement(attrs({ width: '10', height: '10' }), 0, 0)).toBeNull();
  });

  it('reads a percentage as its bare number, as every length in this stack does', () => {
    const p = imagePlacement(attrs({ width: '50%', height: '50%' }), 50, 50)!;
    expect(p.cm).toEqual([50, 0, 0, -50, 0, 50]);
  });
});

describe('decodeImage — caller-supplied resolver', () => {
  it('builds from the resolver when the href is not a data: URI', () => {
    const bytes = PNG();
    const built = decodeImage('photo.png', () => bytes);
    expect(built).toBeDefined();
    expect(imageSize(built!)).toEqual({ w: 2, h: 2 });
  });

  it('does not call the resolver when the data: URI decodes', () => {
    let calls = 0;
    const built = decodeImage(
      `data:image/png;base64,${b64(PNG())}`, () => { calls++; return undefined; });
    expect(built).toBeDefined();
    expect(calls).toBe(0);
  });

  it('calls the resolver for a data: payload whose bytes are not PNG or JPEG', () => {
    // How an image/svg+xml payload arrives: it decodes to bytes, but the sniff
    // rejects them. The caller gets a shot rather than needing a second option.
    const seen: string[] = [];
    const href = 'data:image/svg+xml,%3Csvg%2F%3E';
    const built = decodeImage(href, (h) => { seen.push(h); return PNG(); });
    expect(built).toBeDefined();
    expect(seen).toEqual([href]);
  });

  it('propagates a throw from the resolver', () => {
    // A throw here is a CALLER bug. Swallowing it would surface as a silently
    // missing image plus a vague skipped: ['image'].
    expect(() => decodeImage('photo.png', () => { throw new Error('lookup failed'); }))
      .toThrow('lookup failed');
  });

  it('returns undefined when the resolver supplies bytes that are not an image', () => {
    expect(decodeImage('photo.png', () => new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('returns undefined when the resolver declines', () => {
    expect(decodeImage('photo.png', () => undefined)).toBeUndefined();
  });
});

describe('decodePayload', () => {
  it('classifies PNG bytes as a raster', () => {
    expect(decodePayload(`data:image/png;base64,${b64(PNG())}`)?.kind).toBe('raster');
  });

  it('classifies an image/svg+xml payload as svg', () => {
    const p = decodePayload(svgUri('<svg viewBox="0 0 10 10"/>'));
    expect(p?.kind).toBe('svg');
    expect(new TextDecoder().decode((p as { bytes: Uint8Array }).bytes)).toContain('<svg');
  });

  it('sniffs past a BOM, whitespace, an XML declaration and a comment', () => {
    for (const s of [
      BOM + '<svg viewBox="0 0 1 1"/>',
      '\n  <svg viewBox="0 0 1 1"/>',
      '<?xml version="1.0"?><svg viewBox="0 0 1 1"/>',
      '<!-- c --><svg viewBox="0 0 1 1"/>',
    ]) expect(decodePayload(svgUri(s))?.kind).toBe('svg');
  });

  it('returns undefined for bytes that are neither XML nor a raster', () => {
    expect(decodePayload('data:application/octet-stream;base64,AQID')).toBeUndefined();
  });

  it('takes svg bytes from the resolver, not only a data: URI', () => {
    expect(decodePayload('logo.svg', () => SVG_BYTES)?.kind).toBe('svg');
  });

  it('falls back to the resolver when a data: payload is junk', () => {
    // Preserves 1gg0.21's chain: a data: URI that decodes to nothing usable must
    // not shortcut the resolver.
    expect(decodePayload('data:application/octet-stream;base64,AQID', () => PNG())?.kind)
      .toBe('raster');
  });
});
